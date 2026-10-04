"""Reference-led detailed café authoring. Produces a real .blend and review renders, no runtime export.
Blender -b --factory-startup -P scripts/blender/anime_cafe_room.py -- [--quick] [--all]
Coordinates: Blender Z up, character origin; counter behind at +Y, camera -Y.
"""
import bpy, bmesh, math, random, json, os, sys, time
from pathlib import Path
from mathutils import Vector, Matrix
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'design/rooms/anime-tide-cafe'
(OUT/'blender').mkdir(exist_ok=True); (OUT/'renders').mkdir(exist_ok=True)
R=random.Random(731)
sc=bpy.context.scene
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
sc.unit_settings.system='METRIC';sc.unit_settings.scale_length=1

def rgba(h):
 vals=[int(h.lstrip('#')[i:i+2],16)/255 for i in (0,2,4)]
 return tuple(c/12.92 if c<.04045 else ((c+.055)/1.055)**2.4 for c in vals)+(1,)
def mat(name,color,rough=.65,metal=0,emission=0):
 m=bpy.data.materials.new(name);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=rgba(color);p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metal
 if emission:p.inputs['Emission Color'].default_value=rgba(color);p.inputs['Emission Strength'].default_value=emission
 return m
def textured(name,a,b,grain=False):
 m=mat(name,a,.57 if grain else .85);n=m.node_tree.nodes;l=m.node_tree.links;p=n.get('Principled BSDF')
 tex=n.new('ShaderNodeTexNoise');tex.inputs['Scale'].default_value=5 if grain else 65;tex.inputs['Detail'].default_value=3;tex.inputs['Roughness'].default_value=.72
 coord=n.new('ShaderNodeTexCoord');mapping=n.new('ShaderNodeMapping');mapping.inputs['Scale'].default_value=(3,.22,12) if grain else (1,1,1);l.new(coord.outputs['Generated'],mapping.inputs['Vector']);l.new(mapping.outputs['Vector'],tex.inputs['Vector'])
 ramp=n.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].position=.2;ramp.color_ramp.elements[0].color=rgba(a);ramp.color_ramp.elements[1].position=.8;ramp.color_ramp.elements[1].color=rgba(b);l.new(tex.outputs['Fac'],ramp.inputs['Fac']);l.new(ramp.outputs['Color'],p.inputs['Base Color'])
 bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.18 if grain else .15;bump.inputs['Distance'].default_value=.016 if grain else .008;l.new(tex.outputs['Fac'],bump.inputs['Height']);l.new(bump.outputs['Normal'],p.inputs['Normal']);return m
wood=textured('warm oak | fine grain','#a2764d','#c59b6e',True);walnut=textured('window walnut','#584737','#826447',True);plaster=textured('warm plaster','#e5dbc6','#f1e5d0');stone=textured('ivory stone countertop','#d7c9b4','#f0e5d2');grout=mat('warm gray grout','#b9b0a2');brass=mat('aged brass','#bfa267',.28,.65);black=mat('blue black metal','#26393f',.30,.58);steel=mat('brushed steel','#b8c3c7',.24,.78);ceramic=mat('ivory glaze','#f4ecda',.29);soil=mat('soil','#4c3b2a');fabric=textured('sage woven upholstery','#769583','#96aa91');bulb=mat('warm light diffuser','#ffe1a0',.30,0,3)
leaves=[mat('leaf '+str(i),c,.5) for i,c in enumerate(['#4c7748','#6a8c52','#91a466','#7e9a5b','#375c43'])]
glass=mat('clear physical glazing','#eff9ff',.06);glass.node_tree.nodes.get('Principled BSDF').inputs['Transmission Weight'].default_value=1;glass.node_tree.nodes.get('Principled BSDF').inputs['IOR'].default_value=1.45
# Thin glazing transmits direct shadow rays while keeping camera-visible refraction.
gn=glass.node_tree.nodes;gl=glass.node_tree.links;mix=gn.new('ShaderNodeMixShader');lp=gn.new('ShaderNodeLightPath');tr=gn.new('ShaderNodeBsdfTransparent');gl.new(lp.outputs['Is Shadow Ray'],mix.inputs[0]);gl.new(gn.get('Principled BSDF').outputs['BSDF'],mix.inputs[1]);gl.new(tr.outputs['BSDF'],mix.inputs[2]);gl.new(mix.outputs[0],gn.get('Material Output').inputs['Surface'])
objects=[];openings=[];fixtures=[]
def assign(o,m):o.data.materials.append(m);objects.append(o);return o
def cube(name,loc,size,m,bevel=.015):
 bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=size;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);assign(o,m)
 if bevel:
  b=o.modifiers.new('soft crafted edges','BEVEL');b.width=bevel;b.segments=2
  n=o.modifiers.new('weighted normals','WEIGHTED_NORMAL')
 return o
def cylinder(name,loc,r,h,m,seg=24):
 bpy.ops.mesh.primitive_cylinder_add(vertices=seg,radius=r,depth=h,location=loc);o=bpy.context.object;o.name=name;assign(o,m)
 for p in o.data.polygons:p.use_smooth=True
 return o
