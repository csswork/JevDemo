"""Small reusable, seamless color textures. No lighting or AO is painted into them."""
from PIL import Image
from pathlib import Path
import math,random
root=Path(__file__).parent
families={'oak':('#ad835a','#c8a577',True),'walnut':('#604d3b','#887057',True),'plaster':('#e5dbc6','#f1e5d0',False),'stone':('#d7c9b4','#f0e5d2',False),'fabric':('#769583','#96aa91',False)}
for name,(a,b,wood) in families.items():
 ca=tuple(int(a[i:i+2],16) for i in (1,3,5));cb=tuple(int(b[i:i+2],16) for i in (1,3,5));image=Image.new('RGB',(512,512));px=image.load()
 for y in range(512):
  for x in range(512):
   u=x/512;v=y/512
   if wood:
    warp=u+.006*math.sin(2*math.pi*v)+.003*math.sin(6*math.pi*v+2*math.pi*u)
    f=.5+.16*math.sin(2*math.pi*warp*23)+.07*math.sin(2*math.pi*warp*71)+.035*math.sin(2*math.pi*(u*7+v))
   else:
    f=.5+.06*math.sin(2*math.pi*(u*7+v*3))+.025*math.sin(2*math.pi*(u*43-v*37))
    if name=='fabric':f+=.035*math.sin(2*math.pi*u*128)*math.sin(2*math.pi*v*128)
   px[x,y]=tuple(round(ca[i]*(1-f)+cb[i]*f) for i in range(3))
 image.save(root/('runtime-'+name+'.png'))
