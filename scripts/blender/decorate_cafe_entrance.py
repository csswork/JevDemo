"""Mount double-sided welcome artwork on the existing A-frame's actual faces."""
import bpy
from pathlib import Path
from mathutils import Vector

root=Path(__file__).resolve().parents[2]
pkg=root/'design/rooms/anime-tide-cafe'
for o in list(bpy.context.scene.objects):
 if o.name.startswith(('A-frame chalk insert','entrance chalk artwork','entrance brass fixing')):
  bpy.data.objects.remove(o,do_unlink=True)
material=bpy.data.materials.get('entrance illustrated chalkboard') or bpy.data.materials.new('entrance illustrated chalkboard')
material.use_nodes=True
nt=material.node_tree
for n in list(nt.nodes):
 if n.type=='TEX_IMAGE':nt.nodes.remove(n)
image=bpy.data.images.load(str(pkg/'textures/entrance-chalkboard.png'),check_existing=False);image.pack()
tex=nt.nodes.new('ShaderNodeTexImage');tex.image=image
p=nt.nodes.get('Principled BSDF');nt.links.new(tex.outputs['Color'],p.inputs['Base Color']);p.inputs['Roughness'].default_value=.9
bpy.context.view_layer.update()
boards=sorted([o for o in bpy.context.scene.objects if o.name.startswith('A-frame oak board')],key=lambda o:o.location.y)
assert len(boards)==2
for i,board in enumerate(boards):
 side=-1 if i==0 else 1
 # Plane sits 1 mm out from the 65 mm wooden panel face, with a timber border.
 verts=[(-.27,side*.0335,-.36),(.27,side*.0335,-.36),(.27,side*.0335,.48),(-.27,side*.0335,.48)]
 if side==1:verts.reverse()
 me=bpy.data.meshes.new('entrance chalk artwork');me.from_pydata(verts,[],[(0,1,2,3)]);me.update()
 uv=me.uv_layers.new(name='AuthoredUV')
 for loop in me.loops:
  v=me.vertices[loop.vertex_index].co
  uv.data[loop.index].uv=((v.x/.54+.5) if side==-1 else (.5-v.x/.54),(v.z+.36)/.84)
 o=bpy.data.objects.new('entrance chalk artwork '+str(i),me);bpy.context.scene.collection.objects.link(o);o.matrix_world=board.matrix_world.copy();me.materials.append(material)
 for x in (-.294,.294):
  for z in (-.395,.515):
   bpy.ops.mesh.primitive_uv_sphere_add(segments=8,ring_count=4,radius=1)
   pin=bpy.context.object;pin.name='entrance brass fixing';pin.location=board.matrix_world@Vector((x,side*.034,z));pin.rotation_euler=board.rotation_euler;pin.scale=(.007,.003,.007);pin.data.materials.append(bpy.data.materials['aged brass'])
bpy.ops.wm.save_as_mainfile(filepath=str(pkg/'blender/tide-cafe.blend'))
print('ENTRANCE_DECORATION_COMPLETE: two mounted illustrated faces, eight brass fixings',flush=True)
