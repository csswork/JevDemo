"""
小渔船（街景的海上用，src/vrm/scenes/seaside.ts 的 createBoats）：程序生成，导出 GLB。

    在 Blender 里跑：文本编辑器打开这个文件 → 运行；或者命令行
    blender -b -P scripts/blender/fishing_boat.py

输出 public/scene/models/fishing_boat/fishing_boat.glb。坐标（Blender，Z 朝上）：船头朝 +X，水线在 z = 0；
glTF 导出后是 Y 朝上、船头朝 +X。

照着日本港口里常见的小型渔船（9m 上下的玻璃钢船）做：
  船身    沿船长 26 个站位放样：船头的舷弧往上翘、横剖面越往前越尖（V 形），船尾是平的方艉。
          白色的船身，舷边一道蓝色的腰线，水线以下红褐色的防污漆；里面一圈舷墙（船头高、船尾低）和浅灰的甲板，
          舷墙顶上一道蓝色的压条
  驾驶舱  在后半段：前窗往后斜，前面三扇、两侧各两扇窗（深蓝的玻璃），后面一扇门，舱顶出檐；
          舱顶上桅杆、雷达的横杆和航行灯，舱后的排气筒，侧面挂一个橙色的救生圈
  别的    两舷挂着当防撞垫的黑色旧轮胎、船头的护栏和锚机、船尾一面小旗
"""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

try:
    HERE = os.path.dirname(os.path.abspath(__file__))
except NameError:
    HERE = os.path.abspath('scripts/blender')
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(REPO, 'public', 'scene', 'models', 'fishing_boat', 'fishing_boat.glb')


def fresh_scene(name):
    """有界面时单独建一个场景并切过去（不动用户打开的场景）；命令行后台模式用当前场景。清空重来"""
    wm = bpy.context.window_manager
    if bpy.app.background or not wm.windows:
        sc = bpy.context.scene
    else:
        sc = bpy.data.scenes.get(name) or bpy.data.scenes.new(name)
        wm.windows[0].scene = sc
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    return sc


def ui_override():
    out = {}
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == 'VIEW_3D':
                region = next((r for r in area.regions if r.type == 'WINDOW'), None)
                out.update(window=win, screen=win.screen, area=area, region=region)
                return out
    return out


def srgb(hex_color):
    h = hex_color.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i : i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, 1.0)


