"""PMX → 干净的 Blender 场景（转 VRM 之前的通用步骤）。

  1. 删掉默认不可见的材质（alpha 0：差分衣服、特效、R18 部件），以及口パンツ这类恶搞部件
  2. 按配方把 MMD 变形烘焙成语义形状键（组合变形里的骨骼部分 —— 牙齿 / 舌头 —— 也一起烘进去）
  3. 受形状键影响的面拆成单独的「脸」网格，身体网格不带形状键（否则每个子网格都要带一套 morph）
  4. 骨骼：去掉约束，把付与驱动的辅助骨权重并回主骨，删掉无权重的辅助骨
"""
import bpy, bmesh
import numpy as np


def objects():
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    mesh = next(o for o in bpy.data.objects if o.type == 'MESH' and o.data.shape_keys and o.parent == arm)
    root = next(o for o in bpy.data.objects if getattr(o, 'mmd_type', '') == 'ROOT')
    return root, arm, mesh


def delete_hidden_materials(mesh, extra=()):
    """extra：材质名里含这些子串的也删（默认可见但不该出现的：藏在头里靠变形弹出来的漫符 / 眼泪、恶搞部件…）"""
    slots = mesh.material_slots
    hidden = {i for i, s in enumerate(slots)
              if s.material.mmd_material.alpha < 0.01 or any(x in s.material.name for x in extra)}
    names = sorted(slots[i].material.name for i in hidden)
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in hidden], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(mesh.data)
    bm.free()
    # 删掉空出来的材质槽（倒序，下标才不会错位）
    used = {p.material_index for p in mesh.data.polygons}
    for i in reversed(range(len(slots))):
        if i not in used:
            mesh.data.materials.pop(index=i)
    return names


