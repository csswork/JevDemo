from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import random,math
P=Path(__file__).resolve().parent
font='/System/Library/Fonts/Supplemental/Arial.ttf'
def f(n):return ImageFont.truetype(font,n)
im=Image.new('RGB',(1536,900),'#243332');d=ImageDraw.Draw(im)
r=random.Random(19)
for i in range(7000):
 x,y=r.randrange(1536),r.randrange(900);d.point((x,y),fill=(45+r.randrange(9),59+r.randrange(7),55+r.randrange(7)))
d.rounded_rectangle((35,35,1500,865),radius=12,outline='#b8a987',width=3)
d.text((90,74),'TIDE & LEAF',font=f(76),fill='#e3d4b1');d.text((93,166),'COFFEE  /  PATISSERIE',font=f(28),fill='#c5b48e')
d.line((88,222,1440,222),fill='#bfaf8d',width=2)
for i,(a,b,c,e) in enumerate([('Espresso','22','Butter croissant','18'),('Americano','24','Strawberry tart','32'),('Cafe latte','30','Lemon cheesecake','28'),('Cappuccino','30','Chocolate gateau','30'),('Matcha latte','32','Seasonal fruit cake','34'),('Pour over','36','Afternoon tea set','68')]):
 y=290+i*80;d.text((90,y),a,font=f(38),fill='#e6dccc');d.text((590,y),b,font=f(38),fill='#d6c393');d.text((790,y),c,font=f(34),fill='#e6dccc');d.text((1340,y),e,font=f(36),fill='#d6c393');d.line((90,y+55,660,y+55),fill='#54615a');d.line((790,y+55,1430,y+55),fill='#54615a')
d.text((96,806),'Slow mornings, good coffee, a little sea breeze.',font=f(26),fill='#bfc7b8');im.save(P/'menu.png')
for i in range(3):
 im=Image.new('RGB',(512,680),'#e8dfc7');d=ImageDraw.Draw(im)
 if i<2:
  d.ellipse((80,80,440,430),fill=['#c1d3c1','#d0daca'][i]);d.line((260,600,245,150),fill='#597351',width=6)
  for j in range(7):
   y=215+j*46;side=-1 if j%2 else 1;x=250+side*65;d.ellipse((x-58,y-30,x+58,y+20),fill=['#718c68','#8b9c6b'][j%2]);d.line((245,y+15,x,y),fill='#597351',width=4)
  d.text((88,625),['BOTANICAL STUDY','GARDEN NOTES'][i],font=f(22),fill='#5c6657')
 else:
  d.rectangle((30,70,480,370),fill='#9ac9df');d.rectangle((30,370,480,590),fill='#8eafb2');d.polygon([(30,370),(150,225),(270,320),(400,200),(480,355)],fill='#90a58a');d.polygon([(30,420),(140,365),(250,375),(370,355),(480,405)],fill='#b2c0ab');d.text((110,625),'COASTAL AFTERNOON',font=f(22),fill='#5c6657')
 im.save(P/f'art-{i}.png')
print('menu and three illustrated wall prints created')
