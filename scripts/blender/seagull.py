"""
海鸥（街景的海上用，src/vrm/scenes/seaside.ts 的 createGulls）：程序生成网格 + 骨架 + 两段循环动作，导出 GLB。

    在 Blender 里跑：文本编辑器打开这个文件 → 运行；或者命令行
    blender -b -P scripts/blender/seagull.py

输出 public/scene/models/seagull/seagull.glb。坐标（Blender，Z 朝上）：头朝 +X，左翅膀朝 +Y；
glTF 导出后是 Y 朝上、头朝 +X、左翅膀朝 -Z。

  网格  身体（尾巴 → 身子 → 脖子）一条放样，头是一个拉长的球，喙是一个压扁、略往下勾的锥，
        翅膀是带厚度的翼型（前缘厚、后缘薄），按真实的海鸥配色：白身子、灰背、灰色的上翼面、
        白色的下翼面和后缘、黑色的翼尖、黄喙上一个红点。翼展约 1.35m。颜色是顶点色，整只一个材质（一次绘制）
  骨架  body / head / tail / wing.L wing.R（肩 → 腕）/ hand.L hand.R（腕 → 翼尖）。
        权重按顶点位置直接写（肩、腕两处平滑过渡），不用自动权重：翅膀是一张很薄的翼型，自动权重容易把上下两面分给不同的骨头
  动作  flap   扇翅，0.6s 一个周期：肩从 +48° 扇到 -28°，手（翼尖那段）慢半拍 —— 往上收时折下来、往下扑时展开；身体跟着一沉一浮
        glide  滑翔，2s 一个周期：翅膀微微上扬（上反角），带一点点起伏
        每段动作放在一条 NLA 轨道上，导出成 glTF 里的两段动画（按轨道名）
"""
import math
import os

import bmesh
import bpy
from mathutils import Vector

try:
    HERE = os.path.dirname(os.path.abspath(__file__))
except NameError:
    HERE = os.path.abspath('scripts/blender')
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(REPO, 'public', 'scene', 'models', 'seagull', 'seagull.glb')
FPS = 30


def fresh_scene(name):
    """
    有界面时单独建一个场景（不动用户当前打开的场景）并切过去；命令行后台模式（-b）就用当前场景。
    里面的东西清空重来。（后台模式下另建场景、再在 override 里指定它，导出时依赖图求值会崩：没有窗口，当前场景对不上）
    """
    wm = bpy.context.window_manager
    if bpy.app.background or not wm.windows:
        sc = bpy.context.scene
    else:
        sc = bpy.data.scenes.get(name) or bpy.data.scenes.new(name)
        wm.windows[0].scene = sc
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    sc.render.fps = FPS
    return sc


def ui_override(sc):
    """编辑模式、导出这些操作要一个窗口上下文（从 blender-mcp 的定时器里跑时 bpy.context.window 是空的）。后台模式没有窗口，返回空的"""
    out = {}
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == 'VIEW_3D':
                region = next((r for r in area.regions if r.type == 'WINDOW'), None)
                out.update(window=win, screen=win.screen, area=area, region=region)
                return out
    return out


def srgb(hex_color):
    """'#rrggbb' → 线性 RGBA（Principled BSDF 要的是线性值）"""
    h = hex_color.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i : i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, 1.0)


def material(name, color, rough=0.7):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = srgb(color)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = 0.0
    m.diffuse_color = srgb(color)
    return m


# 颜色写进顶点色（每个面一个颜色），整只海鸥一个材质：three.js 里一个材质就是一次绘制，六种颜色六个材质的话，
# 六只海鸥每帧要画三十六次
COLORS = {
    'white': '#f4f5f2',
    'grey': '#9aa4ae',
    'black': '#232528',
    'beak': '#f0bf2c',
    'spot': '#c8322a',
    'eye': '#121212',
}
MAT_INDEX = {k: i for i, k in enumerate(COLORS)}
GULL_MAT = material('seagull', '#ffffff', 0.75)


