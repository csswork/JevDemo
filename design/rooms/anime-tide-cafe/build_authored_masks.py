from PIL import Image,ImageDraw,ImageFont
from pathlib import Path
import json,math,subprocess,os
P=Path(__file__).resolve().parent
script=Path('/Users/haibo/.codex/plugins/cache/openai-curated-remote/build-3d-game-rooms/0.3.3/skills/build-3d-game-rooms/scripts/trace_opening_mask.py')
python='/Users/haibo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'
font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',20)
sheet=Image.new('RGB',(1020,830),'white');draw=ImageDraw.Draw(sheet)
for i,o in enumerate(json.loads((P/'openings.json').read_text())['openings']):
 W,H=384,640;im=Image.new('L',(W,H),0);d=ImageDraw.Draw(im)
 if o['id']=='rear-seat-arch':
  pts=[(1,639),(382,639),(382,1+(1-2.22/3.15)*638)]
  for j in range(1,65):
   a=j*math.pi/64;x=3.85+.93*math.cos(a);z=2.22+.93*math.sin(a);pts.append((round(1+(x-(3.85-.93))/1.86*381),round(1+(1-z/3.15)*638)))
  d.polygon(pts,fill=255)
 else:d.rectangle((1,1,382,639 if o['kind']=='door' else 638),fill=255)
 im.save(P/o['mask'])
 inputw=o['widthMeters']*383/381;inputh=o['heightMeters']*639/(638 if o['kind']=='door' else 637)
 env=os.environ.copy();env['PYTHONPATH']='/private/tmp/jev-room-tracing'
 subprocess.run([python,str(script),str(P/o['mask']),'--id',o['id'],'--kind',o['kind'],'--width-m',str(inputw),'--height-m',str(inputh),'--sill-m',str(o['sillMeters']),'--out',str(P/o['cutter']),'--preview',str(P/'masks'/f'authored-{o["id"]}-trace.png')],env=env,check=True)
 x=(i%3)*340+24;y=(i//3)*410+15
 thumb=im.convert('RGB');thumb.thumbnail((285,320));sheet.paste(thumb,(x+(285-thumb.width)//2,y))
 draw.text((x,y+332),o['id'],font=font,fill='black');draw.text((x,y+362),f'{o["widthMeters"]} x {o["heightMeters"]} m',font=font,fill='black')
sheet.save(P/'masks/authored-contact-sheet.png')
print('Six exact opening-mask traces complete')
