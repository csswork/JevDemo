"""Deterministic, sparse exterior arrangement for the authored café source."""
import bpy,math
from mathutils import Vector
from pathlib import Path
sc=bpy.context.scene
for o in list(sc.objects):
 if o.name.startswith(('exterior tree','far coastal','far blue roof')):bpy.data.objects.remove(o,do_unlink=True)
wood=bpy.data.materials.get('window walnut');plaster=bpy.data.materials.get('warm plaster');roof=bpy.data.materials.get('blue black metal');leaves=[bpy.data.materials.get('leaf '+str(i)) for i in range(5)]
def cube(name,loc,size,material):
 bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=size;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(material);return o
window=bpy.data.materials.get('coastal window blue') or bpy.data.materials.new('coastal window blue');window.use_nodes=True;p=window.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(.075,.18,.23,1);p.inputs['Roughness'].default_value=.28
# A shared shoreline supports the houses rather than leaving boxes above water.
cube('far coastal shore',(-25.3,3,-.36),(5.2,26,.32),plaster)
for i,y in enumerate([-7,-3,1,5,9,13]):
 h=[2.2,2.6,2.3,2.8,2.4,2.2][i];x=-25-(i%2)*.6
 cube('far coastal house',(x,y,h/2-.25),(2.3,2.6,h),plaster)
 w,d=2.65,2.9;z=h-.25
 vertices=[(x-w/2,y-d/2,z),(x+w/2,y-d/2,z),(x,y-d/2,z+.5),(x-w/2,y+d/2,z),(x+w/2,y+d/2,z),(x,y+d/2,z+.5)]
 me=bpy.data.meshes.new('coastal pitched roof');me.from_pydata(vertices,[],[(2,1,0),(3,4,5),(0,1,4,3),(0,3,5,2),(1,2,5,4)]);me.update();o=bpy.data.objects.new('far blue roof',me);sc.collection.objects.link(o);o.data.materials.append(roof)
 for yy in [y-.65,y+.65]:
  cube('far coastal window frame',(x+1.16,yy,1.1),(.04,.64,.82),roof)
  cube('far coastal window',(x+1.185,yy,1.1),(.02,.53,.7),window)
 cube('far coastal door',(x+1.17,y,.5),(.04,.48,1),wood)
for i,y in enumerate([-3.8,1.1,6.0]):
 x=-10.2
 bpy.ops.mesh.primitive_cylinder_add(vertices=16,radius=.12,depth=2.9,location=(x,y,1.45));o=bpy.context.object;o.name='exterior tree trunk';o.data.materials.append(wood)
 # Overlapping solid foliage volumes form coherent crowns instead of hundreds
 # of floating randomly tilted leaf cards.
 for j,(dx,dy,dz,sx,sy,sz) in enumerate([(-.55,0,3.4,.9,1.05,.9),(.55,.05,3.45,.9,1,.9),(0,-.6,3.55,1,.85,.9),(0,.6,3.55,1,.85,.9),(0,0,4.1,.95,1.05,.8)]):
  bpy.ops.mesh.primitive_uv_sphere_add(segments=20,ring_count=12,radius=1,location=(x+dx,y+dy,dz));o=bpy.context.object;o.name='exterior tree crown';o.scale=(sx,sy,sz);o.data.materials.append(leaves[(i+j)%3+1]);
  for face in o.data.polygons:face.use_smooth=True
 bpy.ops.mesh.primitive_cube_add(size=1,location=(x,y,.22));o=bpy.context.object;o.name='exterior tree planter';o.dimensions=(1.1,1.1,.44);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(plaster)
root=Path(__file__).resolve().parents[2];bpy.ops.wm.save_as_mainfile(filepath=str(root/'design/rooms/anime-tide-cafe/blender/tide-cafe.blend'))
print('EXTERIOR_REFINED',flush=True)