def ball(name,loc,scale,m):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=12,ring_count=8,radius=1,location=loc);o=bpy.context.object;o.name=name;o.scale=scale;assign(o,m)
 for p in o.data.polygons:p.use_smooth=True
 return o
def curve(name,points,r,m):
 data=bpy.data.curves.new(name,'CURVE');data.dimensions='3D';data.bevel_depth=r;data.bevel_resolution=2;sp=data.splines.new('POLY');sp.points.add(len(points)-1)
 for v,p in zip(sp.points,points):v.co=(*p,1)
 o=bpy.data.objects.new(name,data);sc.collection.objects.link(o);assign(o,m);return o
def lathe(name,loc,profile,m,seg=32):
 verts=[];faces=[]
 for radius,z in profile:
  for i in range(seg):a=i*math.tau/seg;verts.append((loc[0]+radius*math.cos(a),loc[1]+radius*math.sin(a),loc[2]+z))
 for j in range(len(profile)-1):
  for i in range(seg):k=j*seg+i;n=j*seg+(i+1)%seg;faces.append((k,n,n+seg,k+seg))
 me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update();o=bpy.data.objects.new(name,me);sc.collection.objects.link(o);assign(o,m)
 for p in me.polygons:p.use_smooth=True
 return o
def boolean(wall,cutter,id):
 bpy.context.view_layer.objects.active=wall;b=wall.modifiers.new('opening '+id,'BOOLEAN');b.operation='DIFFERENCE';b.solver='EXACT';b.object=cutter;bpy.ops.object.modifier_apply(modifier=b.name);bpy.data.objects.remove(cutter,do_unlink=True);openings.append(id)
def light(name,loc,color,energy,size=.4,kind='AREA',target=None):
 d=bpy.data.lights.new(name,kind);d.color=rgba(color)[:3];d.energy=energy
 if kind=='AREA':d.shape='DISK';d.size=size
 elif kind=='POINT':d.shadow_soft_size=size
 o=bpy.data.objects.new(name,d);sc.collection.objects.link(o);o.location=loc
 if target:o.rotation_euler=(Vector(target)-o.location).to_track_quat('-Z','Y').to_euler()
 fixtures.append(dict(id=name,position=list(loc),color=color,watts=energy,type=kind));return o
# Continuous substrates, including the deep seat-room reached through a real arch.
floor=cube('structural floor',(0,-.2,-.12),(11.4,10.4,.24),grout,0)
ceiling=cube('sealed main ceiling',(0,-.2,3.94),(11.4,10.4,.24),plaster,0)
west=cube('west window wall',(-5.6,-.2,1.9),(.24,10.4,3.8),plaster,0)
east=cube('east wall',(5.6,-.2,1.9),(.24,10.4,3.8),plaster,0)
back=cube('back wall with true arch',(0,4.92,1.9),(11.4,.24,3.8),plaster,0)
front=cube('front return wall',(0,-5.32,1.9),(11.4,.24,3.8),plaster,0)
for name,cy,w,sill,h in [('entry',-1.9,2.4,0,3.25),('window-1',-4.15,1.6,.35,3.05),('window-2',.8,2.6,.35,3.05),('window-3',3.5,2.2,.35,3.05)]:
 cut=cube('cutter '+name,(-5.6,cy,sill+h/2),(.6,w,h),plaster,0);boolean(west,cut,name)
 for y in [cy-w/2,cy+w/2]:cube(name+' jamb',(-5.50,y,sill+h/2),(.18,.10,h+.12),walnut)
 for z in [sill,sill+h]:cube(name+' horizontal frame',(-5.50,cy,z),(.18,w+.12,.1),walnut)
 # Glazing divided into real thin panels and mullions. Double door visibly closes the actual aperture.
 n=2 if name=='entry' else max(2,round(w/.85))
 for j in range(1,n):cube(name+' mullion',(-5.50,cy-w/2+j*w/n,sill+h/2),(.16,.055,h),walnut,.008)
 for j in range(n):cube(name+' glass',(-5.59,cy-w/2+(j+.5)*w/n,sill+h/2),(.008,w/n-.06,h-.09),glass,0)
 cube(name+' transom',(-5.50,cy,sill+h-.5),(.14,w,.06),walnut,.006)
 if name=='entry':
  for yy in [cy-.12,cy+.12]:curve('brass door pull',[(-5.37,yy,.88),(-5.34,yy,.90),(-5.34,yy,1.20),(-5.37,yy,1.22)],.012,brass)
  cube('stone entry threshold',(-5.5,cy,.025),(.5,w,.05),stone)
 else:cube('deep window sill',(-5.40,cy,sill),(.40,w+.16,.075),wood)
