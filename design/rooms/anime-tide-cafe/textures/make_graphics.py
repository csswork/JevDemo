from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import random,math
P=Path(__file__).resolve().parent
font='/System/Library/Fonts/STHeiti Medium.ttc'
def f(n):return ImageFont.truetype(font,n)
im=Image.new('RGB',(1536,900),'#243332');d=ImageDraw.Draw(im)
r=random.Random(19)
for i in range(7000):
 x,y=r.randrange(1536),r.randrange(900);d.point((x,y),fill=(45+r.randrange(9),59+r.randrange(7),55+r.randrange(7)))
d.rounded_rectangle((35,35,1500,865),radius=12,outline='#b8a987',width=3)
d.text((90,74),'潮汐咖啡馆',font=f(76),fill='#e3d4b1');d.text((93,166),'咖啡 · 手作甜点',font=f(28),fill='#c5b48e')
d.line((88,222,1440,222),fill='#bfaf8d',width=2)
for i,(a,b,c,e) in enumerate([('浓缩咖啡','22','黄油可颂','18'),('美式咖啡','24','草莓挞','32'),('拿铁咖啡','30','柠檬芝士蛋糕','28'),('卡布奇诺','30','巧克力蛋糕','30'),('抹茶拿铁','32','时令水果蛋糕','34'),('手冲咖啡','36','下午茶套餐','68')]):
 y=290+i*80;d.text((90,y),a,font=f(38),fill='#e6dccc');d.text((590,y),b,font=f(38),fill='#d6c393');d.text((790,y),c,font=f(34),fill='#e6dccc');d.text((1340,y),e,font=f(36),fill='#d6c393');d.line((90,y+55,660,y+55),fill='#54615a');d.line((790,y+55,1430,y+55),fill='#54615a')
d.text((96,806),'慢一点，让咖啡和海风陪你。',font=f(26),fill='#bfc7b8');im.save(P/'menu.png')
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

im=Image.new('RGB',(1200,600),'#ece4d2');d=ImageDraw.Draw(im)
d.rectangle((24,24,1176,576),outline='#9d8866',width=3)
d.text((300,105),'潮汐咖啡馆',font=f(80),fill='#526855')
d.text((310,235),'一杯咖啡 · 一段慢时光',font=f(37),fill='#756753')
d.arc((100,190,265,365),0,180,fill='#526855',width=9);d.line((101,275,101,302),fill='#526855',width=8);d.line((264,275,264,302),fill='#526855',width=8);d.arc((252,270,310,330),270,90,fill='#526855',width=8);d.line((90,375,280,375),fill='#9d8866',width=6)
for x in [145,182,219]:d.arc((x,155,x+22,225),90,270,fill='#9d8866',width=4)
d.text((305,375),'欢迎坐坐，今天也辛苦了。',font=f(33),fill='#756753');im.save(P/'welcome.png')

# A small double-sided chalkboard: legible Chinese lettering and drawn ornament.
im=Image.new('RGB',(512,768),'#293c39');d=ImageDraw.Draw(im)
cream='#e7dfc4';sage='#a8c5a0';gold='#d6bd86'
d.rounded_rectangle((22,22,490,746),radius=15,outline=sage,width=3)
def centered(y,text,size,color=cream):
 box=d.textbbox((0,0),text,font=f(size));d.text(((512-(box[2]-box[0]))/2,y),text,font=f(size),fill=color)
centered(54,'潮汐咖啡馆',46);centered(125,'欢迎坐坐',28,sage)
# Cup, saucer, steam and a restrained botanical sprig, drawn as chalk strokes.
d.line((163,223,172,302,191,320,294,320,312,302,321,223,163,223),fill=cream,width=6)
d.arc((300,235,355,296),270,90,fill=cream,width=6)
d.arc((144,305,343,348),0,180,fill=gold,width=5)
for x in (199,241,283):d.arc((x,165,x+25,217),90,270,fill=sage,width=4)
centered(379,'今日推荐',38,gold)
d.line((90,437,422,437),fill=sage,width=2)
centered(459,'拿铁 + 黄油可颂',31);centered(521,'下午茶 · 慢时光',28,sage)
centered(594,'让咖啡和海风陪你',24)
for y in (680,694):
 pts=[(x,y+math.sin((x-110)/32)*5) for x in range(110,403,3)];d.line(pts,fill=gold,width=3)
for mirror in (-1,1):
 x=256+mirror*181;d.line((x,305,x-mirror*9,194),fill=sage,width=3)
 for j in range(4):
  yy=218+j*22;xx=x-mirror*(7-j*2)
  d.ellipse((xx-12,yy-7,xx+12,yy+7),outline=sage,width=3)
im.save(P/'entrance-chalkboard.png')
