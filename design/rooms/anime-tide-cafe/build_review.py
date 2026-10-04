"""Rebuild the Function review from shared procedural concept geometry; no final assets."""
import json, math, subprocess
from pathlib import Path
P=Path(__file__).resolve().parent

def read(name): return json.loads((P/name).read_text())
def write(name,data): (P/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
parts=[]
def box(owner,color,pos,size,layer='lower-room',ry=0): parts.append(dict(owner=owner,kind='box',color=color,position=pos,size=size,layer=layer,rotationY=ry))
def cyl(owner,color,pos,r,h,layer='lower-room',top=None): parts.append(dict(owner=owner,kind='cylinder',color=color,position=pos,radius=r,radiusTop=r if top is None else top,height=h,layer=layer,rotationY=0))
cream='#eee4ce'; wood='#976c47'; dark='#514039'; green='#839b82'; blue='#91bfc7'; brass='#bc9163'
# Concept substrate segments intentionally surround real openings; final Blender will use Boolean cutters.
box('floor',wood,[0,-.1,0],[10,.2,10])
box('back-wall',cream,[0,1.65,-5.1],[10.4,3.3,.2])
box('right-wall',cream,[5.1,1.65,0],[.2,3.3,10])
box('left-sill',cream,[-5.1,.4,0],[.2,.8,10])
box('left-header',cream,[-5.1,3.05,0],[.2,.5,10])
for z,d in [(-4.6,.8),(-.2,1.2),(4.4,1.2)]: box('left-pier',cream,[-5.1,1.8,z],[.2,2,d])
for x,w in [(-3.15,3.7),(3.15,3.7)]: box('front-wall',cream,[x,1.65,5.1],[w,3.3,.2])
box('arrival-header',cream,[0,3.05,5.1],[2.6,.5,.2])
box('apron','#c6c1b3',[0,-.08,5.75],[4.2,.16,1.5])
box('ceiling',cream,[0,3.4,0],[10.4,.2,10.4],'reflected-ceiling')
for z in [-3.8,-1.4,1.4,3.8]: box('ceiling-beam',dark,[0,3.23,z],[10,.14,.14],'reflected-ceiling')
for z in [-2.5,2.1]:
 for zz in [z-1.7,z+1.7]: box('window-frame',dark,[-4.98,1.8,zz],[.12,2.05,.09])
 for y in [.8,2.8]: box('window-frame',dark,[-4.98,y,z],[.12,.09,3.4])
 box('window-mullion',dark,[-4.98,1.8,z],[.12,2,.065])
 box('window-transom',dark,[-4.98,2.3,z],[.12,.065,3.4])
 box('glass',blue,[-5.06,1.8,z],[.02,1.94,3.3])
# Service counter: fluted green fronts, light oak top, brass foot rail.
box('counter',green,[0,.51,-3.15],[6.4,1.02,.85])
box('counter',wood,[0,1.055,-3.15],[6.56,.07,1.02])
for x in [i*.2-3.1 for i in range(32)]: box('counter',green,[x,.55,-2.70],[.05,.8,.025])
box('counter',brass,[0,.13,-2.53],[6.25,.04,.04])
box('back-shelf',dark,[2.5,1.85,-4.94],[2.7,.06,.30])
for x in [1.6,1.9,2.2,2.5,2.8,3.1]: cyl('shelf-cup',cream,[x,1.94,-4.83],.055,.12)
box('menu',dark,[-2.7,2.05,-4.94],[1.55,.95,.07])
box('menu',green,[-2.7,2.05,-4.89],[1.43,.83,.025])
box('espresso',cream,[2.1,1.33,-3.15],[.78,.48,.45])
box('espresso',dark,[2.1,1.31,-2.91],[.70,.27,.04])
box('espresso',brass,[2.1,1.10,-2.80],[.73,.035,.30])
for x in [1.91,2.28]: cyl('espresso',dark,[x,1.19,-2.76],.038,.10)
for x in [-2.3,-1.95,-1.6]:
 cyl('pastry',cream,[x,1.11,-3.1],.13,.025)
 cyl('pastry','#d6a06c',[x,1.17,-3.1],.09,.09,top=.055)
# Three conversation groups leave the central character/camera reserve empty.
instances=[]
instances.append(dict(id='service-counter',assetId='counter',position=[0,0,-3.15],rotationY=0))
instances.append(dict(id='coffee-machine',assetId='espresso',position=[2.1,1.09,-3.15],rotationY=0))
for i,(x,z) in enumerate([(-3.35,-1.1),(-3.35,2.3),(3.4,1.8)]):
 owner=f'table-{i}'
 cyl(owner,wood,[x,.755,z],.59,.06); cyl(owner,brass,[x,.37,z],.055,.71); cyl(owner,dark,[x,.04,z],.29,.08)
 instances.append(dict(id=owner,assetId='table',position=[x,0,z],rotationY=0))
 cyl('cup',cream,[x,.825,z],.05,.08)
 for j,sgn in enumerate([-1,1]):
  zz=z+sgn*.95; owner=f'chair-{i}-{j}'; ry=0 if sgn==-1 else math.pi
  box(owner,green,[x,.46,zz],[.46,.08,.46],ry=ry)
  box(owner,green,[x,.76,zz+sgn*.21],[.46,.52,.065],ry=ry)
  for dx in [-.17,.17]:
   for dz in [-.17,.17]: box(owner,wood,[x+dx,.21,zz+dz],[.035,.42,.035])
  instances.append(dict(id=owner,assetId='chair',position=[x,0,zz],rotationY=ry,focus=f'table-{i}'))
for i,(x,z) in enumerate([(-2.2,-3.15),(2.2,-3.15),(-3.35,-1.1),(-3.35,2.3),(3.4,1.8)]):
 owner=f'pendant-{i}'; cyl(owner,dark,[x,2.94,z],.012,.56,'reflected-ceiling'); cyl(owner,brass,[x,3.27,z],.10,.06,'reflected-ceiling'); cyl(owner,cream,[x,2.57,z],.30,.20,'reflected-ceiling',top=.10)
 instances.append(dict(id=owner,assetId='pendant',position=[x,2.47,z],rotationY=0))
for i,(x,z) in enumerate([(-4.3,-4.2),(4.2,-4.2),(-1.85,5.7),(1.85,5.7)]):
 owner=f'planter-{i}'; cyl(owner,cream,[x,.22,z],.22,.44,top=.28)
 for dx,dz,h in [(-.11,0,.76),(.10,.08,.94),(0,-.09,.68)]:
  cyl(owner,green,[x+dx,.44+h/2,z+dz],.09,h,top=.025)
 instances.append(dict(id=owner,assetId='planter',position=[x,0,z],rotationY=0))
box('shop-sign',green,[-2.9,2.1,5.23],[1.45,.55,.08])
box('entry-marker',dark,[0,.007,5.2],[2.4,.014,.6])
write('concept-geometry.json',parts)
# Project the exact vertices of each concept mesh; convex hull removes triangulation noise.
def vertices(p):
 if p['kind']=='box':
  w,h,d=p['size']; v=[(x*w/2,y*h/2,z*d/2) for x in [-1,1] for y in [-1,1] for z in [-1,1]]
 else:
  v=[(r*math.cos(i*math.tau/32),y,r*math.sin(i*math.tau/32)) for r,y in [(p['radius'],-p['height']/2),(p['radiusTop'],p['height']/2)] for i in range(32)]
 a=p['rotationY']; c,s=math.cos(a),math.sin(a); px,py,pz=p['position']
 return [(px+c*x+s*z,py+y,pz-s*x+c*z) for x,y,z in v]
def hull(points):
 pts=sorted(set(points))
 if len(pts)<3:return pts
 def cross(o,a,b):return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0])
 low=[]; high=[]
 for seq,out in [(pts,low),(pts[::-1],high)]:
  for p in seq:
   while len(out)>1 and cross(out[-2],out[-1],p)<=0:out.pop()
   out.append(p)
 return low[:-1]+high[:-1]
