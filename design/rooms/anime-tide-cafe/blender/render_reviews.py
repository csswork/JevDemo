"""Render saved authored scene without regenerating geometry.
blender -b tide-cafe.blend -P render_reviews.py -- main counter ...
"""
import bpy,json,sys
from pathlib import Path
from mathutils import Vector
P=Path(__file__).resolve().parent.parent
sc=bpy.context.scene;cam=sc.camera
views=json.loads((P/'blender/authoring-metadata.json').read_text())['reviewCameras']
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else ['main','window-seating','counter','depth']
proof='--proof' in args
args=[a for a in args if a!='--proof']
sc.cycles.samples=20 if proof else 48;sc.render.resolution_x=960 if proof else 1600;sc.render.resolution_y=600 if proof else 1000;sc.render.resolution_percentage=100
try:
 prefs=bpy.context.preferences.addons['cycles'].preferences;prefs.compute_device_type='METAL';prefs.get_devices();enabled=False
 for d in prefs.devices:d.use=d.type=='METAL';enabled=enabled or d.use
 if enabled:sc.cycles.device='GPU'
except Exception:pass
for name in args:
 v=views[name];cam.location=v['location'];cam.rotation_euler=(Vector(v['target'])-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.lens=v['lensMm'];cam.data.sensor_fit='AUTO'
 if name=='character-camera':cam.data.sensor_fit='VERTICAL';cam.data.sensor_height=36;cam.data.lens=84.6869
 sc.render.filepath=str(P/'renders'/f'blender-{name}.png');print('RENDER_START',name,flush=True);bpy.ops.render.render(write_still=True);print('RENDER_DONE',name,flush=True)