def material(name, color, rough=0.6, metal=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = srgb(color)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    m.diffuse_color = srgb(color)
    return m


# 颜色写进顶点色（每个面一个颜色），整条船只分两个材质：油漆（一般的面）和玻璃 / 金属（光滑的）。
# three.js 里一个材质一次绘制，十几种颜色各一个材质的话，四条船每帧要多画五十多次
COLORS = {
    'hull': '#f3f4f1',
    'stripe': '#2a64ad',
    'bottom': '#9a3b2e',
    'boot': '#1f3a66',
    'deck': '#b9c1b8',
    'cabin': '#f6f6f3',
    'glass': '#1d2c3c',
    'roof': '#2a64ad',
    'dark': '#26282b',
    'metal': '#c9ccd0',
    'tire': '#1b1c1e',
    'orange': '#ee6a1f',
    'red': '#d23a2e',
    'green': '#2fa85a',
    'nav_white': '#fff6e6',
    'nav_red': '#ff3a30',
    'nav_green': '#40ff70',
}
GLOSSY = {'glass', 'metal'}
# 航行灯（夜里亮）：单独一个材质 boat_glow，three.js 那边换成按天黑程度发光的材质；位置标成空物体 light…（光晕）
GLOWS = {'nav_white', 'nav_red', 'nav_green'}
LIGHT_MARKS = []
MI = {k: i for i, k in enumerate(COLORS)}
PAINT = material('boat_paint', '#ffffff', 0.5)
GLASS = material('boat_glass', '#ffffff', 0.1)
GLOW = material('boat_glow', '#ffffff', 0.4)

# ---- 船身的形状（t = 0 船尾 → 1 船头）----
XS, XB = -4.2, 4.8
L = XB - XS


def ss(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def half_beam(t):
    return 1.32 * (1 - ss(0.52, 1.0, t) ** 1.7) * (0.88 + 0.12 * ss(0.0, 0.2, t))


def sheer(t):
    """舷边（甲板边缘）的高度：船头往上翘，船尾也稍微抬一点"""
    return 0.95 + 0.6 * ss(0.5, 1.0, t) ** 1.5 + 0.08 * (1 - ss(0.0, 0.15, t))


def keel(t):
    """龙骨（船底最低处）的高度：船尾浅一点，船头的前脚往上收到船首"""
    return -0.55 + 0.1 * (1 - ss(0.0, 0.2, t)) + 0.95 * ss(0.76, 1.0, t) ** 1.3


def bulwark(t):
    """舷墙高度（甲板在舷边以下多少）：船头高、船尾低"""
    return 0.28 + 0.3 * ss(0.55, 1.0, t)


def section_point(t, u, side):
    """横剖面上的一点：u = 0 龙骨 → 1 舷边。中段是圆舭，越往前越接近 V 形；舷边往外飘一点（船头更明显）"""
    w = half_beam(t)
    zs, zk = sheer(t), keel(t)
    v = ss(0.55, 1.0, t)
    yf = (math.sin(u * math.pi / 2) ** 0.55) * (1 - v) + u * v
    zf = (1 - math.cos(u * math.pi / 2)) * (1 - v * 0.5) + (u**1.25) * v * 0.5
    flare = 1 + 0.06 * ss(0.75, 1.0, u) * (0.4 + v)
    return Vector((XS + t * L, side * w * yf * flare, zk + (zs - zk) * zf))


def build_hull(bm, face):
    N = 26
    M = 10
    stations = [i / (N - 1) for i in range(N)]
    # 每个站位一排点：左舷边 → 龙骨 → 右舷边
    rows = []
    for t in stations:
        left = [section_point(t, 1 - k / (M - 1), 1) for k in range(M)]
        right = [section_point(t, k / (M - 1), -1) for k in range(1, M)]
        rows.append([bm.verts.new(p) for p in left + right])
    P = 2 * M - 1
    for i in range(N - 1):
        for k in range(P - 1):
            a, b = rows[i][k], rows[i][k + 1]
            c, d = rows[i + 1][k + 1], rows[i + 1][k]
            # 舷边往下第二排是蓝色腰线（顺着舷弧）
            face((a, d, c, b), 'stripe' if k in (1, P - 3) else 'hull', smooth=True)
    # 方艉：第一个站位的剖面封起来（左舷边 → 龙骨 → 右舷边，从船尾看是逆时针）
    face(rows[0], 'hull', smooth=False)
    # 水线：沿 z = 0.03、0.11 两个水平面把船身切开，再按高度上色 —— 网格的行顺着舷弧、不是水平的，
    # 直接按面的中心高度分，红色的边界是一道道锯齿
    for z in (0.03, 0.11):
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, z), plane_no=(0, 0, 1))
    for f in bm.faces:
        zc = f.calc_center_median().z
        if zc < 0.03:
            f.material_index = MI['bottom']
        elif zc < 0.11:
            f.material_index = MI['boot']

    # 舷墙内侧 + 甲板 + 舷墙顶的压条
    inner_top, inner_bot = [], []
    for t in stations[:-1]:
        zs, zd = sheer(t), sheer(t) - bulwark(t)
        w = half_beam(t)
        x = XS + t * L
        th = 0.06
        inner_top.append((bm.verts.new((x, w - th, zs)), bm.verts.new((x, -(w - th), zs))))
        wd = max(0.05, w * 0.96 - th)
        inner_bot.append((bm.verts.new((x, wd, zd)), bm.verts.new((x, -wd, zd))))
    for i in range(len(inner_top) - 1):
        lt0, rt0 = inner_top[i]
        lt1, rt1 = inner_top[i + 1]
        lb0, rb0 = inner_bot[i]
        lb1, rb1 = inner_bot[i + 1]
        face((lt0, lb0, lb1, lt1), 'hull')
        face((rt1, rb1, rb0, rt0), 'hull')
        face((lb0, rb0, rb1, lb1), 'deck')
        # 压条：舷边外沿 → 舷墙内沿
        face((rows[i][0], lt0, lt1, rows[i + 1][0]), 'stripe')
        face((rows[i + 1][P - 1], rt1, rt0, rows[i][P - 1]), 'stripe')
    # 船尾的舷墙内侧
    lt, rt = inner_top[0]
    lb, rb = inner_bot[0]
    face((lt, rt, rb, lb), 'hull')
    # 船头：舷墙收到船首
    lt, rt = inner_top[-1]
    lb, rb = inner_bot[-1]
    tip_top, tip_bot = rows[-1][0], bm.verts.new((XS + stations[-2] * L + 0.25, 0, sheer(stations[-2]) - bulwark(stations[-2])))
    face((rt, tip_top, lt), 'hull')
    face((lb, rb, tip_bot), 'deck')


