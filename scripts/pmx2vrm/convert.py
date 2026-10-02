"""PMX（MMD）→ VRM 1.0。Blender 无界面运行：

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/pmx2vrm/convert.py -- \
      <模型 id> <解压后的模型目录> <输出.vrm> [--sheet <形状对照表.jpg>]

需要的 Blender 插件：MMD Tools（读 PMX）、VRM format（写 VRM）。模型 id 见 models.py。
输出的明文 VRM 不要放进仓库，用 scripts/protect-model.ts 加密成 .vrmx 再入库（规约要求，见 public/models/quappa/README.txt）。

流程：
  1. pmxprep：删隐藏材质 → 烘焙语义形状键 → 拆脸 → 付与骨的跟随测试 / 删辅助骨 → 读物理
  2. 骨骼映射（VRM humanoid）、腰骨挪到骨盆当 hips 的转轴
  3. MMD 刚体 → VRM 弹簧骨：物理骨连成链，静态刚体按 MMD 的碰撞组做碰撞体
  4. 材质 → MToon：基础贴图、toon 贴图的暗部色当阴影色、加算球面贴图当 matcap、MMD 描边当轮廓线
  5. 表情（口型 / 眨眼 / 情绪预设）、视线、作者信息，导出（T-pose 由插件的 autoPose 摆）
"""
import bpy, sys, os, re, time, types, importlib
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pmxprep  # noqa: E402
import recipes  # noqa: E402
import models  # noqa: E402

ADDON = 'bl_ext.user_default.vrm'


def log(*a):
    print('[pmx2vrm]', *a, flush=True)


def humanoid_map(arm, cfg):
    """QUAPPA-EL 的骨骼命名（mmd_tools 导入后左右变成 .L / .R）。模型里没有的骨不映射"""
    m = {'hips': '腰', 'spine': '上半身', 'chest': '上半身2', 'neck': '首', 'head': '頭'}
    fingers = {'index': '人指', 'middle': '中指', 'ring': '薬指', 'little': '小指'}
    for side, s in (('left', 'L'), ('right', 'R')):
        m.update({
            f'{side}_eye': f'目.{s}',
            f'{side}_shoulder': f'肩.{s}', f'{side}_upper_arm': f'腕.{s}', f'{side}_lower_arm': f'ひじ.{s}',
            f'{side}_hand': f'手首.{s}',
            f'{side}_upper_leg': f'足.{s}', f'{side}_lower_leg': f'ひざ.{s}', f'{side}_foot': f'足首.{s}',
            f'{side}_toes': f'足先EX.{s}',
            f'{side}_thumb_metacarpal': f'親指０.{s}', f'{side}_thumb_proximal': f'親指１.{s}',
            f'{side}_thumb_distal': f'親指２.{s}',
        })
        for f, j in fingers.items():
            for seg, n in (('proximal', '１'), ('intermediate', '２'), ('distal', '３')):
                m[f'{side}_{f}_{seg}'] = f'{j}{n}.{s}'
    m.update(cfg.get('humanoid', {}))
    return {k: v for k, v in m.items() if v in arm.data.bones}


def move_hips_to_pelvis(arm, hips, spine, leg):
    """MMD 的「腰」在腰线（和上半身同一点），当 hips 的话转身时腿会绕着腰线甩。挪到骨盆：
    腿根往上 30% 的位置。腰骨本身没有权重，挪了不影响蒙皮"""
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    h, s, l = eb[hips], eb[spine], eb[leg]
    for c in h.children:
        c.use_connect = False
    z = l.head.z + 0.3 * (s.head.z - l.head.z)
    h.head = Vector((0, s.head.y, z))
    h.tail = h.head + Vector((0, 0, 0.08))
    h.roll = 0
    bpy.ops.object.mode_set(mode='OBJECT')
    return z


# ---------------------------------------------------------------- 材质

def _srgb_to_linear(c):
    return c ** 2.2


