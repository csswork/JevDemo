"""
GLB 预览：后台导入一个 GLB，按物体分别取景，每个物体从几个角度各渲一张，拼成一张图（检查形状、顶点色、朝向反了的面）。

    blender -b --factory-startup -P scripts/blender/preview_glb.py -- <glb> <out.png> [物体名,物体名…] [角度…]

角度写成 方位角:俯仰角（度，方位角 0 = 从 -Y 看正面，90 = 从 +X 看），默认 "-35:15 145:20"。
和 three.js 一样剔掉背面：朝向反了的面会直接露出后面的东西。
"""
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1 :]
glb, out = argv[0], argv[1]
only = [n for n in argv[2].split(',') if n] if len(argv) > 2 and argv[2] else None
angles = [tuple(float(x) for x in a.split(':')) for a in (argv[3:] or ['-35:15', '145:20'])]

sc = bpy.context.scene
for o in list(sc.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=glb)
for m in bpy.data.materials:
    m.use_backface_culling = True
roots = [o for o in sc.objects if o.parent is None and o.type in ('MESH', 'EMPTY')]
if only:
    roots = [o for o in roots if o.name.split('.')[0] in only]

cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
sc.collection.objects.link(cam)
sc.camera = cam
cam.data.lens = 50
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 3.5
sun.rotation_euler = (math.radians(40), math.radians(10), math.radians(30))
sc.collection.objects.link(sun)
world = bpy.data.worlds.new('w')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.62, 0.7, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
sc.world = world
sc.render.engine = 'BLENDER_EEVEE'
W, Hh = 420, 420
sc.render.resolution_x, sc.render.resolution_y = W, Hh
sc.view_settings.view_transform = 'Standard'

tmp = os.path.join(os.path.dirname(os.path.abspath(out)), '_preview_tmp')
os.makedirs(tmp, exist_ok=True)
tiles = []
for root in roots:
    meshes = [o for o in [root, *root.children_recursive] if o.type == 'MESH']
    for o in sc.objects:
        if o.type == 'MESH':
            o.hide_render = o not in meshes
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for m in meshes:
        for c in m.bound_box:
            w = m.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    center = (lo + hi) / 2
    size = max((hi - lo).length, 0.05)
    for az, el in angles:
        a, e = math.radians(az), math.radians(el)
        d = size * 1.15
        # 方位角 0 = 从 -Y 看
        cam.location = center + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * d
        cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
        path = os.path.join(tmp, f'{len(tiles):03d}.png')
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        tiles.append(path)

cols = len(angles) * 2 if len(tiles) > len(angles) * 2 else len(tiles)
rows = math.ceil(len(tiles) / cols)
sheet = bpy.data.images.new('sheet', W * cols, Hh * rows)
px = [0.2, 0.2, 0.2, 1.0] * (W * cols * Hh * rows)
for i, path in enumerate(tiles):
    img = bpy.data.images.load(path)
    src = list(img.pixels)
    cx, cy = i % cols, rows - 1 - i // cols
    for y in range(Hh):
        d = ((cy * Hh + y) * W * cols + cx * W) * 4
        px[d : d + W * 4] = src[y * W * 4 : (y + 1) * W * 4]
sheet.pixels = px
sheet.filepath_raw = out
sheet.file_format = 'PNG'
sheet.save()
print('preview', out, len(tiles), 'tiles')
