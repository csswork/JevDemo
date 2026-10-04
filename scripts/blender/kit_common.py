"""
街景模型脚本共用的小工具（Blender 5.2，后台跑：blender -b --factory-startup -P scripts/blender/xxx.py）。

各脚本开头：
    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from kit_common import *

约定（和 seagull.py / fishing_boat.py 一样，见 README 街景一节）：
  - 颜色写进面角上的顶点色 'Col'（一个面一个颜色），导出成 COLOR_0；材质只按"质感"分几个槽，
    槽的名字就是 three.js 那边换材质的依据（street.ts 的 propMaterial）：
        paint     刷漆 / 塑料（顶点色，粗糙度中等）
        metal     铁件（顶点色，有金属感）
        wood      木头（街景的木纹 PBR，uv 按米）
        concrete  混凝土（街景的混凝土 PBR，uv 按米）
        glass     深色的光滑玻璃
        glow      夜里才亮的灯（白天是顶点色的灯罩颜色，天黑了自发光 = 顶点色）
        lightbox  一直亮着的灯箱（售货机的面板，夜里更亮）
        board     黑板面（uv 0..1，three.js 那边换成 canvas 画的黑板）
        pane      房子窗户的玻璃（three.js 那边换成室内映射的玻璃，能看见屋里）
        frost     毛玻璃 / 纸拉门（白天是顶点色，夜里按营业时间从里面透出光）
        fabric    布（暖帘、遮阳篷）
        tile      瓦（街景的屋瓦材质，乘上每栋房子的瓦色）
        plaster   灰泥墙（街景的墙面材质，uv 按米，顶点色是墙色）
        clear     透明玻璃（后面是真的 3D 店内：她身边那家咖啡店的一楼）
        wall/roof 对岸小镇房子的墙、屋顶（代码给每栋换一个颜色）
  - uv：除了 board，全部按米做盒子投影（每个面按法线最接近的轴，取另外两个坐标），和街景的 PBR 材质"按米铺"一致
  - 光源位置：在模型上挂一个空物体（名字 light…），自定义属性写颜色、强度、照多远、光晕大小，
    导出时带上（export_extras），three.js 那边从 userData 读出来登记成光源（streetLights.ts）
  - 坐标：Blender Z 朝上；glTF 导出后 Y 朝上，Blender 的 -Y 变成 three 的 +Z。
    街边的东西"正面朝 -Y"建模（three 里正面朝 +Z，street.ts 的 frameAt 就是让 +Z 朝着路）
"""
import math
import os
from contextlib import contextmanager

import bmesh
import bpy
from mathutils import Matrix, Vector

try:
    HERE = os.path.dirname(os.path.abspath(__file__))
except NameError:
    HERE = os.path.abspath('scripts/blender')
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
MODELS = os.path.join(REPO, 'public', 'scene', 'models')

SLOTS = ['paint', 'metal', 'wood', 'concrete', 'glass', 'glow', 'lightbox', 'board']
SLOT_LOOK = {
    'paint': (0.6, 0.0),
    'metal': (0.42, 0.55),
    'wood': (0.8, 0.0),
    'concrete': (0.9, 0.0),
    'glass': (0.08, 0.0),
    'glow': (0.4, 0.0),
    'lightbox': (0.5, 0.0),
    'board': (0.9, 0.0),
    'pane': (0.06, 0.0),
    'frost': (0.5, 0.0),
    'fabric': (0.95, 0.0),
    'tile': (0.7, 0.0),
    'plaster': (0.9, 0.0),
    'clear': (0.04, 0.0),
    'wall': (0.9, 0.0),
    'roof': (0.7, 0.0),
}


def fresh_scene(name):
    """有界面时单独建一个场景并切过去（不动用户打开的场景）；后台模式用当前场景。清空重来"""
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
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == 'VIEW_3D':
                region = next((r for r in area.regions if r.type == 'WINDOW'), None)
                return dict(window=win, screen=win.screen, area=area, region=region)
    return {}


def srgb(hex_color):
    """'#rrggbb' → 线性空间的 RGBA"""
    h = hex_color.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i : i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, 1.0)


