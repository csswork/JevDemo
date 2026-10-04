"""Bake the approved authored café and export bounded runtime GLB tiers.
Run against design/rooms/anime-tide-cafe/blender/tide-cafe.blend.
Static diffuse/indirect light is stored in shared atlases; metal/glass remain PBR.
"""
import bpy,math,json,hashlib,sys
from pathlib import Path
from mathutils import Vector,Matrix
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'public/scene/models/anime_cafe';OUT.mkdir(parents=True,exist_ok=True)
PKG=ROOT/'design/rooms/anime-tide-cafe';TMP=PKG/'runtime';TMP.mkdir(exist_ok=True)
sc=bpy.context.scene;dg=bpy.context.evaluated_depsgraph_get()
sc.cycles.samples=16;sc.cycles.use_denoising=True;sc.cycles.max_bounces=5
try:
 prefs=bpy.context.preferences.addons['cycles'].preferences;prefs.compute_device_type='METAL';prefs.get_devices();ok=False
 for d in prefs.devices:d.use=d.type=='METAL';ok=ok or d.use
 if ok:sc.cycles.device='GPU'
except Exception:pass
# Both previews and bake use the authored scene lights / fixture manifest.
sc.render.bake.use_pass_direct=True;sc.render.bake.use_pass_indirect=True;sc.render.bake.use_pass_color=True;sc.render.bake.use_pass_glossy=False;sc.render.bake.use_pass_transmission=False;sc.render.bake.margin=12
orig=list(sc.objects);converted=[];colliders=[]
structures=['structural floor','sealed main ceiling','west window wall','east wall','back wall with true arch','front return wall','nook floor','nook ceiling','nook west wall','nook east wall','nook rear wall']
structure_words=structures+['porcelain tile','ceiling oak boarding','cross beam','beam wall post','nook timber beam','wainscot','wood wainscot']
# Preserve source procedural Generated coordinates and original painting UVs before batching.
for material in bpy.data.materials:
 if not material.use_nodes:continue
 nt=material.node_tree
 for n in list(nt.nodes):
  if n.type=='TEX_COORD':
   for link in list(n.outputs['Generated'].links):
    a=nt.nodes.new('ShaderNodeAttribute');a.attribute_name='AuthoredGenerated';nt.links.new(a.outputs['Vector'],link.to_socket)
  if n.type=='TEX_IMAGE' and not n.inputs['Vector'].is_linked:
   uv=nt.nodes.new('ShaderNodeUVMap');uv.uv_map='AuthoredUV';nt.links.new(uv.outputs['UV'],n.inputs['Vector'])

def getp(m):return m.node_tree.nodes.get('Principled BSDF') if m and m.use_nodes else None
def isglass(m):
 p=getp(m);return m and ('glass' in m.name.lower() or 'glazing' in m.name.lower() or (p and p.inputs['Transmission Weight'].default_value>.5))
def ismetal(m):
 p=getp(m);return p and p.inputs['Metallic'].default_value>.35
# Split faces by runtime class, so a mixed imported prop's glass does not make its opaque body transparent.
for source in orig:
 if source.hide_render or source.type not in {'MESH','CURVE'}:continue
 ev=source.evaluated_get(dg);mesh=ev.to_mesh();data=mesh.copy();ev.to_mesh_clear()
 if not len(data.vertices):bpy.data.meshes.remove(data);continue
 lo=[min(v.co[i] for v in data.vertices) for i in range(3)];hi=[max(v.co[i] for v in data.vertices) for i in range(3)]
 gen=data.attributes.new('AuthoredGenerated','FLOAT_VECTOR','POINT')
 for v,a in zip(data.vertices,gen.data):a.vector=tuple((v.co[i]-lo[i])/max(hi[i]-lo[i],1e-8) for i in range(3))
 if data.uv_layers:data.uv_layers[0].name='AuthoredUV'
 else:data.uv_layers.new(name='AuthoredUV')
 data.transform(source.matrix_world)
 o=bpy.data.objects.new('runtime source '+source.name,data);sc.collection.objects.link(o);o['sourceName']=source.name;converted.append(o)
 # Actual Boolean wall meshes preserve holes for camera collision; furniture uses compact proxies.
 if source.name in structures:
  cm=data.copy();co=bpy.data.objects.new('collision '+source.name,cm);sc.collection.objects.link(co);co['runtimeKind']='collision';co.hide_render=True;colliders.append(co)
 elif any(s in source.name for s in ['counter carcass','counter stone slab','banquette oak base','banquette upholstered back','tabletop']):
  xs=[v.co.x for v in data.vertices];ys=[v.co.y for v in data.vertices];zs=[v.co.z for v in data.vertices]
  bpy.ops.mesh.primitive_cube_add(size=1,location=((min(xs)+max(xs))/2,(min(ys)+max(ys))/2,(min(zs)+max(zs))/2));co=bpy.context.object;co.name='collision '+source.name;co.dimensions=(max(xs)-min(xs),max(ys)-min(ys),max(zs)-min(zs));bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);co['runtimeKind']='collision';co.hide_render=True;colliders.append(co)
