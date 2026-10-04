"""Measure evaluated supports and prove they are backed by solid wall geometry."""
import bpy,json
from pathlib import Path
from mathutils import Vector
sc=bpy.context.scene;dg=bpy.context.evaluated_depsgraph_get();wall=sc.objects['west window wall'];wi=wall.matrix_world.inverted();results=[]
for o in sc.objects:
 if not o.name.startswith('beam wall post') or o.location.x>=0:continue
 ev=o.evaluated_get(dg);mesh=ev.to_mesh();vertices=[ev.matrix_world@v.co for v in mesh.vertices];bounds=[[min(v[i] for v in vertices) for i in range(3)],[max(v[i] for v in vertices) for i in range(3)]];ev.to_mesh_clear()
 hits=[]
 for z in [1.0,2.0,3.2]:
  hit=wall.ray_cast(wi@Vector((-5.2,o.location.y,z)),wi.to_3x3()@Vector((-1,0,0)),distance=.5)[0];hits.append(hit)
 assert all(hits),('Support over opening',o.name,hits)
 results.append({'object':o.name,'evaluatedBounds':bounds,'solidWallBackedAtHeights':[1.,2.,3.2],'rayHits':hits})
assert len(results)==5
assert not any(o.name.startswith('wood wainscot cap') and o.location.x<0 for o in sc.objects)
root=Path(__file__).resolve().parents[2];p=root/'design/rooms/anime-tide-cafe/blender/structure-alignment.json';record=json.loads(p.read_text());record['evaluatedSupports']=results;record['allEvaluatedPostsBackedBySolidWall']=True;record['continuousRailAcrossWindowsRemoved']=True;p.write_text(json.dumps(record,indent=2)+'\n');print('STRUCTURE_AUDIT_PASS',len(results),flush=True)
