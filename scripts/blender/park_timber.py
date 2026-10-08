"""Natural park timber: original wood texture, fitted boards and restrained joinery.
Run sample_park_paths.mjs, then Blender -b --factory-startup -P this file.
Project-authored geometry. Metres; Z up, -Y is runtime +Z. No external assets.
"""
import bpy, bmesh, math, os, json, random
from mathutils import Vector
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'../..'))
DOC=os.path.join(ROOT,'design/park-timber')
OUT=os.path.join(ROOT,'public/scene/models/park')
random.seed(3817)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
wood=bpy.data.materials.new('park_wood');wood.diffuse_color=(1,1,1,1)
metal=bpy.data.materials.new('park_metal');metal.diffuse_color=(.045,.055,.055,1)
for mat in [wood,metal]:
    mat.use_nodes=True
    attr=mat.node_tree.nodes.new('ShaderNodeVertexColor');attr.layer_name='Col'
    bsdf=mat.node_tree.nodes.get('Principled BSDF')
    mat.node_tree.links.new(attr.outputs['Color'],bsdf.inputs['Base Color'])
parts=[]

def finish(name,bevel=0):
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts:o.select_set(True)
    bpy.context.view_layer.objects.active=parts[0]
    if len(parts)>1:bpy.ops.object.join()
    o=bpy.context.object;o.name=name
    if bevel:
        m=o.modifiers.new('Subtle worn arris','BEVEL');m.width=bevel;m.segments=1
        bpy.ops.object.modifier_apply(modifier=m.name)
    for p in o.data.polygons:p.use_smooth=True
    m=o.modifiers.new('Broad flat faces, soft edges','WEIGHTED_NORMAL');m.keep_sharp=True;m.weight=35
    bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.context.scene.cursor.location=(0,0,0);bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    parts.clear();return o

def mesh_piece(points,faces,mat=wood,axis=(1,0,0),cross=(0,1,0),offset=None):
    me=bpy.data.meshes.new('timber');me.from_pydata(points,[],faces);me.update()
    # Consistent outward normals, including clipped walkway polygons.
    bm=bmesh.new();bm.from_mesh(me);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(me);bm.free()
    o=bpy.data.objects.new('piece',me);bpy.context.collection.objects.link(o);me.materials.append(mat)
    uv=me.uv_layers.new();col=me.color_attributes.new(name='Col',type='FLOAT_COLOR',domain='CORNER')
    axis=Vector(axis).normalized();cross=Vector(cross).normalized()
    centre=sum((v.co for v in me.vertices),Vector())/len(me.vertices)
    # The source photo has ~79px-wide planks. Sample inside a single board.
    row=random.randrange(12);vcentre=(80+row*79)/1024
    uoffset=random.random() if offset is None else offset
    tone=random.uniform(.965,1)
    for p in me.polygons:
        end=abs(p.normal.dot(axis))>.8
        for li in p.loop_indices:
            v=me.vertices[me.loops[li].vertex_index].co-centre
            longitudinal=v.dot(axis) if not end else v.dot(axis.cross(cross))
            transverse=v.dot(axis.cross(cross)) if abs(p.normal.dot(cross))>.7 and not end else v.dot(cross)
            uv.data[li].uv=(longitudinal/1.8+uoffset,vcentre+max(-.031,min(.031,transverse/1.8)))
            shade=tone*(.94 if p.normal.z<-.5 else 1)
            col.data[li].color=(shade,shade,shade,1)
    parts.append(o);return o

def prism(poly,bottom,top,axis=(1,0,0),cross=(0,1,0)):
    n=len(poly)
    pts=[(x,y,bottom) for x,y in poly]+[(x,y,top) for x,y in poly]
    faces=[tuple(range(n-1,-1,-1)),tuple(range(n,n*2))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh_piece(pts,faces,axis=axis,cross=cross)

def box(w,d,h,x=0,y=0,z=0,mat=wood,bevel=.004,tilt=0):
    # Local coordinates keep grain aligned when a brace is rotated.
    o=prism([(-w/2,-d/2),(w/2,-d/2),(w/2,d/2),(-w/2,d/2)],-h/2,h/2,
        axis=(0,0,1) if h>max(w,d) else ((0,1,0) if d>w else (1,0,0)),
        cross=(1,0,0) if h>max(w,d) or d>w else (0,1,0))
    o.data.materials.clear();o.data.materials.append(mat)
    bpy.context.view_layer.objects.active=o;o.select_set(True)
    if bevel:
        m=o.modifiers.new('Eased timber edges','BEVEL');m.width=min(bevel,min(w,d,h)*.22);m.segments=2
        bpy.ops.object.modifier_apply(modifier=m.name)
    o.location=(x,y,z);o.rotation_euler.x=tilt
    return o

def rail(points,radius=.019,mat=metal,sides=8):
    # Low-sided swept rail, smoothly changing tangent rather than square elbows.
    verts=[]
    for i,p in enumerate(points):
        p=Vector(p);t=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(i-1,0)])
        t.normalize();a=t.cross(Vector((1,0,0)))
        if a.length<.01:a=t.cross(Vector((0,1,0)))
        a.normalize();b=t.cross(a).normalized()
        for k in range(sides):verts.append(p+radius*(math.cos(k*math.tau/sides)*a+math.sin(k*math.tau/sides)*b))
    faces=[tuple(range(sides-1,-1,-1)),tuple(range((len(points)-1)*sides,len(points)*sides))]
    faces += [(i*sides+k,i*sides+(k+1)%sides,(i+1)*sides+(k+1)%sides,(i+1)*sides+k) for i in range(len(points)-1) for k in range(sides)]
    return mesh_piece(verts,faces,mat,axis=Vector(points[-1])-Vector(points[0]),cross=(1,0,0))

