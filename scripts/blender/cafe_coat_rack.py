"""Cafe entrance: walnut bentwood coat rack, authored in Blender, 1.75 m high.

Run with Blender -b --factory-startup -P scripts/blender/cafe_coat_rack.py,
or run this file through Blender MCP. Exports only the rack, without preview lights.
"""
import math
import os

import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public/scene/models/cafe/coat_rack.glb')


def material(name, color, roughness, metallic=0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    rgb = tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in color)
    mat.diffuse_color = (*rgb, 1)
    node = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    node.inputs['Base Color'].default_value = (*rgb, 1)
    node.inputs['Roughness'].default_value = roughness
    node.inputs['Metallic'].default_value = metallic
    return mat


def build(export_file=True):
    # A new scene keeps existing open models available.
    scene = bpy.context.scene if bpy.app.background else bpy.data.scenes.new('Cafe_Walnut_Coat_Rack')
    if not bpy.app.background and bpy.context.window_manager.windows:
        bpy.context.window_manager.windows[0].scene = scene
    verts, faces, slots = [], [], []

    def surface(rings, slot):
        start = len(verts)
        width = len(rings[0])
        verts.extend(p for ring in rings for p in ring)
        for j in range(len(rings) - 1):
            for i in range(width):
                a = start + j * width + i
                b = start + j * width + (i + 1) % width
                faces.append((a, b, b + width, a + width))
                slots.append(slot)
        faces.extend([tuple(start + i for i in reversed(range(width))),
                      tuple(start + (len(rings) - 1) * width + i for i in range(width))])
        slots.extend([slot, slot])

    def lathe(profile, slot=0, segments=24):
        surface([[(r * math.cos(i * math.tau / segments), r * math.sin(i * math.tau / segments), z)
                  for i in range(segments)] for r, z in profile], slot)

    def tube(points, radius, angle, slot=0, segments=10):
        # All bends are planar; this frame stays stable around the curve.
        path = [Vector((r * math.cos(angle), r * math.sin(angle), z)) for r, z in points]
        side = Vector((-math.sin(angle), math.cos(angle), 0))
        rings = []
        for j, p in enumerate(path):
            tangent = (path[min(j + 1, len(path) - 1)] - path[max(j - 1, 0)]).normalized()
            other = tangent.cross(side).normalized()
            taper = radius * (1 - 0.15 * j / (len(path) - 1))
            rings.append([tuple(p + taper * (side * math.cos(i * math.tau / segments)
                                             + other * math.sin(i * math.tau / segments)))
                          for i in range(segments)])
        surface(rings, slot)

    def bezier(a, b, c, d, count=18):
        return [tuple((1-t)**3*a[k] + 3*(1-t)**2*t*b[k] + 3*(1-t)*t*t*c[k] + t**3*d[k]
                      for k in range(2)) for t in [i / count for i in range(count + 1)]]

    # Turned central column with a small finial and brass joint collars.
    lathe([(0.043, 0.08), (0.048, 0.14), (0.044, 0.24), (0.034, 0.32),
           (0.030, 1.24), (0.037, 1.30), (0.039, 1.46), (0.030, 1.57),
           (0.026, 1.62), (0.036, 1.65), (0.040, 1.68), (0.031, 1.71), (0.003, 1.73)])
    for z, r in [(0.27, 0.041), (1.28, 0.039), (1.47, 0.038)]:
        lathe([(r-0.003, z), (r, z+0.004), (r, z+0.017), (r-0.003, z+0.021)], 1)
    for i in range(4):
        angle = math.pi / 4 + i * math.pi / 2
        tube(bezier((0.026, 0.32), (0.15, 0.29), (0.22, 0.025), (0.33, 0.025)), 0.024, angle)
    # Six long upward-returning hooks: rounded continuous bentwood silhouettes.
    for i in range(6):
        angle = i * math.tau / 6
        curve = bezier((0.026, 1.39), (0.14, 1.38), (0.30, 1.53), (0.30, 1.65))
        curve += bezier((0.30, 1.65), (0.30, 1.75), (0.20, 1.76), (0.195, 1.68), 12)[1:]
        tube(curve, 0.018, angle, segments=12)
    for i in range(3):
        tube(bezier((0.025, 1.03), (0.12, 1.02), (0.19, 1.08), (0.18, 1.16)),
             0.014, math.pi / 6 + i * math.tau / 3)

    # Normalize the mesh itself to exactly 1.75 m, with its feet at z=0.
    low = min(v[2] for v in verts)
    scale = 1.75 / (max(v[2] for v in verts) - low)
    verts = [(x*scale, y*scale, (z-low)*scale) for x, y, z in verts]
    mesh = bpy.data.meshes.new('CafeCoatRackMesh')
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(material('CafeRack_Walnut', (0.40, 0.235, 0.135), 0.36))
    mesh.materials.append(material('CafeRack_Brass', (0.65, 0.49, 0.25), 0.3, 0.72))
    for face, slot in zip(mesh.polygons, slots):
        face.material_index = slot
        face.use_smooth = len(face.vertices) == 4
    mesh.update()
    obj = bpy.data.objects.new('Cafe_Walnut_Coat_Rack', mesh)
    scene.collection.objects.link(obj)
    obj['description'] = 'Original walnut bentwood coat rack for the cafe entrance'
    for existing in scene.objects:
        existing.select_set(False, view_layer=scene.view_layers[0])
    obj.select_set(True, view_layer=scene.view_layers[0])
    scene.view_layers[0].objects.active = obj
    if export_file:
        export_model(scene, obj)
    mesh.calc_loop_triangles()
    print({'exported': OUT if export_file else None, 'triangles': len(mesh.loop_triangles), 'dimensions': list(obj.dimensions)})
    return scene, obj


def export_model(scene, obj):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    context = {}
    for window in bpy.context.window_manager.windows:
        if window.scene == scene:
            context['window'] = window
            context['screen'] = window.screen
            for area in window.screen.areas:
                if area.type == 'VIEW_3D':
                    context.update(area=area, region=next(r for r in area.regions if r.type == 'WINDOW'))
                    break
            break
    with bpy.context.temp_override(**context):
        scene.view_layers[0].update()
        bpy.ops.export_scene.gltf(filepath=OUT, use_selection=True, export_animations=False, export_extras=True)


if __name__ == '__main__':
    build()