# Arched cutter: closed extruded profile and applied exact Boolean.
ax=3.85;r=.93;shoulder=2.22;profile=[(ax-r,0),(ax+r,0),(ax+r,shoulder)]+[(ax+r*math.cos(a),shoulder+r*math.sin(a)) for a in [i*math.pi/32 for i in range(1,33)]]
v=[(x,y,z) for y in [4.5,5.3] for x,z in profile];n=len(profile);faces=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
me=bpy.data.meshes.new('arched cutter');me.from_pydata(v,[],faces);me.update();bm=bmesh.new();bm.from_mesh(me);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(me);bm.free();cut=bpy.data.objects.new('arched cutter',me);sc.collection.objects.link(cut);boolean(back,cut,'rear-seat-arch')
for x in [ax-r-.055,ax+r+.055]:cube('arch solid wood jamb',(x,4.73,1.11),(.14,.28,2.22),wood,.02)
curve('arch curved wooden head',[(ax+(r+.055)*math.cos(a),4.73,shoulder+(r+.055)*math.sin(a)) for a in [i*math.pi/48 for i in range(49)]],.078,wood)
cube('nook floor',(4.0,6.7,-.12),(3.2,3.8,.24),grout,0);cube('nook ceiling',(4,6.7,3.94),(3.2,3.8,.24),plaster,0)
cube('nook west wall',(2.48,6.7,1.9),(.24,3.8,3.8),plaster,0);cube('nook east wall',(5.6,6.7,1.9),(.24,3.8,3.8),plaster,0)
nb=cube('nook rear wall',(4,8.62,1.9),(3.2,.24,3.8),plaster,0);boolean(nb,cube('nook window cutter',(4,8.62,1.9),(2.3,.6,2.6),plaster,0),'nook-window')
for x in [2.8,5.2]:cube('nook window frame',(x,8.48,1.9),(.09,.15,2.7),walnut)
for z in [.55,3.25]:cube('nook window frame',(4,8.48,z),(2.45,.15,.09),walnut)
cube('nook rear glass',(4,8.61,1.9),(2.3,.008,2.6),glass,0)
# Floor tiles: laid individually with grout gaps and crafted bevels, not a painted flat plane.
tiles=[textured('porcelain variation '+str(i),a,b) for i,(a,b) in enumerate([('#c5b2a1','#e2d1ba'),('#d0b9a9','#e6d0bd'),('#c1bab0','#ded8c8'),('#d5beac','#edddc8')])]
for m in tiles:
 p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Roughness'].default_value=.32
for x in range(15):
 for y in range(14):cube('porcelain tile',(-5.16+x*.738,-4.82+y*.738,.013),(.718,.718,.026),R.choice(tiles),.009)
for x in range(4):
 for y in range(5):cube('nook porcelain tile',(2.84+x*.738,5.1+y*.738,.013),(.718,.718,.026),R.choice(tiles),.009)
# Timber framing, plank ceiling and suspended electrical rods.
for i in range(28):cube('ceiling oak boarding',(-5.30+i*.39,-.2,3.805),(.378,10.2,.055),wood,.005)
for y in [-4.8,-2.1,.6,3.7]:
 cube('cross beam',(0,y,3.64),(11.10,.20,.26),walnut,.02)
 for x in [-5.42,5.42]:cube('beam wall post',(x,y,1.82),(.16,.18,3.64),wood,.012)
for y in [-4.5,-.5,3.5]:cube('nook timber beam',(4,6.7+(y+1)*.2,3.66),(3,.16,.20),walnut)
for x in [-5.44,5.44]:cube('wood wainscot cap',(x,-.2,.95),(.13,10.25,.055),walnut,.008)
for x in [5.46]:
 for y in range(50):cube('wainscot vertical plank',(x,-5.13+y*.205,.46),(.055,.198,.92),wood,.005)
# Import existing finely constructed project props into an authoring-only library, then instance the real meshes.
before_import=set(sc.objects)
bpy.ops.import_scene.gltf(filepath=str(ROOT/'public/scene/models/cafe/props.glb'))
libroots=[o for o in sc.objects if o.parent is None and o not in before_import and o.type in {'MESH','EMPTY'}]
lib={o.name.split('.')[0]:o for o in libroots}
# glTF source meshes keep authored vertex colors. Only wood receives the room's detailed oak material.
for o in libroots:
 for m in [o,*o.children_recursive]:
  if m.type=='MESH':
   for i,slot in enumerate(m.material_slots):
    if slot.material and slot.material.name.split('.')[0]=='wood':m.data.materials[i]=wood
 for c in [o,*o.children_recursive]:c.hide_render=True;c.hide_set(True)

def prop(name,x,y,z,h,rz=0):
 source=lib.get(name)
 if source is None:raise RuntimeError('Missing project prop '+name+'; available '+str(list(lib)))
 old=[source,*source.children_recursive];new=[];mapping={}
 for o in old:
  c=o.copy();sc.collection.objects.link(c);c.hide_render=False;c.hide_set(False);mapping[o]=c;new.append(c)
 for o,c in mapping.items():c.parent=mapping.get(o.parent);c.matrix_parent_inverse=o.matrix_parent_inverse.copy();c.matrix_basis=o.matrix_basis.copy()
 root=mapping[source];root.name='authored '+name;root.location=(0,0,0);root.rotation_euler.z=rz;bpy.context.view_layer.update()
 pts=[o.matrix_world@Vector(v) for o in new if o.type=='MESH' for v in o.bound_box]
 lo=Vector([min(v[i] for v in pts) for i in range(3)]);hi=Vector([max(v[i] for v in pts) for i in range(3)]);k=h/(hi.z-lo.z)
 root.scale*=k;bpy.context.view_layer.update();pts=[o.matrix_world@Vector(v) for o in new if o.type=='MESH' for v in o.bound_box];lo=Vector([min(v[i] for v in pts) for i in range(3)]);hi=Vector([max(v[i] for v in pts) for i in range(3)]);root.location+=Vector((x-(lo.x+hi.x)/2,y-(lo.y+hi.y)/2,z-lo.z));return root
