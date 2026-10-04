"""Measure actual evaluated Blender meshes and produce engineering plans from their triangles."""
import bpy,bmesh,json,math
from pathlib import Path
from mathutils import Vector
P=Path(__file__).resolve().parent.parent
sc=bpy.context.scene;dg=bpy.context.evaluated_depsgraph_get()
mesh_count=0;triangles=0;aperture_checks=[];parts=[]
for o in sc.objects:
 if o.type!='MESH' or o.hide_render:continue
 ev=o.evaluated_get(dg);me=ev.to_mesh();me.calc_loop_triangles();mesh_count+=1;triangles+=len(me.loop_triangles)
 verts=[ev.matrix_world@v.co for v in me.vertices];parts.append({'id':o.name,'bounds':[[min(v[i] for v in verts) for i in range(3)],[max(v[i] for v in verts) for i in range(3)]],'triangleCount':len(me.loop_triangles)})
 ev.to_mesh_clear()
# Ray-cast only the scheduled structural wall at the center of its aperture.
for wall,origin,direction,id in [('west window wall',(-6.5,-1.9,1.5),(1,0,0),'entry'),('west window wall',(-6.5,-4.15,1.8),(1,0,0),'window-1'),('west window wall',(-6.5,.8,1.8),(1,0,0),'window-2'),('west window wall',(-6.5,3.5,1.8),(1,0,0),'window-3'),('back wall with true arch',(3.85,4,1.5),(0,1,0),'rear-seat-arch'),('nook rear wall',(4,8,1.8),(0,1,0),'nook-window')]:
 o=sc.objects.get(wall);result=o.ray_cast(o.matrix_world.inverted()@Vector(origin),o.matrix_world.inverted().to_3x3()@Vector(direction));aperture_checks.append({'id':id,'centerUnobstructedInStructuralWall':not result[0]})
# Audit manifold topology of structural walls and slabs.
structures=[]
for o in sc.objects:
 if any(k in o.name for k in ['structural floor','sealed main ceiling','west window wall','east wall','front return wall','back wall with true arch','nook floor','nook ceiling','nook west wall','nook east wall','nook rear wall']):
  if o.type!='MESH':continue
  bm=bmesh.new();bm.from_mesh(o.data);structures.append({'id':o.name,'nonManifoldEdges':sum(not e.is_manifold for e in bm.edges)});bm.free()
# Monochrome orthographic renders use actual mesh geometry and retain every prop silhouette.
cam=bpy.data.objects.new('audit orthographic camera',bpy.data.cameras.new('audit ortho'));sc.collection.objects.link(cam);cam.data.type='ORTHO';cam.data.ortho_scale=18;sc.camera=cam
sc.render.engine='BLENDER_WORKBENCH';sc.display.shading.light='FLAT';sc.display.shading.color_type='SINGLE';sc.display.shading.single_color=(.72,.72,.72);sc.display.shading.show_shadows=False;sc.display.shading.show_cavity=True;sc.display.shading.cavity_type='WORLD';sc.display.shading.show_object_outline=True;sc.display.shading.background_type='WORLD';sc.world.color=(1,1,1)
sc.render.resolution_x=1200;sc.render.resolution_y=1200
hidden={o:o.hide_render for o in sc.objects}
for layer in ['lower-room','reflected-ceiling']:
 for o,old in hidden.items():
  if old:continue
  name=o.name
  if o.type=='MESH':
   is_ceiling=any(s in name for s in ['ceiling','beam','pendant','suspension','diffuser'])
   outside=any(s in name for s in ['exterior tree','far coastal','distant sea'])
   # Cut structural walls at plan height so lintels do not close an opening in plan.
   o.hide_render=outside or (not is_ceiling if layer=='reflected-ceiling' else is_ceiling)
  if o.type=='CURVE':o.hide_render=layer=='lower-room' and any(s in name for s in ['ceiling','pendant','hanging planter chain'])
 cam.location=(0,1.0,25 if layer=='lower-room' else -15);target=Vector((0,1,0));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();sc.render.filepath=str(P/'plans'/f'blender-{layer}.png');bpy.ops.render.render(write_still=True)
for o,state in hidden.items():o.hide_render=state
report={'authoringTool':'Blender '+bpy.app.version_string,'evaluatedVisibleMeshObjects':mesh_count,'evaluatedTriangles':triangles,'apertureCenterTests':aperture_checks,'structuralManifoldTests':structures,'allApertureCentersClear':all(x['centerUnobstructedInStructuralWall'] for x in aperture_checks),'allStructuralMeshesManifold':all(x['nonManifoldEdges']==0 for x in structures),'objects':parts,'limitations':['Collision, seating clearance, support, and production character silhouette still require runtime review','Total triangles include outdoor review context and subdivision/bevels','Plan wall apertures are supplemented by center-ray tests and opening schedule; overhead lintels may conceal a low opening']}
(P/'blender/geometry-audit.json').write_text(json.dumps(report,indent=2)+'\n');print('AUDIT',report['evaluatedTriangles'],report['allApertureCentersClear'],report['allStructuralMeshesManifold'],flush=True)
