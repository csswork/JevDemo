"""PMX（MMD）→ VRM 1.0。Blender 无界面运行：

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/pmx2vrm/convert.py -- \
      <模型 id> <解压后的模型目录> <输出.vrm>

需要的 Blender 插件：MMD Tools（读 PMX）、VRM format（写 VRM）。模型 id 见 models.py。
输出的明文 VRM 不要放进仓库，用 scripts/protect-model.ts 加密成 .vrmx 再入库（规约要求，见 public/models/quappa/README.txt）。

流程：
  1. pmxprep：删隐藏材质 → 烘焙语义形状键 → 拆脸 → 并权重 / 删辅助骨 → 读物理
  2. 骨骼映射（VRM humanoid）、腰骨挪到骨盆当 hips 的转轴
  3. MMD 刚体 → VRM 弹簧骨：物理骨连成链，静态刚体按 MMD 的碰撞组做碰撞体
  4. 材质 → MToon：基础贴图、toon 贴图的暗部色当阴影色、加算球面贴图当 matcap、MMD 描边当轮廓线
  5. 表情（口型 / 眨眼 / 情绪预设）、视线、作者信息，导出（T-pose 由插件的 autoPose 摆）
"""
import bpy, sys, os, time, types, importlib
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pmxprep  # noqa: E402
import models  # noqa: E402

ADDON = 'bl_ext.user_default.vrm'


def log(*a):
    print('[pmx2vrm]', *a, flush=True)


def humanoid_map(cfg):
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
    return m


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


def to_mtoon(mat, cfg):
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
    blend = any(s in mat.name for s in cfg.get('blend_materials', ()))
    if blend:
        m1.alpha_mode = 'BLEND'
        mt.transparent_with_z_write = True
        mt.render_queue_offset_number = 1
    else:
        m1.alpha_mode = 'OPAQUE'
    m1.double_sided = double
    if edge:
        mt.outline_width_mode = 'worldCoordinates'
        mt.outline_width_factor = cfg.get('outline', 0.0012) * edge_weight
        mt.outline_color_factor = tuple(_srgb_to_linear(c) for c in edge_color)
        mt.outline_lighting_mix_factor = 1.0
    return dict(base=base.name if base else None, matcap=sph.name if sph else None, blend=blend, outline=edge,
                shade=[round(c, 2) for c in shadow])


# ---------------------------------------------------------------- 弹簧骨

def bone_local(arm, bone, p):
    return (arm.matrix_world @ arm.data.bones[bone].matrix_local).inverted() @ p


def build_springs(ctx, arm, statics, dynamics, chains, cfg):
    """注意：往 Blender 的集合里 add() 会重新分配内存，之前拿到的元素引用会指到别的元素上。
    所以只在刚创建时用引用，跨步骤一律记 uuid 字符串"""
    sb = arm.data.vrm_addon_extension.spring_bone1
    # 碰撞体：每个静态刚体一个，挂在它的骨骼上（偏移是骨骼局部坐标）
    cols = []
    for s in statics:
        if s['bone'] not in arm.data.bones:
            continue
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
        cols.append((s, str(c.uuid)))

    def hits(chain):
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
    params = cfg['springs']
    for ch in chains:
        name = ch[0]
        p = next((v for k, v in params.items() if k in name), params['*'])
        sp = sb.add_spring()
        sp.vrm_name = name
        n = len(ch)
        for i, b in enumerate(ch):
            j = sp.add_joint()
            j.node.bone_name = b
            src = dynamics.get(b) or dynamics[ch[-2]]
            j.hit_radius = min(p.get('max_radius', 0.04), src['radius'])
            t = i / max(1, n - 1)
            j.stiffness = p['stiffness'] * (1 - 0.3 * t)  # 越往发梢越软
            j.drag_force = p['drag']
            j.gravity_power = p['gravity']
            j.gravity_dir = (0, 0, -1)
        key = hits(ch)
        if key:
            sp.add_collider_group().collider_group_uuid = groups[key]
    return len(cols), len(groups)


# ---------------------------------------------------------------- 主流程

def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    mid, src_dir, out = argv[0], argv[1], os.path.abspath(argv[2])
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

    log('删隐藏材质', pmxprep.delete_hidden_materials(mesh, extra=cfg.get('hide_materials', ())))
    statics, dynamics = pmxprep.read_physics(arm)
    log('烘焙形状键')
    base, baked = pmxprep.bake_recipes(root, mesh, cfg['recipes'])
    touched = pmxprep.replace_shape_keys(mesh, base, baked)
    face = pmxprep.separate_face(mesh, touched, 'Face')
    mesh.name = mesh.data.name = 'Body'
    log(f'脸 {len(face.data.vertices)} 顶点 / 身体 {len(mesh.data.vertices)} 顶点')

    for src, dst in cfg.get('merge_weights', {}).items():
        log('并权重', src, '→', dst, pmxprep.merge_weights(mesh, src, dst), pmxprep.merge_weights(face, src, dst))
    human = humanoid_map(cfg)
    pmxprep.delete_mmd_extras(root, arm)
    gone = pmxprep.prune_bones(arm, [mesh, face], keep_extra=list(human.values()))
    log(f'删掉 {len(gone)} 根辅助骨，剩 {len(arm.data.bones)}')
    chains = pmxprep.spring_chains(arm, dynamics, skip=cfg.get('spring_skip', ()))
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
    for o in (mesh, face):
        for s in o.material_slots:
            if not s.material.vrm_addon_extension.mtoon1.enabled:
                log('  MToon', s.material.name, to_mtoon(s.material, cfg.get('material', {})))

    # 弹簧骨
    nc, ng = build_springs(ctx, arm, statics, dynamics, chains, cfg)
    log(f'弹簧链 {len(chains)} 条（{", ".join(c[0] for c in chains)}），碰撞体 {nc}，碰撞组 {ng}')

    # 表情
    ex = v1.expressions
    for preset, mix in cfg['presets'].items():
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
        rm.output_scale = cfg.get('look', {}).get('scale', 1.0) * deg

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