# Long oak service counter, individual tongue-and-groove boards, toe-kick and stone surface.
cube('counter carcass',(-1.05,2.76,.51),(7.25,1.0,1.02),walnut,.025)
for i in range(45):
 x=-4.64+i*.163;cube('counter vertical face plank',(x,2.235,.54),(.155,.055,.99),wood,.009)
 # Small joint pegs at the ends reinforce scale and craft.
 for z in [.13,.92]:ball('oak peg',(x,2.201,z),(.005,.002,.005),walnut)
cube('counter plinth',(-1.05,2.21,.08),(7.25,.10,.13),walnut)
cube('counter stone slab',(-1.05,2.72,1.055),(7.45,1.16,.075),stone,.022)
# Rear work bench, bottle shelves and joinery.
cube('back work bench',(-1.0,4.27,.53),(7.30,.78,1.06),wood)
cube('back bench top',(-1.0,4.25,1.08),(7.45,.86,.055),stone)
for x in [-4.3,-3.4,-2.5,-1.6,-.7,.2,1.1,2.0]:cube('cabinet drawer',(x,3.863,.8),(.85,.035,.38),wood,.018);cube('cabinet brass pull',(x,3.831,.83),(.26,.025,.015),brass,.006)
# Menu image mapped to a real inset board, framed with raised wood rails.
def picture(name,x,y,z,w,h,filename,rz=0):
 backing=cube(name+' oak frame',(x,y,z),(w+.12,.09,h+.12),walnut,.01);backing.rotation_euler.z=rz
 m=mat(name+' printed art','#ffffff',.8);n=m.node_tree.nodes;t=n.new('ShaderNodeTexImage');t.image=bpy.data.images.load(str(OUT/'textures'/filename),check_existing=True);m.node_tree.links.new(t.outputs['Color'],n.get('Principled BSDF').inputs['Base Color'])
 bpy.ops.mesh.primitive_plane_add(size=1,location=(x,y-.052,z),rotation=(math.pi/2,0,rz));o=bpy.context.object;o.name=name;o.scale=(w,h,1);assign(o,m);return o
picture('chalk coffee menu',-.15,4.74,2.64,3.4,1.75,'menu.png')
# Object shelves occupy left and right of the board, with under-shelf practical strips.
for x,w in [(-3.68,2.4),(2.18,.95)]:
 for z in [1.56,2.20,2.86,3.47]:
  cube('display shelf',(x,4.58,z),(w,.40,.065),wood,.012)
  for xx in [x-w*.34,x+w*.34]:
   cube('shelf brass bracket',(xx,4.70,z-.13),(.025,.04,.25),brass,.008);curve('bracket diagonal',[(xx,4.37,z-.04),(xx,4.70,z-.25)],.011,brass)
  cube('shelf warm LED',(x,4.45,z-.045),(w-.12,.018,.018),bulb,.005)
  light('under shelf '+str(x)+' '+str(z),(x,4.46,z-.08),'#ffe2ac',15,size=.5,target=(x,4.25,z-.8))
# Display case: proper steel rails, sloping front glazing, glass shelf and trays.
cx=-2.65;cy=2.68;base=1.1;cw=2.45;cd=.83
cube('pastry case base',(cx,cy,base+.06),(cw,cd,.12),steel)
for z in [base+.32,base+.59]:cube('display shelf glass',(cx,cy,z),(cw-.12,cd-.10,.016),glass,0)
for x in [cx-cw/2,cx+cw/2]:
 for y in [cy-cd/2,cy+cd/2]:cube('case steel corner',(x,y,base+.36),(.026,.026,.66),black,.004)
 cube('case side glazing',(x,cy,base+.37),(.007,cd-.02,.68),glass,0)
for z in [base+.12,base+.69]:cube('case front rail',(cx,cy-cd/2,z),(cw,.030,.034),black,.004)
frontglass=cube('case angled front glass',(cx,cy-cd/2+.08,base+.41),(cw,.008,.56),glass,0);frontglass.rotation_euler.x=math.radians(-16)
cube('case upper glass',(cx,cy,base+.72),(cw,cd,.009),glass,0);cube('case interior lamp',(cx,cy+.32,base+.67),(cw-.15,.022,.018),bulb,.002)
for level in [base+.12,base+.34,base+.61]:
 for j in range(6):
  x=cx-1.01+j*.39; y=cy-.11
  cylinder('pastry white plate',(x,y,level+.011),.145,.022,ceramic)
  prop(['croissant','cupcake','muffin','cake'][j%4],x,y,level+.023,[.07,.13,.12,.16][j%4],R.uniform(-.5,.5))