def clip(poly,axis,bound,greater):
    if not poly:return []
    result=[]
    for a,b in zip(poly,poly[1:]+poly[:1]):
        ia=(a[axis]>=bound) if greater else (a[axis]<=bound)
        ib=(b[axis]>=bound) if greater else (b[axis]<=bound)
        if ia:result.append(a)
        if ia!=ib:
            t=(bound-a[axis])/(b[axis]-a[axis]);result.append([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t])
    return result

def outside_deck(poly):
    # Subtract the rectangular platform; leave fitted ends, not missing whole planks.
    out=[]
    for axis,bound,inside_greater in [(0,-3.2,True),(0,2.8,False),(1,-2.2,True),(1,2.2,False)]:
        part=clip(poly,axis,bound,not inside_greater)
        if len(part)>=3:out.append(part)
        poly=clip(poly,axis,bound,inside_greater)
    return out

layout=json.load(open(os.path.join(DOC,'layout.json')))
# Staggered deck joints; no implausible six-metre single boards.
rows=32;pitch=4.4/rows
for row in range(rows):
    y=-2.2+row*pitch;cuts=[-3.2]
    x=-3.2+[1.45,2.1,1.85,2.35][row%4]
    while x<2.6:cuts.append(x);x+=1.95+random.uniform(-.22,.22)
    cuts.append(2.8)
    for a,b in zip(cuts,cuts[1:]):
        prism([(a+.002,y+.002),(b-.002,y+.002),(b-.002,y+pitch-.002),(a+.002,y+pitch-.002)],-.065,0)
finish('deck_boards',.0018)
for path in layout['paths']:
    for poly in path['boards']:
        across=Vector((*poly[1],0))-Vector((*poly[0],0));along=Vector((*poly[3],0))-Vector((*poly[0],0))
        for piece in outside_deck(poly):
            area=abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(piece,piece[1:]+piece[:1])))/2
            if area>.0002:prism(piece,-.067,-.002,across,along)
    finish(path['name']+'_boards',.0015)

# Low platform table / seat: three broad boards and restrained trestle joinery.
for k in range(3):box(1.3,.161,.068,y=(k-1)*.166,z=.454,bevel=.006)
for x in [-.43,.43]:
    box(.08,.43,.065,x=x,z=.388)
    for sign in [-1,1]:
        leg=box(.07,.065,.34,x=x,y=sign*.15,z=.19,bevel=.004)
        leg.rotation_euler.x=sign*.12
    box(.085,.37,.04,x=x,z=.105,bevel=.003)
box(.97,.052,.067,z=.19,bevel=.003)
finish('low_table')

# A compact three-legged round stool; the top is built from real sawn boards.
circle=[(.215*math.cos(i*math.tau/40),.215*math.sin(i*math.tau/40)) for i in range(40)]
for a,b in [(-.23,-.072),(-.068,.068),(.072,.23)]:
    poly=clip(clip(circle,1,a,True),1,b,False)
    prism(poly,.423,.48)
for k in range(3):
    a=k*math.tau/3+.2
    foot=(.165*math.cos(a),.165*math.sin(a),.018)
    top=(.12*math.cos(a),.12*math.sin(a),.425)
    rail([foot,top],.023,wood,12)
    b=(k+1)*math.tau/3+.2
    rail([(.146*math.cos(a),.146*math.sin(a),.18),(.146*math.cos(b),.146*math.sin(b),.18)],.012,wood,8)
finish('round_stool',.003)

# Bench slats follow a shallow seat scoop and a reclined back.
for k in range(5):
    y=-.20+k*.095;z=.456+.025*((y+.025)/.24)**2
    box(1.56,.089,.038,y=y,z=z,tilt=-(y+.025)*.23,bevel=.006)
for k in range(4):box(1.56,.034,.096,y=.27+k*.021,z=.59+k*.103,tilt=math.radians(-11),bevel=.005)
for x in [-.64,.64]:
    rail([(x,-.20,.018),(x,-.17,.25),(x,-.16,.397),(x,-.10,.416),(x,.14,.41),(x,.225,.43),(x,.315,.60),(x,.37,.92)],.022)
    rail([(x,.245,.018),(x,.205,.22),(x,.18,.415)],.022)
    rail([(x,-.13,.41),(x,-.17,.57),(x,-.145,.64),(x,-.09,.66),(x,.19,.66),(x,.327,.72)],.017)
    box(.064,.30,.025,x=x,y=.025,z=.673,bevel=.008)
rail([(-.64,.15,.27),(.64,.15,.27)],.017)
finish('garden_bench')

os.makedirs(OUT,exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(DOC,'park-timber.blend'))
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT,'timber.glb'),export_format='GLB',export_yup=True,export_normals=True,export_texcoords=True,export_materials='EXPORT')
print('PARK_TIMBER_READY')