def svg(items,projection,path,width=900,height=760,mono=False):
 poly=[]
 for p in items:
  points=hull([projection(*v) for v in vertices(p)])
  if len(points)>2:poly.append((p,points))
 allpts=[pt for p,pts in poly for pt in pts]
 xs,ys=zip(*allpts); loX,hiX,loY,hiY=min(xs),max(xs),min(ys),max(ys)
 scale=min((width-50)/(hiX-loX),(height-50)/(hiY-loY))
 def pt(q):return f'{(q[0]-(loX+hiX)/2)*scale+width/2:.2f},{(q[1]-(loY+hiY)/2)*scale+height/2:.2f}'
 body=''.join(f'<polygon points="{" ".join(pt(q) for q in pts)}" fill="{"#eee" if mono else p["color"]}" stroke="{"#222" if mono else "#514039"}" stroke-width="{.65 if mono else .9}"/>' for p,pts in poly)
 content=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}"><rect width="100%" height="100%" fill="white"/>{body}</svg>'
 (P/path).write_text(content)
 return content
floor=[p for p in parts if p['layer']=='lower-room' and p['owner'] not in ['glass','arrival-header','left-header']]
svg(sorted(floor,key=lambda p:p['position'][1]),lambda x,y,z:(x,-z),'plans/lower-room.svg',mono=True)
svg([p for p in parts if p['layer']=='reflected-ceiling'],lambda x,y,z:(x,-z),'plans/reflected-ceiling.svg',mono=True)
svg([p for p in parts if p['position'][2]<-2.4 and p['layer']=='lower-room'],lambda x,y,z:(x,-y),'plans/back-elevation.svg',900,420,True)
svg([p for p in parts if p['position'][0]<-4.8],lambda x,y,z:(z,-y),'plans/window-elevation.svg',900,420,True)
assets=[]
for asset,desc,dim,face,front,count,poly in [
 ('counter','鼠尾草绿竖纹吧台 / 浅橡木台面 / 黄铜脚杆',[6.56,1.09,1.15],'floor','positive-z',1,8000),
 ('espresso','奶油白双头咖啡机 / 深色操作面 / 黄铜接水盘',[.78,.48,.725],'freestanding','positive-z',1,5000),
 ('table','浅木圆桌 / 单柱黄铜底座',[1.18,.785,1.18],'floor','positive-y',3,1800),
 ('chair','鼠尾草绿软垫木椅 / 直背 / 四腿',[.46,1.02,.46],'floor','positive-z',6,1800),
 ('pendant','奶油色锥形吊灯 / 黄铜灯座 / 明确吊杆',[.6,.83,.6],'ceiling','negative-y',5,1800),
 ('planter','奶油陶盆 / 三簇简化绿色叶片',[.56,1.38,.56],'floor','positive-z',4,2400)]:
 matching=[p for p in parts if p['owner']==asset or p['owner']==f'{asset}-0' or p['owner']==f'{asset}-0-0']
 svg(matching,lambda x,y,z:(.86*x-.86*z,.42*x+.42*z-y),f'images/{asset}.svg',420,340)
 assets.append(dict(id=asset,function=desc,description=desc,dimensionsMeters=dim,attachmentFace=face,semanticFront=front,**{'class':'reusable'},targetPolycount=poly,intendedInstances=count,rejectionCriteria=['尺寸偏差超过 5%','缺少支撑或部件相互融合','纹理写实感过强或对比度抢占人物面部'],image=dict(prompt=f'完整隔离展示：{desc}；二次元海边小镇风，三分之四视角，白底，结构清晰，无文字，无裁切。',generator='deterministic projection of concept-geometry.json (not AI)',source=f'images/{asset}.svg',approved=False,approvedBy=''),production=dict(method='project Blender procedural builder',externalServiceRequired=False)))
