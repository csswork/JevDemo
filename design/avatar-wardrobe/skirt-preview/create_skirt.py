import bpy, math, os, json
from mathutils import Vector
ROOT=os.path.dirname(os.path.abspath(__file__))
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
def material(name,color,rough=.78):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*color,1);p.inputs['Roughness'].default_value=rough;return m
cloth=material('Deep teal woven cloth',(0.035,.12,.135));trim=material('Warm ivory stitched hem',(.61,.57,.43));waist=material('Teal waistband',(.025,.072,.085));gold=material('Brushed brass button',(.5,.31,.12),.45)
N=80;R=13;verts=[];faces=[]
# Blender Z-up. Export converts to glTF Y-up. Coordinates relative to hip.
for j in range(R):
 t=j/(R-1); y=.065-.335*t;rx=.155+.08*t;rz=.106+.071*t
 for i in range(N):
  a=2*math.pi*i/N;fold=math.cos(20*a)*(.002+.010*t)
  verts.append(((rx+fold)*math.cos(a),(rz+fold)*math.sin(a),y))
for j in range(R-1):
 for i in range(N):
  k=(i+1)%N;faces.append((j*N+i,j*N+k,(j+1)*N+k,(j+1)*N+i))
mesh=bpy.data.meshes.new('PleatedSkirtCloth');mesh.from_pydata(verts,[],faces);mesh.update();obj=bpy.data.objects.new('ClothPanel',mesh);bpy.context.collection.objects.link(obj);obj.data.materials.append(cloth);obj.data.materials.append(trim)
for p in mesh.polygons:p.use_smooth=True;p.material_index=1 if p.index//N==R-2 else 0
# A narrow closed waistband, independent from the simulated panel.
v=[];f=[]
for z,rx,ry in [(.072,.159,.110),(.036,.162,.113),(.072,.152,.103),(.036,.155,.106)]:
 for i in range(N):a=2*math.pi*i/N;v.append((rx*math.cos(a),ry*math.sin(a),z))
for i in range(N):
 k=(i+1)%N
 for a,b in [(0,1),(2,0),(1,3),(3,2)]:f.append((a*N+i,a*N+k,b*N+k,b*N+i))
m=bpy.data.meshes.new('Waistband');m.from_pydata(v,[],f);m.update();o=bpy.data.objects.new('Waistband',m);bpy.context.collection.objects.link(o);o.data.materials.append(waist)
for p in m.polygons:p.use_smooth=True
bpy.ops.mesh.primitive_uv_sphere_add(segments=12,ring_count=6,radius=.008,location=(0,-.113,.055));button=bpy.context.object;button.name='WaistButton';button.scale=(1,.45,1);button.data.materials.append(gold)
bpy.ops.wm.save_as_mainfile(filepath=ROOT+'/skirt.blend')
bpy.ops.export_scene.gltf(filepath=ROOT+'/skirt.glb',export_format='GLB',export_yup=True,export_animations=False)
json.dump({'name':'Teal pleated A-line skirt','columns':N,'rows':R,'lengthMeters':.335,'source':'create_skirt.py','license':'Original asset created for this project','physics':'runtime PBD with waist anchors and body capsules'},open(ROOT+'/asset.json','w'),indent=2)
print('SKIRT_EXPORTED')
