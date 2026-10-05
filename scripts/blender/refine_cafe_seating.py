"""Orient chairs by their real backrests; mount soft linen cushions on the bench."""
import bpy,math,json
from pathlib import Path
from mathutils import Vector,Matrix
root=Path(__file__).resolve().parents[2];pkg=root/'design/rooms/anime-tide-cafe';sc=bpy.context.scene
for o in list(sc.objects):
 if o.name.startswith(('loose cream linen cushion','bench linen pillow','bench pillow seam','exterior tree crown','exterior tree trunk')):
  bpy.data.objects.remove(o,do_unlink=True)
bpy.context.view_layer.update()
chairs=sorted([o for o in sc.objects if o.name.startswith('authored chair')],key=lambda o:o.name)
pads=sorted([o for o in sc.objects if o.name.startswith('sage seat pad')],key=lambda o:o.name)
# Each seat faces its own table; the bench provides the east-side seating.
schedule=[(-3.98,-4.70,-3.98,-4),(-3.05,-4,-3.98,-4),
 (-3.98,-.72,-3.98,-.02),(-3.05,-.02,-3.98,-.02),
 (2.70,-3.55,3.65,-3.55),(3.65,-4.30,3.65,-3.55),
 (2.70,-.20,3.65,-.20),(3.65,.55,3.65,-.20),
 (4,5.75,4,6.5),(4,7.25,4,6.5)]
assert len(chairs)==len(pads)==len(schedule)
audit=[]
for chair,pad,(x,y,tx,ty) in zip(chairs,pads,schedule):
 bpy.context.view_layer.update()
 points=[chair.matrix_world@v.co for v in chair.data.vertices]
 high=[v for v in points if v.z>.63]
 back=sum(high,Vector())/len(high)-chair.location;back.z=0
 desired=Vector((x-tx,y-ty,0)).normalized()
 angle=math.atan2(desired.y,desired.x)-math.atan2(back.y,back.x)
 chair.matrix_world=Matrix.Translation(Vector((x,y,0)))@Matrix.Rotation(angle,4,'Z')@Matrix.Translation(-chair.location)@chair.matrix_world
 pad.location=(x,y,.508);pad.rotation_euler.z=math.atan2(desired.y,desired.x)-math.pi/2
 audit.append({'chair':chair.name,'seat':[x,y],'table':[tx,ty],'forward':[-desired.x,-desired.y]})

m=bpy.data.materials.get('bench soft linen') or bpy.data.materials.new('bench soft linen');m.use_nodes=True
p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Roughness'].default_value=.94;p.inputs['Sheen Weight'].default_value=.28
for n in list(m.node_tree.nodes):
 if n.type=='TEX_IMAGE':m.node_tree.nodes.remove(n)
tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(pkg/'textures/cushion-linen.png'),check_existing=False);tex.image.pack();m.node_tree.links.new(tex.outputs['Color'],p.inputs['Base Color'])
def shape(u,v,side):
 return (side*(.018+.071*(1-u*u)*(1-v*v)),.235*u*math.sqrt(1-.2*v*v),.225*v*math.sqrt(1-.2*u*u))
pillows=[]
for i,y in enumerate((-2.7,-.5,1.0)):
 n=12;verts=[];faces=[]
 for side in (-1,1):
  for j in range(n+1):
   for k in range(n+1):verts.append(shape(-1+2*k/n,-1+2*j/n,side))
 stride=(n+1)**2
 for side in range(2):
  for j in range(n):
   for k in range(n):
    a=side*stride+j*(n+1)+k;f=(a,a+1,a+n+2,a+n+1);faces.append(f if side else f[::-1])
 boundary=list(range(n+1))+[j*(n+1)+n for j in range(1,n+1)]+[n*(n+1)+k for k in range(n-1,-1,-1)]+[j*(n+1) for j in range(n-1,0,-1)]
 for a,b in zip(boundary,boundary[1:]+boundary[:1]):faces.append((a,b,b+stride,a+stride))
 me=bpy.data.meshes.new('soft pillow surface');me.from_pydata(verts,[],faces);me.update();uv=me.uv_layers.new(name='AuthoredUV')
 for loop in me.loops:
  v=me.vertices[loop.vertex_index].co;uv.data[loop.index].uv=(v.y/.47+.5,v.z/.45+.5)
 o=bpy.data.objects.new('bench linen pillow '+str(i),me);sc.collection.objects.link(o);me.materials.append(m)
 for f in me.polygons:f.use_smooth=True
 o.rotation_euler.y=.18
 bpy.context.view_layer.update();points=[o.matrix_world@v.co for v in me.vertices]
 o.location=(5.279-max(v.x for v in points),y,.559-min(v.z for v in points))
 seam=bpy.data.curves.new('pillow stitched piping','CURVE');seam.dimensions='3D';seam.bevel_depth=.0025;seam.bevel_resolution=2
 sp=seam.splines.new('POLY');sp.points.add(len(boundary)-1);sp.use_cyclic_u=True
 for point,index in zip(sp.points,boundary):
  v=me.vertices[index].co;point.co=(0,v.y,v.z,1)
 so=bpy.data.objects.new('bench pillow seam '+str(i),seam);sc.collection.objects.link(so);so.matrix_world=o.matrix_world.copy();so.data.materials.append(m)
 bpy.context.view_layer.update();points=[o.matrix_world@v.co for v in me.vertices]
 assert abs(min(v.z for v in points)-.559)<.001
 assert abs(max(v.x for v in points)-5.279)<.001
 pillows.append({'id':o.name,'bottomZ':min(v.z for v in points),'backContactX':max(v.x for v in points)})
(pkg/'blender/seating-refinement.json').write_text(json.dumps({'chairs':audit,'pillows':pillows,'removedBallTrees':True},indent=2)+'\n')
bpy.ops.wm.save_as_mainfile(filepath=str(pkg/'blender/tide-cafe.blend'))
print('SEATING_REFINED: ten table-facing chairs, three supported linen pillows; ball trees removed',flush=True)