# Detailed espresso machine reused from the Blender-authored project model, plus grinders and cups.
# Bespoke professional twin-group machine: open cup recess, metal case, oak sides,
# real pressure dials, portafilters, drip grating, steam wand and warming rail.
mx=1.05;my=2.87
cube('espresso rear steel casing',(mx,my+.235,1.445),(1.06,.035,.62),steel,.025)
cube('espresso upper console',(mx,my,1.69),(1.08,.48,.17),steel,.028)
for side in [-1,1]:
 cube('espresso oak side',(mx+side*.525,my,1.435),(.048,.45,.61),walnut,.024)
 cube('espresso black side insert',(mx+side*.55,my,1.43),(.015,.35,.42),black,.01)
 for yy in [my-.16,my+.17]:cylinder('espresso foot',(mx+side*.42,yy,1.115),.034,.04,black)
cube('espresso drip pan',(mx,my-.095,1.16),(1.09,.64,.07),black,.018)
for i in range(26):cube('drip tray stainless grating',(mx-.50+i*.040,my-.10,1.201),(.010,.50,.007),steel,.003)
cube('espresso black control face',(mx,my-.249,1.698),(.98,.016,.113),black,.005)
for side in [-1,1]:
 gx=mx+side*.23
 ring=cylinder('pressure gauge rim',(gx,my-.264,1.704),.044,.013,brass,32);ring.rotation_euler.x=math.pi/2
 disk=cylinder('pressure dial',(gx,my-.274,1.704),.035,.008,ceramic,32);disk.rotation_euler.x=math.pi/2
 for j in range(9):
  a=.2+j*math.pi/9;curve('gauge tick',[(gx+.029*math.cos(a),my-.280,1.704+.029*math.sin(a)),(gx+.024*math.cos(a),my-.280,1.704+.024*math.sin(a))],.0012,black)
 curve('gauge needle',[(gx,my-.283,1.704),(gx-.018,my-.283,1.719)],.0017,black)
 for j in range(3):ball('espresso control button',(gx-.08+j*.08,my-.269,1.653),(.012,.006,.009),steel)
 cylinder('chrome brew group',(gx,my-.17,1.545),.071,.13,steel)
 cylinder('group collar',(gx,my-.17,1.469),.077,.025,black)
 curve('walnut portafilter handle',[(gx,my-.20,1.477),(gx,my-.45,1.475)],.017,walnut)
 for xx in [-.025,.025]:curve('coffee spout',[(gx+xx,my-.17,1.460),(gx+xx,my-.20,1.43)],.005,steel)
 prop('cup_tea',gx,my-.18,1.205,.082,0)
curve('steam wand',[(mx+.46,my-.23,1.596),(mx+.49,my-.34,1.49),(mx+.46,my-.42,1.32)],.0075,steel)
curve('warming tray guard',[(mx-.50,my-.20,1.795),(mx-.50,my+.19,1.795),(mx+.50,my+.19,1.795),(mx+.50,my-.20,1.795)],.009,steel)
for x in [.72,.95,1.18,1.41]:prop('cup_tea',x,2.82,1.785,.075)
for x in [2.00,2.41]:
 cube('grinder base',(x,2.85,1.14),(.23,.30,.08),black)
 cube('grinder motor',(x,2.9,1.34),(.19,.22,.34),steel,.025)
 lathe('grinder coffee hopper',(x,2.9,1.49),[(.09,0),(.125,.10),(.13,.22),(.12,.23),(.10,.01),(.09,0)],glass)
 cylinder('hopper lid',(x,2.9,1.726),.134,.024,black)
 cylinder('coffee beans hopper',(x,2.9,1.59),.095,.17,soil)
 curve('grinder chute',[(x,2.78,1.45),(x,2.70,1.44),(x,2.68,1.30)],.025,steel)
for i in range(10):prop('cup',-1.3+i*.19,4.10,1.11,.13,R.uniform(-.4,.4))
# Tiny syrup bottles and tins fill shelves with coordinated useful objects.
for sx,w in [(-3.68,2.4),(2.18,.95)]:
 for z in [1.60,2.24,2.90]:
  for j in range(int(w/.25)-1):
   x=sx-w/2+.24+j*.25
   if R.random()<.48:prop('cup',x,4.50,z,.14+R.random()*.045,R.random())
   else:
    cylinder('ceramic tea jar',(x,4.51,z+.10),.075,.20,ceramic)
    cylinder('jar oak lid',(x,4.51,z+.212),.079,.025,wood)
    cylinder('jar lid knob',(x,4.51,z+.24),.016,.032,brass)
