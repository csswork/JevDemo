"""Export the approved Blender room using clean reusable PBR textures.
No room-wide light/color atlas: geometry, vertex colors, artwork UVs and
per-object material UVs survive export. Lighting remains editable at runtime.
"""
import bpy,math,json,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'public/scene/models/anime_cafe';OUT.mkdir(parents=True,exist_ok=True)
PKG=ROOT/'design/rooms/anime-tide-cafe';TMP=PKG/'runtime';TMP.mkdir(exist_ok=True)
sc=bpy.context.scene;dg=bpy.context.evaluated_depsgraph_get()
orig=list(sc.objects);converted=[];colliders=[]
structures=['structural floor','sealed main ceiling','west window wall','east wall','back wall with true arch','front return wall','nook floor','nook ceiling','nook west wall','nook east wall','nook rear wall']
procedural={};images={}
for material in bpy.data.materials:
 if not material.use_nodes:continue
 nt=material.node_tree;p=nt.nodes.get('Principled BSDF')
 if not p:continue
 for node in nt.nodes:
  if node.type=='VERTEX_COLOR' and not node.layer_name:node.layer_name='Color'
 material['usesVertexColors']=any(n.type=='VERTEX_COLOR' and n.outputs['Color'].is_linked for n in nt.nodes)
 name=material.name
 if any(n.type=='TEX_NOISE' for n in nt.nodes):
  family='oak' if name.startswith('warm oak') else 'walnut' if name.startswith('window walnut') else 'fabric' if 'upholstery' in name else 'stone' if 'countertop' in name else 'plaster'
  if family not in images:images[family]=bpy.data.images.load(str(PKG/'textures'/('runtime-'+family+'.png')))
  texture=nt.nodes.new('ShaderNodeTexImage');texture.image=images[family];texture.extension='REPEAT'
  nt.links.new(texture.outputs['Color'],p.inputs['Base Color'])
  if name.startswith('porcelain variation'):
   ramp=next(n for n in nt.nodes if n.type=='VALTORGB');tint=tuple(sum(e.color[i] for e in ramp.color_ramp.elements)/2 for i in range(4))
   # Glazed tiles are a calm uniform palette with no fake grime or shared atlas.
   for link in list(p.inputs['Base Color'].links):nt.links.remove(link)
   p.inputs['Base Color'].default_value=tint;p.inputs['Roughness'].default_value=.38
  else:procedural[name]=family
  for link in list(p.inputs['Normal'].links):nt.links.remove(link)
 if 'glass' in name.lower() or 'glazing' in name.lower():
  output=next(n for n in nt.nodes if n.type=='OUTPUT_MATERIAL');nt.links.new(p.outputs['BSDF'],output.inputs['Surface'])
  p.inputs['Transmission Weight'].default_value=0;p.inputs['Alpha'].default_value=.12;p.inputs['Roughness'].default_value=.12;material.surface_render_method='DITHERED'
 # Preserve actual menu/painting UVs rather than treating them as procedural grain.
 for n in list(nt.nodes):
  if n.type=='TEX_IMAGE' and not n.inputs['Vector'].is_linked:
   uv=nt.nodes.new('ShaderNodeUVMap');uv.uv_map='AuthoredUV';nt.links.new(uv.outputs['UV'],n.inputs['Vector'])
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
 uv=data.uv_layers[0]
 # Project each original object before joining. Every plank reuses a full wood
 # texture instead of receiving a handful of pixels from an entire-room atlas.
 for face in data.polygons:
  material=data.materials[face.material_index] if data.materials else None
  if not material or material.name not in procedural:continue
  normal=face.normal;omit=max(range(3),key=lambda i:abs(normal[i]));axes=[i for i in range(3) if i!=omit]
  # Grain follows each plank's long axis, including horizontal shelves.
  if procedural[material.name] in {'oak','walnut'}:axes.sort(key=lambda i:hi[i]-lo[i])
  for loop in face.loop_indices:
   co=data.vertices[data.loops[loop].vertex_index].co
   uv.data[loop].uv=tuple((co[i]-lo[i])/max(hi[i]-lo[i],1e-8) for i in axes)
 data.uv_layers.active=uv;uv.active_render=True
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
groups={}
for o in separated:
 if not len(o.data.polygons):continue
 index=o.data.polygons[0].material_index;m=o.data.materials[index] if o.data.materials else None
 key=m.name if m else 'unpainted'
 source_name=o.get('sourceName','')
 if m and ('glass' in m.name.lower() or 'glazing' in m.name.lower()) and (source_name.startswith(('entry glass','window-')) or source_name=='nook rear glass'):
  key='window privacy glazing'
 groups.setdefault(key,[]).append(o)
 # Material separation can retain unused slots; use the face's actual material.
 if m:
  o.data.materials.clear();o.data.materials.append(m)
  for face in o.data.polygons:face.material_index=0
batches=[]
for name,objects in groups.items():
 bpy.ops.object.select_all(action='DESELECT')
 for o in objects:o.select_set(True)
 bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();o=bpy.context.object;o.name='surface '+name;o['runtimeKind']='window-glass' if name=='window privacy glazing' else 'glass' if any(s in name.lower() for s in ['glass','glazing']) else 'pbr';batches.append(o)
cm=bpy.data.materials.new('collision material');cm.diffuse_color=(1,0,0,1)
for o in colliders:o.data.materials.clear();o.data.materials.append(cm)
for o in sc.objects:o.select_set(o in batches+colliders)
bpy.context.view_layer.objects.active=batches[0]
def export(path):
 bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_extras=True,export_lights=False,export_cameras=False,export_materials='EXPORT',export_animations=False,export_yup=True,export_image_format='AUTO')
 print('EXPORTED',str(path),path.stat().st_size,flush=True)
for o in batches:o.data.calc_loop_triangles()
high_triangles=sum(len(o.data.loop_triangles) for o in batches)
export(OUT/'room.glb')
for image in images.values():image.scale(256,256)
for o in batches:
 if o.get('runtimeKind') in {'glass','window-glass'}:continue
 modifier=o.modifiers.new('Low tier geometric reduction','DECIMATE');modifier.ratio=.45
 bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=modifier.name)
export(OUT/'room-low.glb')
for o in batches:o.data.calc_loop_triangles()
low_triangles=sum(len(o.data.loop_triangles) for o in batches)
fixture=json.loads((PKG/'blender/authoring-metadata.json').read_text())['fixtures']
(OUT/'fixtures.json').write_text(json.dumps({'schema':'anime-cafe.fixtures.v1','coordinateSystem':'Blender Z up','fixtures':fixture},indent=2)+'\n')
manifest={'sourceSha256':hashlib.sha256((PKG/'blender/tide-cafe.blend').read_bytes()).hexdigest(),'method':'reusable PBR material textures, per-object UV projection, preserved artwork and vertex colors; runtime lights','triangles':high_triangles,'lowTriangles':low_triangles,'renderBatches':len(batches),'colliders':len(colliders),'tiers':{name:{'file':name,'bytes':(OUT/name).stat().st_size,'sha256':hashlib.sha256((OUT/name).read_bytes()).hexdigest()} for name in ['room.glb','room-low.glb']},'fixturesSha256':hashlib.sha256((OUT/'fixtures.json').read_bytes()).hexdigest(),'formApproval':'user: 看起来不错，加入场景列表看看','sourcePreserved':True}
(TMP/'export-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print('EXPORT_COMPLETE',json.dumps(manifest),flush=True)