def _toon_shadow(img):
    """toon 贴图最下面一行中间的颜色 = MMD 里最暗处乘上去的颜色（sRGB）"""
    if not img or not img.size[0]:
        return (0.9, 0.9, 0.9)
    w = img.size[0]
    px = img.pixels
    i = (w // 2) * 4
    return tuple(px[i + k] for k in range(3))


def alpha_mode(name, alpha, cfg, mat_alpha=1.0):
    """贴图在这个材质用到的区域里：几乎全不透明 → OPAQUE；头发的半透明边 → BLEND + 写深度；
    渐变的半透明叠加层（高光、睫毛、腮红线）→ BLEND；硬边镂空（蕾丝之类）→ MASK。
    材质本身 alpha < 1（眼镜片：贴图不透明、靠材质的 0.1 透明）→ BLEND"""
    if mat_alpha < 0.98:
        return 'BLEND'
    if any(s in name for s in cfg.get('blend_materials', ())):
        return 'BLEND_Z' if 'HAIR' in name.upper() else 'BLEND'
    if not alpha:
        return 'OPAQUE'
    clear, soft = alpha
    if clear + soft < 0.02:
        return 'OPAQUE'
    if 'HAIR' in name.upper():
        return 'BLEND_Z'
    return 'BLEND' if soft > 0.3 * clear else 'MASK'


def to_mtoon(mat, cfg, mode):
    mm = mat.mmd_material
    nt = mat.node_tree
    pick = lambda n: (nt.nodes.get(n).image if nt and nt.nodes.get(n) else None)
    base, toon, sph = pick('mmd_base_tex'), pick('mmd_toon_tex'), pick('mmd_sphere_tex')
    if str(mm.sphere_texture_type) != '2':  # 只有加算（spa）能当 matcap，乘算（sph）丢掉
        sph = None
    diffuse, alpha = tuple(mm.diffuse_color), mm.alpha
    edge = mm.enabled_toon_edge and mm.edge_weight > 0
    edge_color = tuple(mm.edge_color)[:3]
    edge_weight = mm.edge_weight
    double = mm.is_double_sided
    shadow = _toon_shadow(toon)

    m1 = mat.vrm_addon_extension.mtoon1
    m1.enabled = True  # 会重建节点树，图像要先取出来
    mt = m1.extensions.vrmc_materials_mtoon
    pbr = m1.pbr_metallic_roughness
    if base:
        pbr.base_color_texture.index.source = base
        mt.shade_multiply_texture.index.source = base
    # mmd_shader 转过来会把 base_color_factor 置成黑色，得重设
    pbr.base_color_factor = (*(_srgb_to_linear(c) for c in diffuse), alpha)
    k = cfg.get('shade', 0.86)
    mt.shade_color_factor = tuple(_srgb_to_linear(c * k) for c in shadow)
    mt.shading_toony_factor = cfg.get('toony', 0.9)
    mt.shading_shift_factor = cfg.get('shift', -0.05)
    mt.gi_equalization_factor = 0.9
    if sph:
        mt.matcap_texture.index.source = sph
        mt.matcap_factor = (1, 1, 1)
    if mode == 'OPAQUE':
        m1.alpha_mode = 'OPAQUE'
    elif mode == 'MASK':
        m1.alpha_mode = 'MASK'
        m1.alpha_cutoff = 0.5
    else:
        m1.alpha_mode = 'BLEND'
        mt.transparent_with_z_write = mode == 'BLEND_Z'
        mt.render_queue_offset_number = 1 if mode == 'BLEND_Z' else 2
    m1.double_sided = double
    if edge:
        mt.outline_width_mode = 'worldCoordinates'
        mt.outline_width_factor = cfg.get('outline', 0.0012) * edge_weight
        mt.outline_color_factor = tuple(_srgb_to_linear(c) for c in edge_color)
        mt.outline_lighting_mix_factor = 1.0
    return f'{mode}{" matcap" if sph else ""}{" outline" if edge else ""}'


# ---------------------------------------------------------------- 弹簧骨

def bone_local(arm, bone, p):
    return (arm.matrix_world @ arm.data.bones[bone].matrix_local).inverted() @ p


def spring_skipped(name, skip):
    base = re.sub(r'[._]?[LR]$|[左右]', '', name)
    return any(s in name for s in skip.get('contains', ())) or base in skip.get('exact', ())


def spring_params(chain, cfg):
    """按链根的名字分类：头发（长 / 短）、裙摆、其他配饰"""
    name = chain[0]
    for kind, p in cfg['springs'].items():
        keys = p.get('match', ())
        if any(k in name for k in keys) and len(chain) - 1 >= p.get('min_len', 0):
            return kind, p
    return '*', cfg['springs']['*']


def leg_colliders(arm, mesh, human):
    """裙摆用的腿部碰撞体：大腿、小腿各一根胶囊，半径按网格量（权重 ≥ 0.6 的顶点到骨骼轴线的中位距离）。
    MMD 的裙子靠相邻链之间的横向关节兜住，VRM 的弹簧骨没有这个，拿 MMD 的腰 / 上身刚体去撞裙子
    一俯身就会把整条裙子撑成灯笼。大腿那根从髋关节往下 25% 才开始，免得顶到裙腰"""
    import numpy as np
    me = mesh.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    groups = {g.name: g.index for g in mesh.vertex_groups}
    bones = arm.data.bones
    out = []
    for side in ('left', 'right'):
        up, lo, ft = (human.get(f'{side}_{k}') for k in ('upper_leg', 'lower_leg', 'foot'))
        if not (up and lo and ft):
            continue
        for bone, nxt, start in ((up, lo, 0.25), (lo, ft, 0.0)):
            a, b = bones[bone].head_local.copy(), bones[nxt].head_local.copy()
            # 大腿的蒙皮常常主要在 膝捩 这类辅助骨上（跟随测试挂到了 足 下面），所以把这根骨和它下面
            # 的非人形骨（不含下一节人形骨那一支）的权重加起来算
            own = set()
            stack = [bones[bone]]
            while stack:
                cur = stack.pop()
                own.add(cur.name)
                stack.extend(c for c in cur.children if c.name != nxt and c.name not in human.values())
            gids = {groups[n] for n in own if n in groups}
            idx = [v.index for v in me.vertices if sum(g.weight for g in v.groups if g.group in gids) >= 0.6]
            r = 0.06
            if idx:
                p = co[idx]
                A, Bv = np.array(a), np.array(b)
                d = Bv - A
                t = np.clip(((p - A) @ d) / (d @ d), 0, 1)
                # 取外沿（第 90 百分位）：腿不是圆的，而且大腿上还套着灯笼裤 / 衬裙这类跟着腿走的外层，
                # 半径小了迈步时它们会从外层裙子里顶出来，腿也会从两条链中间露出来
                dist = np.linalg.norm(p - (A + t[:, None] * d), axis=1)
                r = min(0.14, max(0.03, float(np.percentile(dist, 90))))
            log(f'  {bone}: {len(idx)} 顶点，半径 {r:.3f}')
            out.append(dict(bone=bone, shape='capsule', a=a.lerp(b, start), b=b, radius=r))
    return out


def build_springs(ctx, arm, statics, dynamics, chains, cfg, legs=(), hips=None):
    """注意：往 Blender 的集合里 add() 会重新分配内存，之前拿到的元素引用会指到别的元素上。
    所以只在刚创建时用引用，跨步骤一律记 uuid 字符串。
    头发 / 配饰撞 MMD 的静态刚体（按碰撞组）；裙摆只撞 legs（见 leg_colliders）"""
    sb = arm.data.vrm_addon_extension.spring_bone1

    def add_collider(s):
        c = sb.add_collider(ctx, arm)
        c.node.bone_name = s['bone']
        if s['shape'] == 'capsule':
            c.shape_type = 'Capsule'
            c.shape.capsule.offset = bone_local(arm, s['bone'], s['a'])
            c.shape.capsule.tail = bone_local(arm, s['bone'], s['b'])
            c.shape.capsule.radius = s['radius']
        else:
            c.shape_type = 'Sphere'
            c.shape.sphere.offset = bone_local(arm, s['bone'], s['center'])
            c.shape.sphere.radius = s['radius']
        return str(c.uuid)

    # 碰撞体：每个静态刚体一个，挂在它的骨骼上（偏移是骨骼局部坐标）
    cols = [(s, add_collider(s)) for s in statics if s['bone'] in arm.data.bones]
    leg_uuids = tuple(add_collider(s) for s in legs)

    def hits(chain):
        if spring_params(chain, cfg)[0] == 'skirt' and leg_uuids:
            return leg_uuids
        d = dynamics[chain[0]]
        return tuple(sorted(u for s, u in cols if pmxprep.collides(d, s)))

    # 碰撞组：按「哪些刚体能碰到这条链」分组，同一组合共用一个
    groups = {}
    for ch in chains:
        key = hits(ch)
        if key and key not in groups:
            g = sb.add_collider_group()
            g.vrm_name = f'body{len(groups)}'
            for u in key:
                g.add_collider().collider_uuid = u
            groups[key] = str(g.uuid)
    kinds = {}
    for ch in chains:
        kind, p = spring_params(ch, cfg)
        kinds[kind] = kinds.get(kind, 0) + 1
        sp = sb.add_spring()
        sp.vrm_name = ch[0]
        n = len(ch)
        for i, b in enumerate(ch):
            j = sp.add_joint()
            j.node.bone_name = b
            src = dynamics.get(b) or dynamics[ch[-2]]
            j.hit_radius = min(p.get('max_radius', 0.04), src['radius'])
            t = i / max(1, n - 1)
            j.stiffness = p['stiffness'] * (1 - p.get('soften', 0.3) * t)  # 越往末梢越软
            j.drag_force = p['drag']
            j.gravity_power = p['gravity']
            j.gravity_dir = (0, 0, -1)
        key = hits(ch)
        if key:
            sp.add_collider_group().collider_group_uuid = groups[key]
        # 裙摆在 hips 空间里模拟：身体整体移动 / 转身不产生惯性（动作里往前走一步，12 节的长裙
        # 每节都滞后一点，累加起来会整条掀到胸口）。只对腿的碰撞和重力起反应
        if kind == 'skirt' and hips:
            sp.center.bone_name = hips
    return len(cols) + len(leg_uuids), len(groups), kinds


# ---------------------------------------------------------------- 主流程

def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    mid, src_dir, out = argv[0], argv[1], os.path.abspath(argv[2])
    sheet = os.path.abspath(argv[argv.index('--sheet') + 1]) if '--sheet' in argv else None
    cfg = models.MODELS[mid]
    t0 = time.time()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    import addon_utils
    for m in ('bl_ext.user_default.mmd_tools', ADDON, 'io_scene_gltf2'):
        addon_utils.enable(m, default_set=True)
    ctx = bpy.context

    pmx = os.path.join(src_dir, cfg['pmx'])
    log('导入', pmx)
    bpy.ops.mmd_tools.import_model(filepath=pmx, scale=0.08)
    root, arm, mesh = pmxprep.objects()

    log('删材质', pmxprep.delete_hidden_materials(mesh, extra=cfg.get('hide_materials', models.HIDE_MATERIALS)))
    statics, dynamics = pmxprep.read_physics(arm)

    mr = root.mmd_root
    available = {m.name for coll in (mr.vertex_morphs, mr.group_morphs, mr.bone_morphs, mr.material_morphs, mr.uv_morphs)
                 for m in coll}
    rec, picked, missing = recipes.resolve(available, cfg.get('recipes'))
    log('形状配方', ' '.join(f'{k}={v}' for k, v in picked.items()))
    if missing:
        log('  缺的形状（不注册，运行时那一项不动）：', missing)
    base, baked = pmxprep.bake_recipes(root, mesh, rec)
    touched = pmxprep.replace_shape_keys(mesh, base, baked)
    if sheet:
        names = pmxprep.render_sheet(mesh, arm, list(baked), sheet)
        log('形状对照表', sheet, '顺序：', ' '.join(names))
    alpha = pmxprep.material_alpha(mesh)
    face = pmxprep.separate_face(mesh, touched, 'Face')
    mesh.name = mesh.data.name = 'Body'
    log(f'脸 {len(face.data.vertices)} 顶点 / 身体 {len(mesh.data.vertices)} 顶点')

    human = humanoid_map(arm, cfg)
    for src, dst in cfg.get('merge_weights', {}).items():
        log('并权重', src, '→', dst, pmxprep.merge_weights(mesh, src, dst), pmxprep.merge_weights(face, src, dst))
    moved = pmxprep.fix_followers(arm, [mesh, face], human)
    if moved:
        log('付与骨挂到人形骨下面：', ', '.join(f'{n}→{h}' for n, h in sorted(moved.items())))
    pmxprep.delete_mmd_extras(root, arm)
    gone = pmxprep.prune_bones(arm, [mesh, face], keep_extra=list(human.values()))
    log(f'删掉 {len(gone)} 根辅助骨，剩 {len(arm.data.bones)}')
    skip = cfg.get('spring_skip', models.SPRING_SKIP)
    dyn = {n: d for n, d in dynamics.items() if not spring_skipped(n, skip)}
    chains = pmxprep.spring_chains(arm, dyn)
    chains = pmxprep.add_tail_bones(arm, chains)
    hz = move_hips_to_pelvis(arm, human['hips'], human['spine'], human['left_upper_leg'])
    log(f'hips 挪到 z={hz:.3f}')

    ext = arm.data.vrm_addon_extension
    ext.addon_version = (4, 7, 2)  # 不设的话导出时的迁移会把视线偏移转一遍
    ext.spec_version = '1.0'
    v1 = ext.vrm1
    v1.humanoid.human_bones.initial_automatic_bone_assignment = False
    v1.expressions.initial_automatic_expression_assignment = False
    ext.spring_bone1.initial_automatic_spring_bone_assignment = False

    hb = v1.humanoid.human_bones
    for k, b in human.items():
        getattr(hb, k).node.bone_name = b
        if getattr(hb, k).node.bone_name != b:
            raise RuntimeError(f'humanoid {k} ← {b} 没设上')
    v1.humanoid.pose = 'autoPose'
    errs = hb.error_messages()
    if errs:
        log('humanoid 问题：', errs)

    # 材质
    mcfg = cfg.get('material', {})
    modes = {}
    for o in (mesh, face):
        for s in o.material_slots:
            mat = s.material
            if not mat.vrm_addon_extension.mtoon1.enabled:
                modes[mat.name] = to_mtoon(mat, mcfg, alpha_mode(mat.name, alpha.get(mat.name), mcfg, mat.mmd_material.alpha))
    log('MToon', ' | '.join(f'{k}: {v}' for k, v in modes.items()))

    # 弹簧骨
    legs = leg_colliders(arm, mesh, human) if any(spring_params(c, cfg)[0] == 'skirt' for c in chains) else []
    if legs:
        log('腿部碰撞体（裙摆用）半径', ' '.join(f"{l['bone']}={l['radius']:.3f}" for l in legs))
    nc, ng, kinds = build_springs(ctx, arm, statics, dynamics, chains, cfg, legs, human['hips'])
    log(f'弹簧链 {len(chains)} 条 {kinds}，碰撞体 {nc}，碰撞组 {ng}')

    # 表情
    ex = v1.expressions
    for preset, mix in models.PRESETS.items():
        mix = [(k, w) for k, w in mix if k in baked]
        if not mix:
            continue
        expr = getattr(ex.preset, preset)
        for key, w in mix:
            b = expr.morph_target_binds.add()
            b.node.mesh_object_name = face.name
            b.index = key
            b.weight = w
        # 情绪预设和眨眼叠加时按比例让（只在没有分部位形状、退回整脸预设时才用得上）
        expr.override_blink = 'none' if preset.startswith('blink') else 'blend'

    # 视线：骨骼型，原点在两眼中间（头骨局部坐标）
    la = v1.look_at
    la.type = 'bone'
    bones = arm.data.bones
    eye_mid = (bones[human['left_eye']].head_local + bones[human['right_eye']].head_local) / 2
    la.offset_from_head_bone = bone_local(arm, human['head'], arm.matrix_world @ eye_mid)
    for rm, deg in ((la.range_map_horizontal_inner, 8), (la.range_map_horizontal_outer, 10),
                    (la.range_map_vertical_down, 8), (la.range_map_vertical_up, 8)):
        rm.input_max_value = 90
        rm.output_scale = cfg.get('look_scale', 1.0) * deg

    # 作者信息
    meta = v1.meta
    for k, v in cfg['meta'].items():
        if k in ('authors', 'references'):
            for x in v:
                getattr(meta, k).add().value = x
        else:
            setattr(meta, k, v)

    # 校验 + 导出
    val = importlib.import_module(f'{ADDON}.editor.validation')

    class Errs(list):
        def add(self):
            o = types.SimpleNamespace()
            self.append(o)
            return o
    errs = Errs()
    val.WM_OT_vrm_validator.detect_errors(ctx, errs, arm.name, execute_migration=True)
    for e in errs:
        if getattr(e, 'severity', 3) <= 1:
            log(f'  校验[{e.severity}]', getattr(e, 'message', e))
    if any(getattr(e, 'severity', 3) == 0 for e in errs):
        raise SystemExit('校验有错误，没导出')

    os.makedirs(os.path.dirname(out), exist_ok=True)
    if cfg.get('save_blend'):
        bpy.ops.wm.save_as_mainfile(filepath=out.replace('.vrm', '.blend'))
    r = bpy.ops.export_scene.vrm(
        filepath=out, armature_object_name=arm.name, export_invisibles=False, export_only_selections=False,
        enable_advanced_preferences=True, export_all_influences=False, export_lights=False,
        export_gltf_animations=False, export_try_sparse_sk=True, use_addon_preferences=False, check_existing=False)
    if r != {'FINISHED'} or not os.path.exists(out):
        raise SystemExit(f'导出失败：{r}')
    log(f'导出 {out}：{os.path.getsize(out) / 1e6:.1f}MB，用时 {time.time() - t0:.0f}s')


main()