# Real square oak tables with apron joinery, four legs and pale sage seat cushions.
def table(name,x,y,rz=0,w=1.12,d=.82):
 objs=[];objs.append(cube(name+' tabletop',(x,y,.775),(w,d,.055),wood,.025))
 for xx in [-w/2+.1,w/2-.1]:
  for yy in [-d/2+.1,d/2-.1]:objs.append(cube(name+' tapered leg',(x+xx,y+yy,.37),(.064,.064,.74),walnut,.009))
 for yy in [-d/2+.08,d/2-.08]:objs.append(cube(name+' apron',(x,y+yy,.68),(w-.13,.06,.15),wood))
 for xx in [-w/2+.08,w/2-.08]:objs.append(cube(name+' apron',(x+xx,y,.68),(.06,d-.13,.15),wood))
 for o in objs:
  delta=o.location-Vector((x,y,0));o.location=Vector((x,y,0))+Matrix.Rotation(rz,3,'Z')@delta;o.rotation_euler.z+=rz
 prop('cup_tea',x-.17,y,.804,.085,.2);prop('cup_tea',x+.20,y,.804,.085,2.4)
 cube('table linen runner',(x,y,.806),(.22,d-.08,.003),fabric,.001)
 return objs
for i,(x,y) in enumerate([(-3.98,-4.0),(-3.98,-.02),(3.65,-3.55),(3.65,-.20),(4.0,6.5)]):
 table('conversation table '+str(i),x,y)
 for j,sgn in enumerate([-1,1]):
  prop('chair',x,y+sgn*.95,0,.98,0 if sgn==1 else math.pi)
  cube('sage seat pad',(x,y+sgn*.95,.48),(.39,.38,.045),fabric,.018)
# Right-side banquette faces the tables (toward -X), with upholstery seams and loose cushions.
cube('banquette oak base',(5.05,-.85,.24),(.80,5.1,.48),walnut,.03)
cube('banquette seat',(4.98,-.85,.49),(.85,5.08,.14),fabric,.045)
cube('banquette upholstered back',(5.37,-.85,.90),(.18,5.10,.83),fabric,.05)
for y in [-3.13,-2.57,-2.01,-1.45,-.89,-.33,.23,.79,1.35]:curve('upholstery piping',[(5.25,y,.55),(5.25,y,1.28)],.004,walnut)
for y in [-2.7,-.5,1.0]:
 p=cube('loose cream linen cushion',(5.12,y,.85),(.15,.46,.45),ceramic,.055);p.rotation_euler.y=-.18;p.rotation_euler.x=.12
# A-frame entrance board with hinges and actual feet.
for side in [-1,1]:
 o=cube('A-frame oak board',(-4.64,-2.42+side*.19,.58),(.64,.065,1.1),wood,.015);o.rotation_euler.x=side*.16
 o=cube('A-frame chalk insert',(-4.64,-2.66,.64),(.54,.015,.84),mat('welcome charcoal','#314344'),.008);o.rotation_euler.x=-.16
 for x in [-4.96,-4.32]:curve('A-frame support',[(x,-2.7,0),(x,-2.5,1.20),(x,-2.28,0)],.023,wood)
curve('A-frame brass hinge',[(-4.96,-2.49,1.20),(-4.32,-2.49,1.20)],.012,brass)
# Plants use curved leaf meshes with actual silhouettes, soil, stems and folded central veins.
def leafmesh(name,center,length,width,az,tilt,material):
 d=Vector((math.cos(az)*math.cos(tilt),math.sin(az)*math.cos(tilt),math.sin(tilt)));right=Vector((-math.sin(az),math.cos(az),0));normal=d.cross(right).normalized();c=Vector(center)
 v=[];faces=[]
 for j in range(9):
  t=j/8;spread=math.sin(math.pi*t)**.8*width*.5
  spine=c+d*length*t+normal*(math.sin(math.pi*t)*width*.15)-Vector((0,0,length*.17*t*t))
  v.extend([spine-right*spread-normal*spread*.13,spine,spine+right*spread-normal*spread*.13])
 for j in range(8):
  a=j*3;b=(j+1)*3;faces.extend([(a,b,b+1),(a,b+1,a+1),(a+1,b+1,b+2),(a+1,b+2,a+2)])
 me=bpy.data.meshes.new(name);me.from_pydata(v,[],faces);me.update();o=bpy.data.objects.new(name,me);sc.collection.objects.link(o);assign(o,material)
 for face in me.polygons:face.use_smooth=True
 return o
