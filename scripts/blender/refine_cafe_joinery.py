"""Correct recessed glazing/door leaves and finish the front interior wall."""
import bpy,math
from pathlib import Path
root=Path(__file__).resolve().parents[2];pkg=root/'design/rooms/anime-tide-cafe';sc=bpy.context.scene
wood=bpy.data.materials['warm oak | fine grain'];walnut=bpy.data.materials['window walnut'];glass=bpy.data.materials['clear physical glazing']
def cube(name,loc,size,material):
 bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=size;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(material);return o
for o in list(sc.objects):
 if o.name.startswith(('entry glass','window-1 glass','window-2 glass','window-3 glass','nook rear glass','entry door ','nook glazed ','front wall finish','front welcome','front botanical')) or o.name.startswith('entry mullion'):bpy.data.objects.remove(o,do_unlink=True)
for name,cy,w,sill,h in [('entry',-1.9,2.4,0,3.25),('window-1',-4.15,1.6,.35,3.05),('window-2',.8,2.6,.35,3.05),('window-3',3.5,2.2,.35,3.05)]:
 n=2 if name=='entry' else max(2,round(w/.85));step=w/n;transom=sill+h-.5
 for j in range(n):
  left=cy-w/2+j*step+(.05 if j==0 else .035);right=cy-w/2+(j+1)*step-(.05 if j==n-1 else .035)
  low=sill+(.28 if name=='entry' else .05)
  cube(name+' glass lower',(-5.495,(left+right)/2,(low+transom-.03)/2),(.010,right-left,transom-.03-low),glass)
  cube(name+' glass transom',(-5.495,(left+right)/2,(transom+.03+sill+h-.05)/2),(.010,right-left,.42),glass)
  if name=='entry':
   # Two distinct leaf frames meet at a closing seam below the fixed transom.
   for yy in [left-.025,right+.025]:cube('entry door stile',(-5.48,yy,(.05+transom-.04)/2),(.11,.065,transom-.09),walnut)
   cube('entry door bottom rail',(-5.48,(left+right)/2,.15),(.11,right-left+.08,.23),walnut)
   cube('entry door top rail',(-5.48,(left+right)/2,transom-.075),(.11,right-left+.08,.07),walnut)
 if name=='entry':cube('entry door fixed transom divider',(-5.5,cy,transom+.25),(.14,.06,.5),walnut)
# Rear nook glazing gets the same structural layering, with an actual surround.
for x in [2.78,5.22]:cube('nook glazed jamb',(x,8.52,1.9),(.10,.16,2.72),walnut)
for z in [.55,3.25]:cube('nook glazed rail',(4,8.52,z),(2.54,.16,.10),walnut)
cube('nook glazed mullion',(4,8.52,1.9),(.06,.14,2.6),walnut)
for x in [3.4,4.6]:cube('nook rear glass pane',(x,8.515,1.9),(1.12,.01,2.58),glass)
# Warm joinery continues onto the formerly blank wall at the reverse camera angle.
for i in range(31):cube('front wall finish oak board',(-5.35+i*.356,-5.175,.53),(.346,.065,1.03),wood)
cube('front wall finish cap',(0,-5.125,1.08),(11.0,.13,.08),walnut)
def picture(name,x,z,w,h,file):
 cube(name+' frame',(x,-5.18,z),(w+.12,.10,h+.12),walnut)
 m=bpy.data.materials.new(name+' print');m.use_nodes=True;t=m.node_tree.nodes.new('ShaderNodeTexImage');t.image=bpy.data.images.load(str(pkg/'textures'/file),check_existing=False);m.node_tree.links.new(t.outputs['Color'],m.node_tree.nodes['Principled BSDF'].inputs['Base Color']);m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.85
 bpy.ops.mesh.primitive_plane_add(size=1,location=(x,-5.12,z),rotation=(math.pi/2,0,math.pi));o=bpy.context.object;o.name=name+' image';o.scale=(w,h,1);o.data.materials.append(m)
picture('front welcome',0,2.22,2.55,1.275,'welcome.png')
picture('front botanical left',-3.35,2.22,.82,1.10,'art-0.png');picture('front botanical right',3.35,2.22,.82,1.10,'art-2.png')
# Replace packed old menu pixels with the newly authored Chinese menu.
menu=bpy.data.images.load(str(pkg/'textures/menu.png'),check_existing=False)
for m in bpy.data.materials:
 if not m.use_nodes:continue
 for n in m.node_tree.nodes:
  if n.type=='TEX_IMAGE' and n.image and n.image.name.startswith('menu.png'):n.image=menu
for image in bpy.data.images:
 if image.source=='FILE' and image.has_data:
  try:image.pack()
  except RuntimeError:pass
bpy.ops.wm.save_as_mainfile(filepath=str(pkg/'blender/tide-cafe.blend'));print('JOINERY_REFINED',flush=True)