# Remove original render geometry, keep authored lights and camera only.
for source in orig:
 if source.type in {'MESH','CURVE','EMPTY'}:bpy.data.objects.remove(source,do_unlink=True)
# Separate by material first, then join by class. Original meshes are multi-slot vertex-colored assets.
separated=[]
for o in converted:
 bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
 if len(o.data.materials)>1:
  old=set(sc.objects);bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.mesh.separate(type='MATERIAL');bpy.ops.object.mode_set(mode='OBJECT');new=[x for x in sc.objects if x not in old];separated.extend([o,*new])
 else:separated.append(o)
groups={};outside_mats={}
for o in separated:
 name=o.get('sourceName','');m=o.data.materials[0] if o.data.materials else None
 if isglass(m):key='glass'
 elif any(s in name for s in ['exterior','terrace','distant sea','far coastal','far blue roof']):
  # Exterior context uses a few uniform PBR materials; do not waste the indoor atlas on a 70m sea plane.
  if m and m.name not in outside_mats:
   nm=bpy.data.materials.new('exterior '+m.name);nm.use_nodes=True;p=nm.node_tree.nodes.get('Principled BSDF');old=getp(m)
   c=old.inputs['Base Color'].default_value[:] if old else (.3,.4,.25,1)
   ramps=[n for n in m.node_tree.nodes if n.type=='VALTORGB'] if m.use_nodes else []
   if ramps:c=tuple(sum(e.color[i] for e in ramps[0].color_ramp.elements)/len(ramps[0].color_ramp.elements) for i in range(4))
   p.inputs['Base Color'].default_value=c;p.inputs['Roughness'].default_value=.75;outside_mats[m.name]=nm
  if m:o.data.materials.clear();o.data.materials.append(outside_mats[m.name])
  key='exterior '+(m.name if m else 'default')
 elif ismetal(m):key='metal '+m.name
 elif any(s in name for s in ['curved leaf',' plant','plant ','hanging ivy','hanging planter']):key='baked-greenery'
 elif any(s in name for s in structure_words):key='baked-shell'
 else:key='baked-interior'
 groups.setdefault(key,[]).append(o)
batches=[]
for name,objs in groups.items():
 bpy.ops.object.select_all(action='DESELECT')
 for o in objs:o.select_set(True)
 bpy.context.view_layer.objects.active=objs[0];bpy.ops.object.join();o=bpy.context.object;o.name=name;o['runtimeKind']='baked' if name.startswith('baked-') else 'glass' if name=='glass' else 'pbr';batches.append(o)
print('BATCHES',[(o.name,len(o.data.polygons)) for o in batches],flush=True)
# Transparent windows and case panes use one standard glTF material, never the authoring shadow-ray mix.
glassmat=bpy.data.materials.new('runtime clear glass');glassmat.use_nodes=True;p=glassmat.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(.82,.91,.94,.15);p.inputs['Alpha'].default_value=.15;p.inputs['Roughness'].default_value=.12;glassmat.surface_render_method='DITHERED';glassmat.use_backface_culling=False
for o in batches:
 if o.get('runtimeKind')=='glass':o.data.materials.clear();o.data.materials.append(glassmat)
