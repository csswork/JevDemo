import bpy, numpy as np, math, os, json
ROOT=os.path.dirname(os.path.abspath(__file__))
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
# Hand-authored repeat: floral embroidery, fine diagonal lace net, open lower hem.
S=1024;y,x=np.mgrid[0:S,0:S];u=x/(S-1);v=y/(S-1);a=(u*10)%1-.5;b=(v*4)%1-.5;r=np.sqrt(a*a+b*b);theta=np.arctan2(b,a)
petal=np.exp(-((r-(.19+.055*np.cos(theta*6)))/.014)**2)
centre=np.exp(-((r-.055)/.01)**2)
net=np.maximum(np.exp(-(np.sin((a+b)*math.pi*6)/.12)**2),np.exp(-(np.sin((a-b)*math.pi*6)/.12)**2))*.32
threads=np.maximum(np.maximum(petal,centre),net)
height=threads*.75+(np.sin(x*2)*np.sin(y*2)*.04)
base=np.array([.68,.50,.47]);thread=np.array([.95,.86,.78]);rgb=base[None,None,:]*(1-threads[:,:,None]*.68)+thread[None,None,:]*threads[:,:,None]*.68
alpha=np.where(v>.20,1,np.clip(threads*3.8,0,1));rgba=np.dstack((rgb,alpha)).astype(np.float32)
def save(name,pixels):
 im=bpy.data.images.new(name,width=S,height=S,alpha=True);im.pixels.foreach_set(pixels.ravel());im.filepath_raw=ROOT+'/'+name+'.png';im.file_format='PNG';im.save();im.pack();return im
color=save('rose-lace-color',rgba)
dy,dx=np.gradient(height);normal=np.dstack((-dx*1.8,-dy*1.8,np.ones_like(dx)));normal/=np.linalg.norm(normal,axis=2)[:,:,None];normal=save('rose-lace-normal',np.dstack((normal*.5+.5,np.ones_like(dx))).astype(np.float32));normal.colorspace_settings.name='Non-Color'
mat=bpy.data.materials.new('Rose floral lace with sheer scalloped hem');mat.use_nodes=True;nt=mat.node_tree;bs=nt.nodes.get('Principled BSDF');bs.inputs['Roughness'].default_value=.88
tex=nt.nodes.new('ShaderNodeTexImage');tex.image=color;nt.links.new(tex.outputs['Color'],bs.inputs['Base Color']);nt.links.new(tex.outputs['Alpha'],bs.inputs['Alpha']);texn=nt.nodes.new('ShaderNodeTexImage');texn.image=normal;nmap=nt.nodes.new('ShaderNodeNormalMap');nmap.inputs['Strength'].default_value=.6;nt.links.new(texn.outputs['Color'],nmap.inputs['Color']);nt.links.new(nmap.outputs['Normal'],bs.inputs['Normal'])
mat.surface_render_method='DITHERED';mat.diffuse_color=(.49,.35,.31,1)
N=80;R=13;verts=[];faces=[]
for j in range(R):
 t=j/(R-1);flare=max(0,(t-.48)/.52)**1.15;rx=.132+.011*t+.080*flare;rz=.103+.008*t+.045*flare
 for i in range(N):
  a=2*math.pi*i/N;fold=math.cos(12*a)*(.001+.006*t);scallop=.004*(.5+.5*math.cos(20*a))*max(0,(t-.85)/.15)
  verts.append(((rx+fold)*math.cos(a),(rz+fold)*math.sin(a),.060-.290*t-scallop))
for j in range(R-1):
 for i in range(N):k=(i+1)%N;faces.append((j*N+i,j*N+k,(j+1)*N+k,(j+1)*N+i))
m=bpy.data.meshes.new('LaceCloth');m.from_pydata(verts,[],faces);m.update();obj=bpy.data.objects.new('ClothPanel',m);bpy.context.collection.objects.link(obj);obj.data.materials.append(mat);uv=m.uv_layers.new()
for p in m.polygons:
 p.use_smooth=True;row=p.index//N;col=p.index%N
 for loop_idx,(uu,vv) in zip(p.loop_indices,[(col/N,1-row/(R-1)),((col+1)/N,1-row/(R-1)),((col+1)/N,1-(row+1)/(R-1)),(col/N,1-(row+1)/(R-1))]):uv.data[loop_idx].uv=(uu,vv)
waist=bpy.data.materials.new('Rose waist satin');waist.diffuse_color=(.23,.13,.13,1);waist.use_nodes=True;waist.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.23,.13,.13,1);waist.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.65
v=[];f=[]
for z,rx,ry in [(.063,.135,.106),(.035,.137,.108),(.063,.130,.101),(.035,.132,.103)]:
 for i in range(N):a=2*math.pi*i/N;v.append((rx*math.cos(a),ry*math.sin(a),z))
for i in range(N):
 k=(i+1)%N
 for a,b in [(0,1),(2,0),(1,3),(3,2)]:f.append((a*N+i,a*N+k,b*N+k,b*N+i))
m=bpy.data.meshes.new('Waistband');m.from_pydata(v,[],f);m.update();o=bpy.data.objects.new('Waistband',m);bpy.context.collection.objects.link(o);o.data.materials.append(waist)
for p in m.polygons:p.use_smooth=True
bpy.ops.wm.save_as_mainfile(filepath=ROOT+'/lace-skirt.blend');bpy.ops.export_scene.gltf(filepath=ROOT+'/skirt.glb',export_format='GLB',export_yup=True,export_animations=False)
json.dump({'name':'Rose floral lace skirt','columns':N,'rows':R,'lengthMeters':.29,'source':'create_lace.py','license':'Original geometry and procedural textures created for this project','physics':'PBD, 60 Hz, waist anchors, calibrated pelvis and leg capsules, ground'},open(ROOT+'/asset.json','w'),indent=2)