potmats=[mat('terracotta','#b28869',.75),ceramic,mat('celadon planter','#9ca88a',.4)]
def plant(name,x,y,z,size=.7,trailing=False):
 rad=size*.15;height=size*.26;lathe(name+' ceramic pot',(x,y,z),[(0,0),(rad*.75,0),(rad,height*.92),(rad*1.04,height),(rad*.93,height+.013),(rad*.88,height*.95),(rad*.8,.06),(0,.06)],R.choice(potmats))
 cylinder(name+' soil',(x,y,z+height-.017),rad*.90,.018,soil)
 for j in range(8 if trailing else 11):
  a=j*2.399+R.random()*.25
  if trailing:
   endz=z+height-size*(.45+R.random()*.95);endx=x+math.cos(a)*rad*1.3;endy=y-.14+math.sin(a)*rad*.4
   pts=[(x,y,z+height),(endx,endy,z+height+.07),(endx+.07*math.cos(a),endy-.05,(z+height+endz)/2),(endx,endy,endz)]
  else:
   h=size*(.5+R.random()*.62);pts=[(x,y,z+height),(x+math.cos(a)*rad*.75,y+math.sin(a)*rad*.75,z+height+h)]
  curve(name+' stem',pts,max(.002,size*.004),leaves[4])
  steps=6 if trailing else 5
  for k in range(steps):
   t=(k+.8)/(steps+.3)
   if trailing:
    base=Vector(pts[1]).lerp(Vector(pts[-1]),t)
   else:base=Vector(pts[0]).lerp(Vector(pts[-1]),t)
   for sgn in [-1,1]:leafmesh(name+' curved leaf',base,size*(.16+R.random()*.15),size*.11,a+sgn*1.2,-.25 if trailing else .24+R.random()*.5,R.choice(leaves))
 return height
for i,(x,y,z,size,trail) in enumerate([(-5.03,-3.34,.03,1.3,False),(-5.05,-.60,.03,1.3,False),(-4.95,2.50,.43,.7,False),(-4.95,4.08,.43,.8,False),(-4.43,4.48,3.5,.65,True),(-2.93,4.48,2.89,.48,True),(2.14,4.48,3.5,.65,True),(2.48,4.4,.03,1.55,False),(5.08,2.5,.03,1.7,False),(4.65,7.75,.03,1.2,False),(-4.2,.0,.804,.23,False),(3.75,-3.5,.804,.23,False),(3.75,-.1,.804,.25,False),(-4.0,-4.0,.804,.25,False)]):plant('plant '+str(i),x,y,z,size,trail)
# Hanging planters on rods near the windows, uneven trailing rhythm and visible hooks.
for i,(x,y) in enumerate([(-4.7,1.7),(-3.15,3.85),(1.75,3.85)]):
 for dx in [-.14,.14]:curve('hanging planter chain',[(x+dx,y,3.79),(x+dx*.7,y,3.05)],.004,black)
 plant('hanging ivy '+str(i),x,y,2.81,.65,True)
# Framed botanical prints on the right wall: local basis applied rather than floating wall assets.
for i,y in enumerate([-2.55,.10,2.70]):
 # Build as back-wall frame at origin, then rotate around its own center onto east wall.
 before=set(sc.objects);picture('botanical frame '+str(i),0,0,2.2,.65,.93,f'art-{i}.png')
 for o in set(sc.objects)-before:
  local=o.location.copy();o.location=Vector((5.43,y,0))+Matrix.Rotation(-math.pi/2,3,'Z')@local;o.rotation_euler.z-=math.pi/2
# Suspended dome lights modelled with lathed double skin, cap, socket, diffuser and electrical cord.
for i,(x,y,z) in enumerate([(-2.85,1.1,2.95),(.90,1.2,2.95),(-3.85,-3.05,2.86),(3.8,-2.0,2.89),(4,6.7,2.9)]):
 lathe('pendant metal shade',(x,y,z),[(.07,.24),(.12,.21),(.20,.14),(.27,.05),(.29,0),(.28,-.015),(.255,.045),(.18,.13),(.09,.19),(.07,.24)],black)
 cylinder('pendant warm interior',(x,y,z+.006),.268,.012,bulb,32)
 cylinder('pendant suspension socket',(x,y,z+.27),.039,.07,brass)
 curve('pendant cable',[(x,y,z+.30),(x,y,3.79)],.006,black);cylinder('ceiling rose',(x,y,3.775),.09,.04,black)
 light('pendant fixture '+str(i),(x,y,z-.04),'#ffe1a8',55,.22,'AREA',(x,y,0))
# Outdoor context is real geometry; glazing casts framed daylight patterns.
cube('exterior terrace',(-7.4,-.2,-.12),(3.4,13,.24),stone,.015)
for y in range(11):
 cube('terrace railing post',(-8.90,-5+y,.48),(.04,.04,.95),black)
for z in [.20,.85]:cube('terrace railing',(-8.9,0,z),(.04,12,.035),black)
blue=mat('sea blue','#7ab5c8',.42);cube('distant sea',(-22,1,-.42),(25,70,.05),blue,0)
for i in range(22):
 x=-22-R.random()*8;y=-15+i*1.6;h=1+R.random()*1.8;cube('far coastal house',(x,y,h/2-.25),(1.2,1.1,h),R.choice([plaster,ceramic]),.025);cube('far blue roof',(x,y,h-.15),(1.36,1.25,.12),black)
for i,y in enumerate([-5.2,-.2,4.8,9]):
 x=-9.8-R.random()*.7;curve('exterior tree trunk',[(x,y,0),(x+.1,y,2.8),(x-.1,y,4.3)],.12,walnut)
 for j in range(210):
  a=R.random()*math.tau;rr=R.random()*1.6;z=2.8+R.random()*2.0;leafmesh('exterior tree foliage',(x+math.cos(a)*rr,y+math.sin(a)*rr,z),.45,.35,R.random()*math.tau,.3,R.choice(leaves))
