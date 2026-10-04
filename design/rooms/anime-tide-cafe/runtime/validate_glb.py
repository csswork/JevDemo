"""Inspect actual exported GLBs, including privacy glazing and memory budgets."""
import struct,json,io,hashlib
from pathlib import Path
from PIL import Image
root=Path(__file__).resolve().parents[4];out={}
for p in (root/'public/scene/models/anime_cafe').glob('*.glb'):
 b=p.read_bytes();size,kind=struct.unpack_from('<II',b,12);j=json.loads(b[20:20+size]);binary=b[28+size:];images=[]
 for im in j.get('images',[]):
  v=j['bufferViews'][im['bufferView']];pic=Image.open(io.BytesIO(binary[v.get('byteOffset',0):v.get('byteOffset',0)+v['byteLength']]));images.append(list(pic.size))
 render=[n for n in j['nodes'] if n.get('extras',{}).get('runtimeKind') not in ['collision',None]];colliders=[n for n in j['nodes'] if n.get('extras',{}).get('runtimeKind')=='collision'];privacy=[n for n in render if n.get('extras',{}).get('runtimeKind')=='window-glass'];clear=[n for n in render if n.get('extras',{}).get('runtimeKind')=='glass']
 tri=sum(j['accessors'][pr['indices']]['count']//3 for n in render for pr in j['meshes'][n['mesh']]['primitives']);draws=sum(len(j['meshes'][n['mesh']]['primitives']) for n in render)
 out[p.name]={'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'renderTriangles':tri,'renderPrimitives':draws,'colliders':len(colliders),'privacyGlassBatches':len(privacy),'clearGlassBatches':len(clear),'textureDimensions':images,'decodedTextureBytes':sum(w*h*4 for w,h in images)}
 assert len(colliders)==20 and draws<=40 and tri<=350000 and len(privacy)==1 and clear
 assert out[p.name]['decodedTextureBytes']<=24000000
assert out['room-low.glb']['bytes']<8000000
Path(__file__).with_name('glb-validation.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