def coords(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    a = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', a)
    ev.to_mesh_clear()
    return a


def bake_recipes(root, mesh, recipes):
    """recipes: {新形状键名: [(MMD 变形名, 权重), ...]}。用 mmd_tools 的变形滑块驱动（组合 / 骨骼变形都生效），
    取求值后的顶点坐标作为新形状键。返回 {名字: 坐标}，以及 Basis 坐标"""
    bpy.context.view_layer.objects.active = root
    bpy.ops.mmd_tools.morph_slider_setup(type='BIND')
    ph = next(o for o in bpy.data.objects if 'placeholder' in o.name.lower())
    keys = ph.data.shape_keys.key_blocks
    for k in keys:
        k.slider_min = -1
        k.slider_max = 2

    def pose(mix):
        for k in keys:
            k.value = 0
        for n, w in mix:
            if n not in keys:
                raise KeyError(f'MMD 变形不存在：{n}')
            keys[n].value += w
        bpy.context.view_layer.update()
        return coords(mesh)

    base = pose([])
    out = {name: pose(mix) for name, mix in recipes.items()}
    pose([])
    bpy.ops.mmd_tools.morph_slider_setup(type='UNBIND')
    return base, out


def replace_shape_keys(mesh, base, baked, eps=1e-6):
    """删掉全部原有形状键（含 mmd_sdef_*），换成烘焙好的。返回受影响的顶点掩码"""
    mesh.shape_key_clear()
    basis = mesh.shape_key_add(name='Basis', from_mix=False)
    basis.data.foreach_set('co', base)
    touched = np.zeros(len(mesh.data.vertices), dtype=bool)
    for name, co in baked.items():
        k = mesh.shape_key_add(name=name, from_mix=False)
        k.data.foreach_set('co', co)
        d = np.linalg.norm((co - base).reshape(-1, 3), axis=1)
        touched |= d > eps
        print(f'  形状键 {name}: {int((d > eps).sum())} 顶点, 最大位移 {d.max() * 1000:.1f}mm')
    return touched


def separate_face(mesh, touched, name):
    """受形状键影响的面拆出去。脸网格保留形状键，身体网格清掉"""
    me = mesh.data
    for p in me.polygons:
        p.select = any(touched[v] for v in p.vertices)
    for v in me.vertices:
        v.select = False
    for e in me.edges:
        e.select = False
    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    bpy.ops.object.mode_set(mode='OBJECT')
    for p in me.polygons:
        p.select = any(touched[v] for v in p.vertices)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    face = next(o for o in bpy.context.selected_objects if o != mesh)
    face.name = name
    face.data.name = name
    mesh.shape_key_clear()
    for o in (mesh, face):
        used = {p.material_index for p in o.data.polygons}
        for i in reversed(range(len(o.material_slots))):
            if i not in used:
                o.data.materials.pop(index=i)
    return face


def merge_weights(mesh, src, dst):
    vg = mesh.vertex_groups
    if src not in vg:
        return 0
    s, d = vg[src], vg.get(dst) or vg.new(name=dst)
    n = 0
    for v in mesh.data.vertices:
        for g in v.groups:
            if g.group == s.index and g.weight > 0:
                d.add([v.index], g.weight, 'ADD')
                n += 1
    vg.remove(s)
    return n


def weighted_bones(meshes):
    out = set()
    for m in meshes:
        names = {g.index: g.name for g in m.vertex_groups}
        for v in m.data.vertices:
            for g in v.groups:
                if g.weight > 1e-4:
                    out.add(names[g.group])
    return out


def prune_bones(arm, meshes, keep_extra):
    """只留：有权重的骨、keep_extra、以及它们的祖先。其余（IK、_dummy_/_shadow_、錘、膝軸抽出…）删掉"""
    keep = weighted_bones(meshes) | set(keep_extra)
    bones = arm.data.bones
    for n in list(keep):
        b = bones.get(n)
        while b:
            keep.add(b.name)
            b = b.parent
    for pb in arm.pose.bones:
        for c in list(pb.constraints):
            pb.constraints.remove(c)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    gone = [b.name for b in eb if b.name not in keep]
    for n in gone:
        eb.remove(eb[n])
    bpy.ops.object.mode_set(mode='OBJECT')
    for m in meshes:
        for g in list(m.vertex_groups):
            if g.name not in bones:
                m.vertex_groups.remove(g)
    return gone


# ---------------------------------------------------------------- 物理 → 弹簧骨的原始数据

def _rigid_shape(o):
    """刚体的形状（Blender 世界坐标，Z 朝上）。胶囊的轴 = 网格局部包围盒最长的那根轴"""
    from mathutils import Vector
    r = o.mmd_rigid
    M = o.matrix_world
    c = M.translation.copy()
    if r.shape == 'SPHERE':
        return dict(shape='sphere', center=c, radius=r.size[0])
    if r.shape == 'CAPSULE':
        vs = [v.co for v in o.data.vertices]
        ext = [max(v[i] for v in vs) - min(v[i] for v in vs) for i in range(3)]
        ax = ext.index(max(ext))
        unit = Vector([1.0 if i == ax else 0.0 for i in range(3)])
        d = (M.to_3x3() @ unit).normalized() * (r.size[1] / 2)
        return dict(shape='capsule', a=c - d, b=c + d, radius=r.size[0])
    # 盒子：取最薄的两个方向的平均当半径（头发片），当球处理
    s = sorted(r.size)
    return dict(shape='sphere', center=c, radius=(s[0] + s[1]) / 2)


def read_physics(arm):
    """返回 statics（可做碰撞体的静态刚体）和 dynamics（物理驱动的骨骼 → 刚体），都带碰撞组信息"""
    statics, dynamics = [], {}
    for o in bpy.data.objects:
        if getattr(o, 'mmd_type', '') != 'RIGID_BODY':
            continue
        r = o.mmd_rigid
        if not r.bone or r.bone not in arm.data.bones:
            continue
        info = dict(name=o.name, bone=r.bone, group=r.collision_group_number,
                    mask={i for i, x in enumerate(r.collision_group_mask) if x}, **_rigid_shape(o))
        if str(r.type) == '0':
            statics.append(info)
        else:
            dynamics[r.bone] = info
    return statics, dynamics


def collides(dyn, st):
    """MMD 的碰撞掩码是「不和这些组碰」，双方都允许才碰"""
    return st['group'] not in dyn['mask'] and dyn['group'] not in st['mask']


def spring_chains(arm, dynamics, skip=()):
    """物理骨骼连成链：根 = 父骨不是物理骨的那根，有分叉就从分叉处另起一条"""
    bones = arm.data.bones
    dyn = {n for n in dynamics if n in bones and not any(s in n for s in skip)}
    chains = []

    def walk(b, chain):
        chain.append(b.name)
        kids = [c for c in b.children if c.name in dyn]
        if not kids:
            chains.append(chain)
            return
        walk(kids[0], chain)
        for k in kids[1:]:
            walk(k, [])

    for n in sorted(dyn):
        b = bones[n]
        if not (b.parent and b.parent.name in dyn):
            walk(b, [])
    return chains


def add_tail_bones(arm, chains):
    """VRM 1.0 的弹簧链最后一个关节只当尾巴不转，所以每条链末端补一根尾骨（放在 Blender 骨骼的 tail 上）"""
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    out = []
    for ch in chains:
        last = eb[ch[-1]]
        t = eb.new(ch[-1] + '_tail')
        t.head = last.tail
        t.tail = last.tail + (last.tail - last.head) * 0.5
        t.parent = last
        t.use_deform = False
        out.append(ch + [t.name])
    bpy.ops.object.mode_set(mode='OBJECT')
    return out


def delete_mmd_extras(root, arm):
    """刚体、关节、变形滑块占位物体、MMD 根节点都不要了；骨架提到顶层"""
    for o in list(bpy.data.objects):
        if getattr(o, 'mmd_type', '') in ('RIGID_BODY', 'JOINT', 'RIGID_GRP_OBJ', 'JOINT_GRP_OBJ', 'TEMPORARY_GRP_OBJ', 'PLACEHOLDER') \
                or 'placeholder' in o.name.lower():
            bpy.data.objects.remove(o, do_unlink=True)
    mw = arm.matrix_world.copy()
    arm.parent = None
    arm.matrix_world = mw
    bpy.data.objects.remove(root, do_unlink=True)


# ---------------------------------------------------------------- 付与骨的跟随测试

LIMB_ORDER = ['spine', 'chest', 'upper_chest', 'neck', 'head'] + [
    f'{side}_{b}' for side in ('left', 'right')
    for b in ('shoulder', 'upper_arm', 'lower_arm', 'hand', 'upper_leg', 'lower_leg', 'foot')]


def fix_followers(arm, meshes, human, threshold=0.6):
    """MMD 里靠付与 / IK 跟着某根人形骨转、层级上却不在它下面的骨（膝捩、D 骨…），VRM 里不会再跟着转，
    蒙皮会被撕开。在还带着 mmd_tools 约束的骨架上逐根转一下人形骨，看哪些有权重的骨跟着转了
    （≥ threshold 倍），挂到「最深的那根」人形骨下面。只跟一部分的（付与 0.5 之类）不动。
    挂在根上的脚 IK 控制器测试时关掉，否则会把腿拽回原位。返回 {骨: 新父骨}"""
    from mathutils import Quaternion, Vector
    pbs, bones = arm.pose.bones, arm.data.bones
    hum = set(human.values())

    def under(name, roots):
        b = bones.get(name)
        while b:
            if b.name in roots:
                return True
            b = b.parent
        return False

    muted = []
    for pb in pbs:
        for c in pb.constraints:
            if c.type == 'IK' and not c.mute and not under(getattr(c, 'subtarget', '') or '', hum):
                c.mute = True
                muted.append(c)
    weighted = sorted(n for n in weighted_bones(meshes) - hum if n in pbs)  # 顶点组里还有 mmd_edge_scale 之类不是骨骼的
    ctx = bpy.context

    def snap():
        ctx.view_layer.update()
        return {n: pbs[n].matrix.to_quaternion() for n in weighted}

    rest = snap()
    angle = 0.6
    test = Quaternion(Vector((1, 1, 1)).normalized(), angle)
    follow = {}
    for key in LIMB_ORDER:
        h = human.get(key)
        if not h or h not in pbs:
            continue
        pb = pbs[h]
        mode, oldq = pb.rotation_mode, pb.rotation_quaternion.copy()
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = test
        now = snap()
        for n in weighted:
            if rest[n].rotation_difference(now[n]).angle >= threshold * angle:
                follow[n] = h  # LIMB_ORDER 由根到梢，后面的（更深的）覆盖前面的
        pb.rotation_quaternion = oldq
        pb.rotation_mode = mode
    for c in muted:
        c.mute = False
    ctx.view_layer.update()
    moves = {n: h for n, h in follow.items() if not under(n, {h})}
    if moves:
        ctx.view_layer.objects.active = arm
        bpy.ops.object.mode_set(mode='EDIT')
        eb = arm.data.edit_bones
        for n, h in moves.items():
            eb[n].use_connect = False
            eb[n].parent = eb[h]
        bpy.ops.object.mode_set(mode='OBJECT')
    return moves


# ---------------------------------------------------------------- 材质的透明度（按材质实际用到的 UV 区域采样）

def material_alpha(mesh):
    """{材质名: (完全透明的比例, 半透明的比例)}。贴图常常几个材质共用，所以只看这个材质的面用到的那块"""
    import numpy as np
    me = mesh.data
    uv = me.uv_layers.active
    if not uv:
        return {}
    uvs = np.empty(len(me.loops) * 2, dtype=np.float32)
    uv.data.foreach_get('uv', uvs)
    uvs = uvs.reshape(-1, 2)
    mi = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('material_index', mi)
    ls = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('loop_start', ls)
    lt = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('loop_total', lt)
    cache, out = {}, {}
    for i, slot in enumerate(mesh.material_slots):
        mat = slot.material
        node = mat.node_tree.nodes.get('mmd_base_tex') if mat.node_tree else None
        img = node.image if node else None
        if not img or not img.size[0]:
            continue
        if img.name not in cache:
            w, h = img.size
            px = np.empty(w * h * 4, dtype=np.float32)
            img.pixels.foreach_get(px)
            cache[img.name] = px.reshape(h, w, 4)[:, :, 3]
        a = cache[img.name]
        polys = np.nonzero(mi == i)[0]
        if not len(polys):
            continue
        idx = np.concatenate([np.arange(ls[p], ls[p] + lt[p]) for p in polys[:: max(1, len(polys) // 4000)]])
        # 面中心也采一下（三角形的顶点常落在不透明的边上）
        u = uvs[idx]
        h, w = a.shape
        x = (np.mod(u[:, 0], 1) * (w - 1)).astype(int)
        y = (np.mod(u[:, 1], 1) * (h - 1)).astype(int)
        s = a[y, x]
        out[mat.name] = (float((s < 0.1).mean()), float(((s >= 0.1) & (s < 0.95)).mean()))
    return out


# ---------------------------------------------------------------- 形状对照表

def render_sheet(mesh, arm, keys, out, eye_l='目.L', eye_r='目.R', head='頭', cols=7):
    """每个形状键单独拉满，正交相机拍脸，拼成一张图（Workbench，贴图色）。第一格是中性脸"""
    import math
    import numpy as np
    sc = bpy.context.scene
    bones = arm.data.bones
    eye = (bones[eye_l].head_local + bones[eye_r].head_local) / 2
    hz = bones[head].head_local.z
    eh = max(0.04, eye.z - hz)
    for s in mesh.material_slots:
        nt = s.material.node_tree
        if nt and 'mmd_base_tex' in nt.nodes:
            nt.nodes.active = nt.nodes['mmd_base_tex']
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'FLAT'
    sc.display.shading.color_type = 'TEXTURE'
    res = 300
    sc.render.resolution_x = sc.render.resolution_y = res
    cam = bpy.data.objects.new('_sheet_cam', bpy.data.cameras.new('_sheet_cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = eh * 2.3
    cam.location = (eye.x, eye.y - 1.0, eye.z - eh * 0.45)
    cam.rotation_euler = (math.pi / 2, 0, 0)
    hidden = []
    for o in bpy.data.objects:
        if o.type == 'MESH' and o != mesh and not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    kb = mesh.data.shape_keys.key_blocks
    names = ['-'] + list(keys)
    tiles = []
    tmp = out + '.tile.png'
    for n in names:
        for k in kb:
            k.value = 0
        if n != '-':
            kb[n].value = 1
        bpy.ops.render.render(write_still=False)
        bpy.data.images['Render Result'].save_render(tmp)
        t = bpy.data.images.load(tmp)
        tiles.append(np.array(t.pixels[:], dtype=np.float32).reshape(res, res, 4))
        bpy.data.images.remove(t)
    for k in kb:
        k.value = 0
    rows = math.ceil(len(tiles) / cols)
    sheet = np.ones((rows * res, cols * res, 4), dtype=np.float32)
    for i, a in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet[(rows - 1 - r) * res:(rows - r) * res, c * res:(c + 1) * res] = a
    im = bpy.data.images.new('_sheet', cols * res, rows * res)
    im.pixels = sheet.ravel()
    im.filepath_raw = out
    im.file_format = 'JPEG'
    im.save()
    bpy.data.images.remove(im)
    bpy.data.objects.remove(cam, do_unlink=True)
    for o in hidden:
        o.hide_render = False
    import os
    os.remove(tmp)
    return names