atlases=[]
for o in batches:
 if o.get('runtimeKind')!='baked':continue
 resolution=1024 if o.name=='baked-greenery' else 1536
 bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
 bakeuv=o.data.uv_layers.new(name='BakedUV');o.data.uv_layers.active=bakeuv;bakeuv.active_render=True
 bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.uv.smart_project(angle_limit=math.radians(66),island_margin=.002,area_weight=.4);bpy.ops.object.mode_set(mode='OBJECT')
 image=bpy.data.images.new(o.name,width=resolution,height=resolution,alpha=False,float_buffer=True)
 for m in o.data.materials:
  if not m.use_nodes:continue
  n=m.node_tree.nodes.new('ShaderNodeTexImage');n.image=image;m.node_tree.nodes.active=n;n.select=True
 print('BAKE_START',o.name,resolution,flush=True);bpy.ops.object.bake(type='COMBINED');print('BAKE_DONE',o.name,flush=True)
 # Apply the same authored AgX display transform once. Runtime unlit maps do not tone-map twice.
 path=TMP/(o.name+'.png');sc.render.image_settings.file_format='PNG';sc.render.image_settings.color_mode='RGB';sc.render.image_settings.color_depth='8';image.save_render(str(path),scene=sc)
 tex=bpy.data.images.load(str(path),check_existing=False);tex.colorspace_settings.name='sRGB'
 m=bpy.data.materials.new(o.name+' atlas');m.use_nodes=True;nt=m.node_tree;n=nt.nodes.new('ShaderNodeTexImage');n.image=tex;nt.links.new(n.outputs['Color'],nt.nodes.get('Principled BSDF').inputs['Base Color']);nt.nodes.get('Principled BSDF').inputs['Roughness'].default_value=1;m.use_backface_culling=False
 uv=nt.nodes.new('ShaderNodeUVMap');uv.uv_map='BakedUV';nt.links.new(uv.outputs['UV'],n.inputs['Vector']);o.data.materials.clear();o.data.materials.append(m)
 # glTF only needs the baked coordinates for these batches. Preserve original UVs until after baking.
 for layer in list(o.data.uv_layers):
  if layer.name!='BakedUV':o.data.uv_layers.remove(layer)
 o.data.uv_layers.active=o.data.uv_layers[0];atlases.append((tex,resolution))
# Collider meshes are hidden in the renderer by their exported runtimeKind, but retained for ray casting.
cm=bpy.data.materials.new('collision material');cm.diffuse_color=(1,0,0,1)
for o in colliders:o.data.materials.clear();o.data.materials.append(cm)
for o in batches+colliders:o.select_set(True)
for o in sc.objects:
 if o not in batches+colliders:o.select_set(False)
bpy.context.view_layer.objects.active=batches[0]
def export(path):
 bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_extras=True,export_lights=False,export_cameras=False,export_materials='EXPORT',export_animations=False,export_yup=True,export_image_format='AUTO')
 print('EXPORTED',str(path),path.stat().st_size,flush=True)
export(OUT/'room.glb')
for image,res in atlases:image.scale(512 if res==1536 else 256,512 if res==1536 else 256)
export(OUT/'room-low.glb')
triangles=0
for o in batches:o.data.calc_loop_triangles();triangles+=len(o.data.loop_triangles)
fixture=json.loads((PKG/'blender/authoring-metadata.json').read_text())['fixtures']
(OUT/'fixtures.json').write_text(json.dumps({'schema':'anime-cafe.fixtures.v1','coordinateSystem':'Blender Z up','fixtures':fixture},indent=2)+'\n')
manifest={'sourceSha256':hashlib.sha256((PKG/'blender/tide-cafe.blend').read_bytes()).hexdigest(),'method':'authored-lighting diffuse/indirect atlases; live PBR metal/glass','triangles':triangles,'renderBatches':len(batches),'colliders':len(colliders),'decodedAtlasBytes':sum(res*res*4 for _,res in atlases),'tiers':{name:{'file':name,'bytes':(OUT/name).stat().st_size,'sha256':hashlib.sha256((OUT/name).read_bytes()).hexdigest()} for name in ['room.glb','room-low.glb']},'fixturesSha256':hashlib.sha256((OUT/'fixtures.json').read_bytes()).hexdigest(),'formApproval':'user: 看起来不错，加入场景列表看看','sourcePreserved':True}
(TMP/'export-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print('EXPORT_COMPLETE',json.dumps(manifest),flush=True)
