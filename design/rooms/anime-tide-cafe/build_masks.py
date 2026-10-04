"""Create binary masks; exact rectangular outlines remain provisional until skill tracing."""
import json
from pathlib import Path
from PIL import Image, ImageDraw
P=Path(__file__).resolve().parent
schedule=json.loads((P/'openings.json').read_text())
body='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 480"><rect width="1200" height="480" fill="white"/>'
for i,op in enumerate(schedule['openings']):
 img=Image.new('L',(256,256),0);ImageDraw.Draw(img).rectangle((1,1,254,255 if op['kind']=='door' else 254),fill=255);img.save(P/op['mask'])
 x=i*400
 body+=f'<rect x="{x+30}" y="30" width="340" height="340" fill="black"/><rect x="{x+46}" y="46" width="308" height="{324 if op["kind"]=="door" else 308}" fill="white"/><text x="{x+30}" y="408" font-family="sans-serif" font-size="18">{op["id"]} · {op["widthMeters"]} × {op["heightMeters"]} m</text><text x="{x+30}" y="438" font-family="sans-serif" font-size="16">sill {op["sillMeters"]} m · wall depth 0.2 m</text>'
(P/'masks/contact-sheet.svg').write_text(body+'</svg>')
