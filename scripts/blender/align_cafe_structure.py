"""Align timber supports to actual solid piers of the approved opening schedule."""
import bpy,json
from pathlib import Path
sc=bpy.context.scene;wood=bpy.data.materials['warm oak | fine grain'];walnut=bpy.data.materials['window walnut']
windows=[('window-1',-4.15,1.6,.35,3.05),('entry',-1.9,2.4,0,3.25),('window-2',.8,2.6,.35,3.05),('window-3',3.5,2.2,.35,3.05)]
spans=[(name,cy-w/2,cy+w/2) for name,cy,w,_,_ in windows]
# Four original support rows bisected the apertures. One consistent pier grid
# now controls both sides of the room, all posts, and the overhead crossbeams.
piers=[-5.11]+[(spans[i][2]+spans[i+1][1])/2 for i in range(3)]+[4.73]
for o in list(sc.objects):
 if o.name.startswith(('cross beam','beam wall post')):bpy.data.objects.remove(o,do_unlink=True)
 elif o.name.startswith('wood wainscot cap') and o.location.x<0:
  # The original continuous wall rail also ran across every glazed opening.
  bpy.data.objects.remove(o,do_unlink=True)
def cube(name,loc,size,material):
 bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=size;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(material)
 bevel=o.modifiers.new('soft timber edges','BEVEL');bevel.width=.008;bevel.segments=2
 o.modifiers.new('weighted timber normals','WEIGHTED_NORMAL');return o
checks=[]
for y in piers:
 cube('cross beam',(0,y,3.64),(11.10,.14,.26),walnut)
 for x in [-5.42,5.42]:cube('beam wall post',(x,y,3.51/2),(.16,.14,3.51),wood)
 for name,lo,hi in spans:
  overlap=max(0,min(y+.07,hi)-max(y-.07,lo));checks.append({'pierY':y,'opening':name,'overlapMeters':round(overlap,6)})
  assert overlap<1e-6,(y,name,overlap)
for name,cy,w,sill,h in windows:
 # Outer jamb faces terminate on the aperture edges, preserving the full pier.
 jambs=sorted([o for o in sc.objects if o.name.startswith(name+' jamb')],key=lambda o:o.location.y)
 assert len(jambs)==2
 for o,yy in zip(jambs,[cy-w/2+.05,cy+w/2-.05]):o.location.y=yy;o.dimensions.z=h-.10
 rails=sorted([o for o in sc.objects if o.name.startswith(name+' horizontal frame')],key=lambda o:o.location.z)
 assert len(rails)==2
 for o,z in zip(rails,[sill+.05,sill+h-.05]):o.location.z=z;o.dimensions.y=w
root=Path(__file__).resolve().parents[2];pkg=root/'design/rooms/anime-tide-cafe'
(pkg/'blender/structure-alignment.json').write_text(json.dumps({'coordinateSystem':'Blender Z up','openingSpans':spans,'pierCentersY':piers,'postWidth':.14,'postTop':3.51,'beamUnderside':3.51,'postOpeningOverlapTests':checks,'allPostsClearOfApertures':True,'jambsWithinApertures':True},indent=2)+'\n')
bpy.ops.wm.save_as_mainfile(filepath=str(pkg/'blender/tide-cafe.blend'));print('STRUCTURE_ALIGNED',piers,flush=True)