def build_mesh():
    bm = bmesh.new()

    def face(verts, mat):
        f = bm.faces.new(verts)
        f.material_index = MAT_INDEX[mat]
        f.smooth = True
        return f

    # ---- 身体：尾巴（扁、宽，扇形）→ 身子 → 脖子，一圈 14 个点 ----
    # (x, 半宽 y, 半高 z, 中心 z)
    sections = [
        (-0.345, 0.044, 0.004, -0.004),
        (-0.30, 0.056, 0.008, -0.003),
        (-0.245, 0.040, 0.020, 0.0),
        (-0.18, 0.050, 0.040, 0.0),
        (-0.11, 0.066, 0.056, 0.0),
        (-0.03, 0.079, 0.068, 0.002),
        (0.05, 0.074, 0.064, 0.006),
        (0.11, 0.054, 0.054, 0.016),
        (0.15, 0.042, 0.045, 0.026),
    ]
    seg = 14
    rings = []
    for x, ry, rz, zc in sections:
        rings.append([bm.verts.new((x, ry * math.cos(2 * math.pi * k / seg), zc + rz * math.sin(2 * math.pi * k / seg))) for k in range(seg)])
    for i in range(len(rings) - 1):
        x0 = sections[i][0]
        for k in range(seg):
            a, b = rings[i][k], rings[i][(k + 1) % seg]
            c, d = rings[i + 1][(k + 1) % seg], rings[i + 1][k]
            # 背上（身子中段的上半圈）是灰的
            top = 0.25 * seg < k + 0.5 < 0.75 * seg
            face((a, b, c, d), 'grey' if top and -0.15 < x0 < 0.06 else 'white')
    # 尾巴末端封口
    tip = bm.verts.new((-0.35, 0.0, -0.004))
    for k in range(seg):
        face((rings[0][(k + 1) % seg], rings[0][k], tip), 'white')

    # ---- 头：拉长的球 ----
    head = bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=9, radius=0.05)
    for v in head['verts']:
        v.co.x = v.co.x * 1.18 + 0.172
        v.co.z = v.co.z * 0.98 + 0.036
    for f in {f for v in head['verts'] for f in v.link_faces}:
        f.material_index = MAT_INDEX['white']
        f.smooth = True

    # ---- 喙：压扁的锥，尖端略往下勾；下喙尖一个红点 ----
    beak = bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=0.016, radius2=0.002, depth=0.085)
    for v in beak['verts']:
        # 锥沿 z 轴：转到沿 +x
        x, y, z = v.co.x, v.co.y, v.co.z
        t = (z + 0.0425) / 0.085  # 0 根部 → 1 尖
        v.co.x = 0.218 + t * 0.085
        v.co.y = y
        v.co.z = 0.03 + x * 0.75 - 0.012 * t * t
    for f in {f for v in beak['verts'] for f in v.link_faces}:
        f.material_index = MAT_INDEX['beak']
        f.smooth = True
    spot = bmesh.ops.create_uvsphere(bm, u_segments=6, v_segments=4, radius=0.0055)
    for v in spot['verts']:
        v.co += Vector((0.272, 0.0, 0.016))
    for f in {f for v in spot['verts'] for f in v.link_faces}:
        f.material_index = MAT_INDEX['spot']

    # ---- 眼睛 ----
    for side in (1, -1):
        eye = bmesh.ops.create_uvsphere(bm, u_segments=6, v_segments=4, radius=0.0075)
        for v in eye['verts']:
            v.co += Vector((0.198, side * 0.037, 0.052))
        for f in {f for v in eye['verts'] for f in v.link_faces}:
            f.material_index = MAT_INDEX['eye']

    # ---- 翅膀：翼型（前缘厚、后缘薄），翼展方向 8 站、弦向 5 个点 ----
    # (y, 前缘 x, 后缘 x, z)：上臂那段直、手那段往后掠
    stations = [
        (0.04, 0.085, -0.075, 0.030),
        (0.14, 0.095, -0.080, 0.035),
        (0.26, 0.100, -0.086, 0.040),
        (0.38, 0.086, -0.092, 0.042),
        (0.48, 0.052, -0.110, 0.040),
        (0.57, 0.004, -0.128, 0.036),
        (0.64, -0.055, -0.148, 0.031),
        (0.685, -0.118, -0.158, 0.028),
    ]
    chord = [0.0, 0.15, 0.4, 0.7, 1.0]

    def wing(side):
        top, bot = [], []
        for y, xle, xte, z in stations:
            thick = 0.019 * (1 - y / 0.8)
            trow, brow = [], []
            for f in chord:
                x = xle + (xte - xle) * f
                t = thick * 4 * f * (1 - f) * (1 - 0.35 * f)
                tv = bm.verts.new((x, side * y, z + t))
                # 前缘、后缘上下两面共用一个点（闭合的翼型）
                if f in (0.0, 1.0):
                    bv = tv
                else:
                    bv = bm.verts.new((x, side * y, z - t * 0.25))
                trow.append(tv)
                brow.append(bv)
            top.append(trow)
            bot.append(brow)
        for j in range(len(stations) - 1):
            ymid = (stations[j][0] + stations[j + 1][0]) / 2
            for c in range(len(chord) - 1):
                tip = ymid > 0.52
                # 上翼面：灰（翼尖黑、后缘一道白）；下翼面：白（翼尖黑）
                tmat = 'black' if tip else ('white' if c == len(chord) - 2 else 'grey')
                bmat = 'black' if tip else 'white'
                a, b = top[j][c], top[j][c + 1]
                cc, d = top[j + 1][c + 1], top[j + 1][c]
                quad_t = (a, d, cc, b) if side > 0 else (a, b, cc, d)
                face(quad_t, tmat)
                a, b = bot[j][c], bot[j][c + 1]
                cc, d = bot[j + 1][c + 1], bot[j + 1][c]
                quad_b = (a, b, cc, d) if side > 0 else (a, d, cc, b)
                if len({a, b, cc, d}) == 4:
                    face(quad_b, bmat)
                else:
                    face(tuple(dict.fromkeys(quad_b)), bmat)

    wing(1)
    wing(-1)

    bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces if f.material_index in (MAT_INDEX['white'], MAT_INDEX['grey'], MAT_INDEX['beak'])])
    # 面上记的"颜色编号"写成顶点色（面角上的，相邻两个面颜色不同就各是各的），材质编号全部归零
    names = list(COLORS)
    layer = bm.loops.layers.float_color.new('Col')
    for f in bm.faces:
        c = srgb(COLORS[names[f.material_index]])
        for loop in f.loops:
            loop[layer] = c
        f.material_index = 0
    me = bpy.data.meshes.new('seagull')
    bm.to_mesh(me)
    bm.free()
    me.validate()
    me.materials.append(GULL_MAT)
    return me