def box(bm, face, x0, y0, z0, x1, y1, z1, mat, M=None):
    """轴对齐的盒子（可以带一个变换）"""
    vs = [Vector(v) for v in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
    if M is not None:
        vs = [M @ v for v in vs]
    v = [bm.verts.new(p) for p in vs]
    for q in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        face([v[i] for i in q], mat)


def cylinder(bm, face, p0, p1, r, mat, seg=10, smooth=True):
    a, b = Vector(p0), Vector(p1)
    axis = (b - a).normalized()
    up = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
    u = axis.cross(up).normalized()
    w = axis.cross(u)
    ra, rb = [], []
    for k in range(seg):
        ang = 2 * math.pi * k / seg
        off = (u * math.cos(ang) + w * math.sin(ang)) * r
        ra.append(bm.verts.new(a + off))
        rb.append(bm.verts.new(b + off))
    for k in range(seg):
        face((ra[k], ra[(k + 1) % seg], rb[(k + 1) % seg], rb[k]), mat, smooth=smooth)
    face(list(reversed(ra)), mat)
    face(rb, mat)


def torus(bm, face, center, axis, R, r, mat, seg=16, rseg=8):
    c = Vector(center)
    ax = Vector(axis).normalized()
    up = Vector((0, 0, 1)) if abs(ax.z) < 0.9 else Vector((1, 0, 0))
    u = ax.cross(up).normalized()
    w = ax.cross(u)
    grid = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ring_c = c + (u * math.cos(a) + w * math.sin(a)) * R
        radial = (u * math.cos(a) + w * math.sin(a))
        grid.append([bm.verts.new(ring_c + (radial * math.cos(2 * math.pi * j / rseg) + ax * math.sin(2 * math.pi * j / rseg)) * r) for j in range(rseg)])
    for i in range(seg):
        for j in range(rseg):
            a, b = grid[i][j], grid[(i + 1) % seg][j]
            cc, d = grid[(i + 1) % seg][(j + 1) % rseg], grid[i][(j + 1) % rseg]
            face((a, d, cc, b), mat, smooth=True)


def build_cabin(bm, face):
    t0 = (-3.0 - XS) / L
    zd = sheer(t0) - bulwark(t0)
    x0, x1 = -3.0, -1.0
    hw, top = 0.88, zd + 1.95
    # 前面往后斜（顶部往后缩 0.25m），两侧往里收一点。顶点顺序和 box() 一样：0..3 底（-y 那边先），4..7 顶
    lean, tuck = 0.25, 0.06
    v = [
        bm.verts.new(p)
        for p in (
            (x0, -hw, zd),
            (x1, -hw, zd),
            (x1, hw, zd),
            (x0, hw, zd),
            (x0, -hw + tuck, top),
            (x1 - lean, -hw + tuck, top),
            (x1 - lean, hw - tuck, top),
            (x0, hw - tuck, top),
        )
    ]
    for q in ((4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        face([v[i] for i in q], 'cabin')

    def wall_quad(p0, p1, p2, p3, mat, inset=0.006):
        """贴在墙面外面一点的四边形（窗、门）：p0 左下、p1 右下、p2 右上、p3 左上（从外面看）"""
        n = (p1 - p0).cross(p3 - p0).normalized()
        face([bm.verts.new(p + n * inset) for p in (p0, p1, p2, p3)], mat)

    def lerp(a, b, t):
        return a + (b - a) * t

    def on_wall(bl, br, tr, tl):
        """墙面上的参数坐标 (u 横、v 竖) → 点"""
        return lambda uu, vv: lerp(lerp(bl, br, uu), lerp(tl, tr, uu), vv)

    co = [x.co.copy() for x in v]
    # 前墙（从船头看：左下是 -y 那边）三扇窗
    p = on_wall(co[1], co[2], co[6], co[5])
    for k in range(3):
        u0 = 0.06 + k * 0.31
        wall_quad(p(u0, 0.52), p(u0 + 0.27, 0.52), p(u0 + 0.27, 0.9), p(u0, 0.9), 'glass')
    # 两侧各两扇
    for p in (on_wall(co[2], co[3], co[7], co[6]), on_wall(co[0], co[1], co[5], co[4])):
        for u0 in (0.12, 0.55):
            wall_quad(p(u0, 0.5), p(u0 + 0.32, 0.5), p(u0 + 0.32, 0.86), p(u0, 0.86), 'glass')
    # 后面的门（门上一扇小窗）
    p = on_wall(co[3], co[0], co[4], co[7])
    wall_quad(p(0.3, 0.02), p(0.7, 0.02), p(0.7, 0.88), p(0.3, 0.88), 'roof')
    wall_quad(p(0.38, 0.55), p(0.62, 0.55), p(0.62, 0.8), p(0.38, 0.8), 'glass', 0.012)
    # 舱顶出檐
    box(bm, face, x0 - 0.12, -hw - 0.1, top, x1 - lean + 0.18, hw + 0.1, top + 0.07, 'roof')
    # 桅杆、雷达横杆、航行灯
    mx = x0 + 0.5
    cylinder(bm, face, (mx, 0, top + 0.07), (mx, 0, top + 1.7), 0.035, 'metal')
    box(bm, face, mx - 0.04, -0.45, top + 1.2, mx + 0.04, 0.45, top + 1.26, 'metal')
    box(bm, face, mx - 0.35, -0.08, top + 0.55, mx + 0.35, 0.08, top + 0.62, 'dark')
    box(bm, face, mx - 0.06, -0.06, top + 1.7, mx + 0.06, 0.06, top + 1.8, 'nav_white')
    box(bm, face, x1 - lean - 0.1, hw - tuck, top - 0.15, x1 - lean, hw - tuck + 0.06, top - 0.05, 'nav_red')
    box(bm, face, x1 - lean - 0.1, -hw + tuck - 0.06, top - 0.15, x1 - lean, -hw + tuck, top - 0.05, 'nav_green')
    LIGHT_MARKS.append(((mx, 0, top + 1.75), dict(color='#fff6e8', glow=1.6, glowGain=1.6)))
    LIGHT_MARKS.append(((x1 - lean - 0.05, hw - tuck + 0.08, top - 0.1), dict(color='#ff3a30', glow=1.1, glowGain=1.4)))
    LIGHT_MARKS.append(((x1 - lean - 0.05, -hw + tuck - 0.08, top - 0.1), dict(color='#40ff70', glow=1.1, glowGain=1.4)))
    # 排气筒
    cylinder(bm, face, (x0 - 0.18, -0.55, zd + 0.3), (x0 - 0.18, -0.55, top + 0.45), 0.07, 'dark')
    # 救生圈（左舷的舱壁上）
    torus(bm, face, (x0 + 1.2, hw + 0.04, zd + 1.0), (0, 1, 0), 0.24, 0.055, 'orange')
    return zd


def build_fittings(bm, face):
    # 两舷的旧轮胎（防撞垫）
    for x in (-2.6, -0.9, 0.9, 2.3):
        t = (x - XS) / L
        w = half_beam(t)
        z = sheer(t) - 0.3
        for side in (1, -1):
            torus(bm, face, (x, side * (w + 0.1), z), (0, 1, 0), 0.2, 0.08, 'tire')
    # 船头的护栏（三根立柱 + 一道扶手）、锚机
    rail = []
    for x in (2.6, 3.4, 4.1):
        t = (x - XS) / L
        w = half_beam(t) * 0.92
        z = sheer(t)
        for side in (1, -1):
            cylinder(bm, face, (x, side * w, z), (x, side * w, z + 0.55), 0.022, 'metal', seg=6)
        rail.append((x, w, z + 0.55))
    for (xa, wa, za), (xb, wb, zb) in zip(rail, rail[1:]):
        for side in (1, -1):
            cylinder(bm, face, (xa, side * wa, za), (xb, side * wb, zb), 0.02, 'metal', seg=6)
    xa, wa, za = rail[-1]
    cylinder(bm, face, (xa, wa, za), (xa, -wa, za), 0.02, 'metal', seg=6)
    t = (2.0 - XS) / L
    zd = sheer(t) - bulwark(t)
    box(bm, face, 1.7, -0.25, zd, 2.2, 0.25, zd + 0.3, 'dark')
    cylinder(bm, face, (1.95, -0.35, zd + 0.38), (1.95, 0.35, zd + 0.38), 0.12, 'metal')
    # 船尾的小旗
    t = 0.02
    z = sheer(t)
    cylinder(bm, face, (XS + 0.15, 0.9, z), (XS + 0.15, 0.9, z + 1.4), 0.02, 'metal', seg=6)
    flag = [bm.verts.new(p) for p in ((XS + 0.15, 0.9, z + 1.38), (XS - 0.45, 0.9, z + 1.3), (XS - 0.45, 0.9, z + 1.0), (XS + 0.15, 0.9, z + 1.08))]
    face(flag, 'red')
    face(list(reversed([bm.verts.new(v.co + Vector((0, -0.004, 0))) for v in flag])), 'red')


def main():
    sc = fresh_scene('fishing_boat')
    bm = bmesh.new()

    def face(verts, mat, smooth=False):
        verts = list(dict.fromkeys(verts))
        if len(verts) < 3:
            return None
        try:
            f = bm.faces.new(verts)
        except ValueError:
            return None
        f.material_index = MI[mat]
        f.smooth = smooth
        return f

    build_hull(bm, face)
    build_cabin(bm, face)
    build_fittings(bm, face)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    # 面上记的"颜色编号"写成顶点色（面角上的），材质只分油漆 / 玻璃两种
    names = list(COLORS)
    layer = bm.loops.layers.float_color.new('Col')
    for f in bm.faces:
        name = names[f.material_index]
        c = srgb(COLORS[name])
        for loop in f.loops:
            loop[layer] = c
        f.material_index = 2 if name in GLOWS else 1 if name in GLOSSY else 0
    me = bpy.data.meshes.new('fishing_boat')
    bm.to_mesh(me)
    bm.free()
    me.materials.append(PAINT)
    me.materials.append(GLASS)
    me.materials.append(GLOW)
    me.validate()
    obj = bpy.data.objects.new('fishing_boat', me)
    sc.collection.objects.link(obj)
    marks = []
    for i, (pos, props) in enumerate(LIGHT_MARKS):
        e = bpy.data.objects.new(f'light{i}', None)
        sc.collection.objects.link(e)
        e.parent = obj
        e.location = pos
        for k, v in props.items():
            e[k] = v
        e['onAt'] = 0.2
        marks.append(e)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    vl = sc.view_layers[0]
    for o in sc.objects:
        o.select_set(o == obj or o in marks, view_layer=vl)
    vl.objects.active = obj
    with bpy.context.temp_override(**ui_override(), active_object=obj, selected_objects=[obj, *marks]):
        bpy.ops.export_scene.gltf(
            filepath=OUT,
            export_format='GLB',
            use_selection=True,
            export_animations=False,
            export_extras=True,
            # 只导出写好的那一层顶点色，当 COLOR_0（默认会多导一层全白的 COLOR_0，three.js 只认 COLOR_0）
            export_vertex_color='NAME',
            export_vertex_color_name='Col',
            export_all_vertex_colors=False,
            export_yup=True,
            export_apply=False,
        )
    print('exported', OUT, os.path.getsize(OUT), 'bytes,', len(me.polygons), 'faces')


main()
