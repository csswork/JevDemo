from PIL import Image,ImageDraw,ImageFont
from pathlib import Path
P=Path(__file__).resolve().parent
font=ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc',22)
W=1600;top=Image.open(P/'blender-main.png').convert('RGB');top.thumbnail((1600,1000));sheet=Image.new('RGB',(1600,1380),'#eeeae0');sheet.paste(top,(0,0));d=ImageDraw.Draw(sheet)
def label(x,y,text):
 bb=d.textbbox((0,0),text,font=font);d.rounded_rectangle((x,y,x+bb[2]+24,y+38),radius=4,fill='#293b36');d.text((x+12,y+4),text,font=font,fill='white')
label(16,948,'角度 1：主视角 · Blender 实际渲染')
for i,(name,title) in enumerate([('window-seating','角度 2：窗边座位'),('counter','角度 3：正对收银台'),('depth','角度 4：纵深座位区')]):
 im=Image.open(P/f'blender-{name}.png').convert('RGB');im=im.resize((528,330),Image.Resampling.LANCZOS);x=i*536;sheet.paste(im,(x,1008));label(x+8,1340,title)
sheet.save(P/'blender-review-sheet.jpg',quality=94)
print('review sheet saved')