def build_armature(sc):
    arm_data = bpy.data.armatures.new('seagull_rig')
    arm = bpy.data.objects.new('seagull_rig', arm_data)
    sc.collection.objects.link(arm)
    vl = sc.view_layers[0]
    vl.objects.active = arm
    for o in sc.objects:
        o.select_set(o == arm, view_layer=vl)
    with bpy.context.temp_override(**ui_override(sc), active_object=arm, object=arm):
        bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones

    def bone(name, head, tail, parent=None):
        b = eb.new(name)
        b.head, b.tail = head, tail
        # 每根骨头的 Z 轴都朝上，X 轴 = Y × Z：左右翅膀的 X 轴就是镜像的，同样的角度是对称的动作。
        # 不能用 roll = 0：几乎朝 -Y 的骨头（右肩）按 Blender 的规则会绕着 X 翻过去（Z 朝下），
        # 右肩的转轴和左肩同向，两只翅膀就一上一下像跷跷板
        b.align_roll((0.0, 0.0, 1.0))
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
        return b

    bone('body', (-0.16, 0, 0.005), (0.09, 0, 0.005))
    bone('head', (0.11, 0, 0.02), (0.22, 0, 0.04), 'body')
    bone('tail', (-0.18, 0, 0.0), (-0.34, 0, -0.004), 'body')
    for side, sfx in ((1, 'L'), (-1, 'R')):
        bone(f'wing.{sfx}', (0.0, side * 0.05, 0.032), (-0.005, side * 0.38, 0.042), 'body')
        bone(f'hand.{sfx}', (-0.005, side * 0.38, 0.042), (-0.12, side * 0.68, 0.028), f'wing.{sfx}')
    with bpy.context.temp_override(**ui_override(sc), active_object=arm, object=arm):
        bpy.ops.object.mode_set(mode='OBJECT')
    return arm