def slot_material(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    rough, metal = SLOT_LOOK[name]
    bsdf.inputs['Base Color'].default_value = (1, 1, 1, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    return m


class Builder:
    """
    攒一个网格：face / box / cyl / lathe / sphere / torus / prism，颜色用名字（colors 里的 '#rrggbb'），
    slot 按颜色名查（slots 里没写的是 paint）。with b.at(矩阵): 里面建的东西都乘这个变换（可以嵌套）
    """

    def __init__(self, colors, slots=None):
        self.colors = colors
        self.slots = slots or {}
        self.names = list(colors)
        self.bm = bmesh.new()
        self.M = Matrix.Identity(4)
        self.face_color = {}
        self.face_uv = {}

    @contextmanager
    def at(self, M):
        prev = self.M
        self.M = prev @ M
        try:
            yield
        finally:
            self.M = prev

    def v(self, p):
        return self.bm.verts.new(self.M @ Vector(p))

    def face(self, verts, color, smooth=False, uv=None):
        try:
            f = self.bm.faces.new(verts)
        except ValueError:
            return None
        f.smooth = smooth
        self.face_color[f] = color
        if uv is not None:
            self.face_uv[f] = uv
        return f

    def quad(self, a, b, c, d, color, smooth=False, uv=None):
        return self.face([self.v(a), self.v(b), self.v(c), self.v(d)], color, smooth, uv)

    def box(self, x0, y0, z0, x1, y1, z1, color, faces='all'):
        vs = [self.v(p) for p in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
        quads = {'-z': (0, 3, 2, 1), '+z': (4, 5, 6, 7), '-y': (0, 1, 5, 4), '+x': (1, 2, 6, 5), '+y': (2, 3, 7, 6), '-x': (3, 0, 4, 7)}
        for k, q in quads.items():
            if faces == 'all' or k in faces:
                self.face([vs[i] for i in q], color)

    def cyl(self, p0, p1, r0, color, r1=None, seg=12, caps=True, smooth=True, cap_color=None):
        """圆柱 / 圆台：p0 → p1，半径 r0 → r1"""
        r1 = r0 if r1 is None else r1
        a, b = Vector(p0), Vector(p1)
        axis = (b - a).normalized()
        up = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
        u = axis.cross(up).normalized()
        w = axis.cross(u)
        ra, rb = [], []
        for k in range(seg):
            ang = 2 * math.pi * k / seg
            d = u * math.cos(ang) + w * math.sin(ang)
            ra.append(self.v(a + d * r0))
            rb.append(self.v(b + d * r1))
        for k in range(seg):
            self.face((ra[k], ra[(k + 1) % seg], rb[(k + 1) % seg], rb[k]), color, smooth)
        if caps:
            self.face(list(reversed(ra)), cap_color or color)
            self.face(rb, cap_color or color)

    def lathe(self, profile, color, seg=16, smooth=True, close_bottom=True, close_top=True):
        """
        绕 Z 轴转一圈：profile = [(半径, 高度), ...] 从下往上；color 可以是一个名字，或者每一段一个名字的列表。
        半径为 0 的点收成一个尖（顶上的尖顶、灯罩的顶）
        """
        rings = []
        for r, z in profile:
            if r <= 1e-6:
                rings.append([self.v((0, 0, z))])
            else:
                rings.append([self.v((r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg), z)) for k in range(seg)])
        for i in range(len(rings) - 1):
            c = color[i] if isinstance(color, (list, tuple)) else color
            A, B = rings[i], rings[i + 1]
            for k in range(seg):
                if len(A) == 1 and len(B) == 1:
                    continue
                if len(A) == 1:
                    self.face((A[0], B[(k + 1) % seg], B[k]), c, smooth)
                elif len(B) == 1:
                    self.face((A[k], A[(k + 1) % seg], B[0]), c, smooth)
                else:
                    self.face((A[k], A[(k + 1) % seg], B[(k + 1) % seg], B[k]), c, smooth)
        c0 = color[0] if isinstance(color, (list, tuple)) else color
        c1 = color[-1] if isinstance(color, (list, tuple)) else color
        if close_bottom and len(rings[0]) > 1:
            self.face(list(reversed(rings[0])), c0)
        if close_top and len(rings[-1]) > 1:
            self.face(rings[-1], c1)

    def sphere(self, c, r, color, seg=16, rings=8, smooth=True, scale=(1, 1, 1)):
        c = Vector(c)
        sx, sy, sz = scale
        prof = [(r * math.sin(math.pi * i / rings), -r * math.cos(math.pi * i / rings)) for i in range(rings + 1)]
        with self.at(Matrix.Translation(c) @ Matrix.Diagonal((sx, sy, sz, 1))):
            self.lathe(prof, color, seg, smooth, close_bottom=False, close_top=False)

    def torus(self, c, R, r, color, seg=16, rseg=8, axis='z'):
        rot = {'z': Matrix.Identity(4), 'x': Matrix.Rotation(math.pi / 2, 4, 'Y'), 'y': Matrix.Rotation(math.pi / 2, 4, 'X')}[axis]
        with self.at(Matrix.Translation(Vector(c)) @ rot):
            grid = []
            for i in range(seg):
                a = 2 * math.pi * i / seg
                grid.append(
                    [
                        self.v(((R + r * math.cos(2 * math.pi * j / rseg)) * math.cos(a), (R + r * math.cos(2 * math.pi * j / rseg)) * math.sin(a), r * math.sin(2 * math.pi * j / rseg)))
                        for j in range(rseg)
                    ]
                )
            for i in range(seg):
                for j in range(rseg):
                    a, b = grid[i][j], grid[(i + 1) % seg][j]
                    cc, d = grid[(i + 1) % seg][(j + 1) % rseg], grid[i][(j + 1) % rseg]
                    self.face((a, b, cc, d), color, True)

    def prism(self, pts, z0, z1, color, side_color=None):
        """平面上的多边形（逆时针，xy）沿 z 拉伸成柱体"""
        bot = [self.v((x, y, z0)) for x, y in pts]
        top = [self.v((x, y, z1)) for x, y in pts]
        self.face(list(reversed(bot)), color)
        self.face(top, color)
        n = len(pts)
        for k in range(n):
            self.face((bot[k], bot[(k + 1) % n], top[(k + 1) % n], top[k]), side_color or color)

    def finish(self, sc, name, recalc=False, merge=1e-5):
        """建成一个物体：顶点色写进 'Col'、按颜色名分材质槽、盒子投影的 uv（米）"""
        bm = self.bm
        if merge:
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge)
        if recalc:
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        col = bm.loops.layers.float_color.new('Col')
        uvl = bm.loops.layers.uv.new('UVMap')
        used = []
        for f in bm.faces:
            cname = self.face_color.get(f, self.names[0])
            slot = self.slots.get(cname, 'paint')
            if slot not in used:
                used.append(slot)
            f.material_index = used.index(slot)
            rgba = srgb(self.colors[cname])
            n = f.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            custom = self.face_uv.get(f)
            for k, loop in enumerate(f.loops):
                loop[col] = rgba
                if custom is not None:
                    loop[uvl].uv = custom[k]
                else:
                    p = loop.vert.co
                    loop[uvl].uv = (p.y, p.z) if ax == 0 else (p.x, p.z) if ax == 1 else (p.x, p.y)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for s in used:
            me.materials.append(slot_material(s))
        me.validate()
        obj = bpy.data.objects.new(name, me)
        sc.collection.objects.link(obj)
        return obj


def anchor(sc, parent, name, loc, **props):
    """光源位置：一个空物体（挂在 parent 下，loc 是 parent 的局部坐标），自定义属性导出成 glTF 的 extras"""
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.1
    sc.collection.objects.link(e)
    e.parent = parent
    e.location = loc
    for k, v in props.items():
        e[k] = v
    return e


def export(sc, path, objects):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    vl = sc.view_layers[0]
    keep = set(objects)
    for o in objects:
        keep.update(o.children_recursive)
    for o in sc.objects:
        o.select_set(o in keep, view_layer=vl)
    vl.objects.active = objects[0]
    with bpy.context.temp_override(**ui_override(), active_object=objects[0], selected_objects=list(keep)):
        bpy.ops.export_scene.gltf(
            filepath=path,
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
    faces = sum(len(o.data.polygons) for o in keep if o.type == 'MESH')
    print('exported', path, os.path.getsize(path), 'bytes,', faces, 'faces,', len([o for o in keep if o.type == 'MESH']), 'meshes')