world=bpy.data.worlds.new('coastal blue sky');world.use_nodes=True;world.node_tree.nodes['Background'].inputs['Color'].default_value=rgba('#79b9e6');world.node_tree.nodes['Background'].inputs['Strength'].default_value=.48;sc.world=world
sun=light('late afternoon sun',(-10,-6,10),'#fff0cc',4.0,kind='SUN');sun.data.angle=.025;sun.rotation_euler=Vector((1,.40,-.62)).to_track_quat('-Z','Y').to_euler()
# World light and transmitted sun illuminate glazing; no luminous card masks the view.
light('soft interior bounce',(0,-3.5,3.5),'#fff0d5',90,5,'AREA',(0,2,.5))
# Black prop-library objects stay hidden and are not substitutes for the authored room.
cam=bpy.data.objects.new('production review camera',bpy.data.cameras.new('production review camera'));sc.collection.objects.link(cam);sc.camera=cam
views={
 'main':((2.80,-4.85,1.70),(-.15,2.5,1.57),22),
 'window-seating':((3.25,1.8,1.72),(-4.25,-.45,1.58),24),
 'counter':((-.85,-2.4,1.75),(-1.0,3.0,1.8),27),
 'depth':((-4.60,-4.40,1.75),(3.5,5.4,1.65),24),
 'ceiling':((0,0,1.0),(0,.01,3.8),16),
 'ceiling-oblique-a':((-4.6,-4.5,1.45),(1.5,1.7,3.55),18),
 'ceiling-oblique-b':((4.65,4.25,1.45),(-1.5,-1.7,3.55),18),
 'corner-front-left':((-4.9,-4.8,1.55),(.3,1.0,1.6),10.392305),
 'corner-front-right':((4.9,-4.8,1.55),(-.3,1.0,1.6),10.392305),
 'corner-back-left':((-4.9,4.4,1.55),(.3,-1.0,1.6),10.392305),
 'corner-back-right':((4.9,4.4,1.55),(-.3,-1.0,1.6),10.392305),
 'character-camera':((0,-1.58,1.42),(0,0,1.395),84),
}
sc.render.engine='CYCLES';sc.cycles.samples=24 if '--quick' in sys.argv else 64;sc.cycles.use_denoising=True;sc.cycles.max_bounces=7;sc.cycles.transparent_max_bounces=8
# Use CPU in background for reliable reproducibility; optional Metal devices when available.
try:
 prefs=bpy.context.preferences.addons['cycles'].preferences;prefs.compute_device_type='METAL';prefs.get_devices()
 enabled=False
 for dev in prefs.devices:
  dev.use=dev.type=='METAL';enabled=enabled or dev.use
 if enabled:sc.cycles.device='GPU'
except Exception:pass
sc.render.resolution_x=1200 if '--quick' in sys.argv else 1600;sc.render.resolution_y=780 if '--quick' in sys.argv else 1000;sc.render.resolution_percentage=100
sc.view_settings.view_transform='AgX';sc.view_settings.look='AgX - Medium High Contrast';sc.view_settings.exposure=.5
sc.render.image_settings.file_format='PNG';sc.render.film_transparent=False

def setview(name):
 loc,target,lens=views[name];cam.location=loc;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.lens=lens;cam.data.clip_end=200
setview('main')
# Embed all authored images so the saved source is self-contained.
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'blender/tide-cafe.blend'))
triangles=0
for o in sc.objects:
 if o.type=='MESH' and not o.hide_render:
  o.data.calc_loop_triangles();triangles+=len(o.data.loop_triangles)
metadata=dict(authoringTool='Blender '+bpy.app.version_string,script='scripts/blender/anime_cafe_room.py',reference='reference/user-cafe.png',appliedBooleanOpenings=openings,visibleMeshObjects=sum(o.type=='MESH' and not o.hide_render for o in sc.objects),baseTriangles=triangles,fixtures=fixtures,reviewCameras={k:dict(location=v[0],target=v[1],lensMm=v[2]) for k,v in views.items()},runtimeExported=False,notes=['Detailed authored room, no proxy geometry','Library props are genuine project Blender meshes','Final geometry evaluated modifiers not counted in baseTriangles','Outdoor context geometry retained in review source'])
(OUT/'blender/authoring-metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
print('AUTHORING_READY',json.dumps({k:metadata[k] for k in ['appliedBooleanOpenings','visibleMeshObjects','baseTriangles']}),flush=True)
selected=list(views) if '--all' in sys.argv else ['main','window-seating','counter','depth']
if '--one' in sys.argv:selected=[sys.argv[sys.argv.index('--one')+1]]
for name in selected:
 setview(name);sc.render.filepath=str(OUT/'renders'/f'blender-{name}.png');print('RENDER_START',name,flush=True);bpy.ops.render.render(write_still=True);print('RENDER_DONE',name,flush=True)
print('DELIVERY',str(OUT/'blender/tide-cafe.blend'),flush=True)