def smooth01(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def skin(obj, arm):
    """按位置写权重：|y| 小于 6cm 是身体（头、尾巴按 x 再分），肩（6~10cm）、腕（34~42cm）两处平滑过渡"""
    groups = {n: obj.vertex_groups.new(name=n) for n in ['body', 'head', 'tail', 'wing.L', 'hand.L', 'wing.R', 'hand.R']}
    for v in obj.data.vertices:
        x, y, z = v.co
        ay = abs(y)
        sfx = 'L' if y > 0 else 'R'
        w_wing = smooth01(0.06, 0.10, ay)
        w_hand = smooth01(0.34, 0.42, ay)
        w_body = 1 - w_wing
        weights = {}
        if w_body > 0:
            wh = smooth01(0.10, 0.15, x) * w_body
            wt = smooth01(-0.17, -0.23, x) * w_body
            weights['head'] = wh
            weights['tail'] = wt
            weights['body'] = w_body - wh - wt
        if w_wing > 0:
            weights[f'wing.{sfx}'] = w_wing * (1 - w_hand)
            weights[f'hand.{sfx}'] = w_wing * w_hand
        for n, w in weights.items():
            if w > 1e-4:
                groups[n].add([v.index], w, 'REPLACE')
    mod = obj.modifiers.new('rig', 'ARMATURE')
    mod.object = arm
    obj.parent = arm


def key_pose(arm, frame, pose):
    """pose: {骨头名: (rx°, ry°, rz°, 位移 z)}；绕骨头自己的 X 轴转（左右翅膀的 X 轴镜像，同样的角度就是对称的动作）"""
    for name, (rx, ry, rz, lz) in pose.items():
        pb = arm.pose.bones[name]
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (math.radians(rx), math.radians(ry), math.radians(rz))
        pb.location = (0.0, 0.0, lz)
        pb.keyframe_insert('rotation_euler', frame=frame)
        pb.keyframe_insert('location', frame=frame)


def make_action(arm, name, frames, pose_at):
    act = bpy.data.actions.new(name)
    arm.animation_data_create()
    arm.animation_data.action = act
    for f in range(0, frames + 1, 2 if frames <= 24 else 4):
        key_pose(arm, f, pose_at(2 * math.pi * f / frames))
    key_pose(arm, frames, pose_at(2 * math.pi))
    arm.animation_data.action = None
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 0, act)
    strip.name = name
    return act


def flap_pose(p):
    shoulder = 10 + 38 * math.cos(p)
    hand = -12 + 24 * math.cos(p - 1.25)
    bob = -0.016 * math.cos(p)
    pose = {'body': (0, 0, 0, bob), 'head': (-4 * math.cos(p), 0, 0, 0), 'tail': (3 * math.sin(p), 0, 0, 0)}
    for s in ('L', 'R'):
        pose[f'wing.{s}'] = (shoulder, 0, 0, 0)
        pose[f'hand.{s}'] = (hand, 0, 0, 0)
    return pose


def glide_pose(p):
    shoulder = 6 + 1.6 * math.sin(p)
    hand = -4 + 1.2 * math.sin(p + 1.0)
    pose = {'body': (0, 0, 0, 0.004 * math.sin(p)), 'head': (0, 0, 0, 0), 'tail': (2 * math.sin(p + 0.5), 0, 0, 0)}
    for s in ('L', 'R'):
        pose[f'wing.{s}'] = (shoulder, 0, 0, 0)
        pose[f'hand.{s}'] = (hand, 0, 0, 0)
    return pose


def main():
    sc = fresh_scene('seagull')
    me = build_mesh()
    obj = bpy.data.objects.new('seagull', me)
    sc.collection.objects.link(obj)
    arm = build_armature(sc)
    skin(obj, arm)
    make_action(arm, 'flap', 18, flap_pose)
    make_action(arm, 'glide', 60, glide_pose)
    sc.frame_start, sc.frame_end = 0, 60

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    vl = sc.view_layers[0]
    for o in sc.objects:
        o.select_set(o in (obj, arm), view_layer=vl)
    vl.objects.active = arm
    with bpy.context.temp_override(**ui_override(sc), active_object=arm, selected_objects=[obj, arm]):
        export(sc)
    print('exported', OUT, os.path.getsize(OUT), 'bytes,', len(me.polygons), 'faces')


def export(sc):
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format='GLB',
        use_selection=True,
        export_animations=True,
        export_animation_mode='NLA_TRACKS',
        export_skins=True,
        export_def_bones=False,
        # 只导出写好的那一层顶点色，当 COLOR_0（默认会多导一层全白的 COLOR_0，three.js 只认 COLOR_0）
        export_vertex_color='NAME',
        export_vertex_color_name='Col',
        export_all_vertex_colors=False,
        export_yup=True,
        export_apply=False,
    )


main()