props=read('props.json');props['assets']=assets
# Template mandates Meshy even for a local-only room. Preserve zero budget, report validator incompatibility honestly.
props['generation'].update(hardCreditCeiling=0,pricingVerifiedAt='',creditsPerTexturedTask=15)
props['productionPolicy']={'method':'local-procedural','meshyEnabled':False,'spendAuthorized':False,'note':'No Meshy use planned; template-only pricing fields are unverified and not spending authority.'}
write('props.json',props)
contact='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1260 780"><rect width="1260" height="780" fill="#f5f2ea"/>'
for i,a in enumerate(assets):
 x=(i%3)*420;y=(i//3)*390
 content=(P/a['image']['source']).read_text().replace('<svg xmlns="http://www.w3.org/2000/svg"',f'<svg x="{x}" y="{y}" width="420" height="340"')
 contact+=content+f'<text x="{x+20}" y="{y+369}" font-family="sans-serif" font-size="18">{a["id"]} · {a["dimensionsMeters"]} m</text>'
contact+='</svg>'; (P/'images/contact-sheet.svg').write_text(contact)
brief=read('room-brief.json')
brief.update(purpose='独立新增二次元海边咖啡馆，服务 VRM 角色对话与环绕观景。',runtimeSurface='JevDemo React / Three.js Backdrop; proposed ID animeCafe',boundsMeters=[10,3.3,10],hero=dict(id='vrm-character',role='主视觉与对话焦点；原点 +Z 朝向',reservedBoundsMeters=[2.4,2.2,2.4]),symmetry=dict(mode='none',order=1,appliesTo=[],exceptions=['左侧海景窗与靠窗双人桌，右侧独立会话组；有意不对称。']),circulation=dict(description='正前 2.6m 入口 → 中央 2.4m 留白 → 后方吧台；桌椅位于两侧；人物后方保持 1.2m 服务净距。',minimumClearanceMeters=1.2),productionCamera=dict(viewport=[1600,900],location=[0,1.42,1.58],target=[0,1.395,0],verticalFovDegrees=24),performanceBudget=dict(maxSceneTriangles=120000,maxVLowBytes=8000000,maxHighTextureBytes=24000000),creditBudget=dict(maximumCredits=0,approvalRequired=True))
brief['artifacts'].update(floorPlan='plans/lower-room.svg',reflectedCeilingPlan='plans/reflected-ceiling.svg',wallElevations=['plans/back-elevation.svg','plans/window-elevation.svg'],visualTarget='review.html',openingContactSheet='masks/contact-sheet.svg')
brief['styleReference']={'sources':['../../../src/vrm/scenes/street.ts','../../../src/vrm/scenes/streetInterior.ts','../../../dev-out/street_v5_default.jpg'],'direction':'海边日式小镇二次元插画，奶油墙、深木窗框、绿灰软装、暖灯、淡蓝海天；保留微弱材质细节与接触阴影。','palette':[cream,wood,dark,green,blue,brass]}
write('room-brief.json',brief)
layout=read('room-layout.json');layout.update(surfaces=[dict(id='floor',size=[10,.2,10],position=[0,-.1,0]),dict(id='ceiling',size=[10.4,.2,10.4],position=[0,3.4,0])]+[dict(id=id,thicknessMeters=.2) for id in ['back-wall','left-wall','right-wall','front-wall']],instances=instances,productionCamera=brief['productionCamera']);layout['conceptGeometry']='concept-geometry.json';write('room-layout.json',layout)
plan=read('plan-metadata.json');plan['coverage']=['room-outline','cutouts','openings','exterior-apron','main-sign','ingress-props','floor-markers','barriers','columns','circulation','placed-features'];plan['geometrySource']='concept-geometry.json';plan['features']=[dict(id=p['owner'],position=p['position'],layer=p['layer']) for p in parts];plan['notes']={'barriers':'continuous wall substrates with scheduled apertures','columns':'none','circulation':'central x ±1.2 corridor','heroReserve':'x/z ±1.2; only character permitted','planScope':'Function concept mesh projections, not final production meshes'};write('plan-metadata.json',plan)
ops=read('openings.json');ops['primaryArrival']={'openingId':'arrival','exception':''};ops['openings']=[]
for id,kind,w,h,sill,wall,center,dest in [('arrival','door',2.6,2.8,0,'front-wall',[0,1.4,5.1],'Visible 1.5m exterior apron and coastal street'),('sea-window-a','window',3.4,2,.8,'left-wall',[-5.1,1.8,-2.5],'Coastal sky, sea, far town'),('sea-window-b','window',3.4,2,.8,'left-wall',[-5.1,1.8,2.1],'Coastal sky, sea, far town')]:
 ops['openings'].append(dict(id=id,kind=kind,widthMeters=w,heightMeters=h,sillMeters=sill,thresholdMeters=0,depthMeters=.2,wallId=wall,center=center,destination=dest,mask=f'masks/{id}.png',cutter=f'masks/{id}.json',approved=False))
write('openings.json',ops)
reviews=read('milestone-reviews.json');reviews['function'].update(evidence=['review.html','images/contact-sheet.svg','plans/lower-room.svg','plans/reflected-ceiling.svg','masks/contact-sheet.svg'],strangestElement='海景窗必须提供真正可见的外部景深，不能用实墙上的贴画冒充窗。',notes='等待用户确认布局、道具和开口。预览是功能设计模型；最终 Blender 结构、材质、运行时接入均未开始。')
write('milestone-reviews.json',reviews)
report=read('final-report.json');report['postmortem']['remainingRisks']=['Function approval pending','Local-only zero-spend workflow conflicts with validator mandatory Meshy credit fields','Concept preview does not prove final VRM camera fit','Final walls require evaluated Blender Booleans before export'];write('final-report.json',report)
(P/'README.md').write_text('''# 潮汐咖啡馆 · Function 设计审阅\n\n这是独立新增场景的可审阅方案，尚未接入背景选择器。\n\n用项目 `npm run dev` 后打开 `/design/rooms/anime-tide-cafe/review.html`。\n\n- 10 × 10 × 3.3m，人物在原点，中央 2.4m 留白。\n- 后墙为绿灰吧台与留白墙面，菜单和咖啡机分居两侧。\n- 左墙两扇海景窗，两组双人桌；右侧一组双人桌。\n- 正前入口净宽 2.6m，外有 1.5m 深门前平台。\n- 五盏吊灯有可见吊杆，天花有四根细木梁。\n- 参考现有街景的海边日式小镇风格，采用奶油白、浅橡木、鼠尾草绿、淡蓝与黄铜。\n- 本地 Blender 程序建模，外部服务预算为 0。\n\n`concept-geometry.json` 是预览、正投影与道具参考的共同几何来源。`build_review.py` 可重新生成设计记录和网格投影。开口 PNG 由 `build_masks.py` 生成，再由技能自带追踪器得到切割轮廓。\n\n按技能 Function 门槛，布局、道具参考与开口需获得明确确认后才能最终搭建。Form 审阅之后才导出，Runtime 审阅之后才部署。所有记录保持 pending，未伪造批准。\n\n技能校验器强制要求 Meshy 正数预算和已验证价格，与本项目零付费本地建模方案不兼容；校验失败将如实记录，不能当作通过。\n''')
print(f'{len(parts)} concept meshes; {len(instances)} scheduled prop instances')
