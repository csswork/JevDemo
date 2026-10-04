"""
天上的积云（街景、公园共用，src/vrm/scenes/clouds.ts）：Blender 里做真正的体积云，Cycles 从六个方向各打一次光渲染，
打包成贴图集；运行时按太阳 / 月亮的方向把六张光照混起来（游戏里常用的"六向光照"云片），再乘上调色表的颜色。

    blender -b --factory-startup -P scripts/blender/clouds.py
    blender -b --factory-startup -P scripts/blender/clouds.py -- --only 0,3 --passes top --res 0.5 --samples 16   # 试渲

输出 public/scene/clouds/clouds_{a,b,c}.webp（无损）和 clouds.json。全部重渲 8 朵 × 7 次，M2 Max 上约半小时。

  形状  每朵云先用 metaball 堆出大形（底下一排、中间往上堆一两座"塔"；扁的那几朵只有一排矮的鼓包），转成体积
        （Mesh to Volume），再用两层噪声置换出大大小小的鼓包（Volume Displace）。材质的密度再乘一层细噪声
        （边上絮状），云底按高度切平。8 朵：3 朵高耸、3 朵中等、2 朵扁平
  光照  正交相机从 -Y 看（云的正面朝 -Y），每朵渲 7 次：
          右 / 左 / 上 / 下 / 前（从相机这边）/ 后（光在云背后，边缘透光）：一盏太阳光，没有天光
          天光：只有天空（上亮下暗），没有太阳
        结果是预乘透明度的（Cycles 透明背景），亮度取明度，所有方向光共用一个缩放（存进 json），天光单独一个
  打包  一格 1024×512，2 列 4 行 → 2048×2048。浏览器解码带透明通道的图片时会预乘（透明度接近 0 的像素颜色全丢），
        所以不用透明通道，三张 RGB：
          a = 右、左、上     b = 下、前、后     c = 天光、不透明度、（空）
        存的是开方后的值（暗部精度高一些），着色器里平方回来
"""
import json
import math
import os
import random
import subprocess
import sys
import tempfile
import time

import bpy
import numpy as np
import OpenImageIO as oiio
from mathutils import Vector

try:
    HERE = os.path.dirname(os.path.abspath(__file__))
except NameError:
    HERE = os.path.abspath('scripts/blender')
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_DIR = os.path.join(REPO, 'public', 'scene', 'clouds')
TMP = os.environ.get('CLOUD_TMP') or os.path.join(tempfile.gettempdir(), 'jev_clouds')

TILE_W, TILE_H = 1024, 512
COLS, ROWS = 2, 4
# 一格对应的世界尺寸（米）：宽 24、高 12，云底在 z = 0.5 附近
WIDTH = 24.0
# (种子, 高矮)
# 密度：高了边界清楚、一簇簇鼓包分明（多重散射够多的话里面照样白），低了像一团棉絮
DENSITY = 14.0
CLOUDS = [(5, 'tall'), (8, 'tall'), (13, 'tall'), (21, 'mid'), (34, 'mid'), (55, 'mid'), (89, 'flat'), (144, 'flat')]
LIGHTS = {
    'right': (1, 0, 0),
    'left': (-1, 0, 0),
    'top': (0, 0, 1),
    'bottom': (0, 0, -1),
    'front': (0, -1, 0),
    'back': (0, 1, 0),
}
PASSES = [*LIGHTS, 'sky']


def args():
    a = sys.argv[sys.argv.index('--') + 1 :] if '--' in sys.argv else []
    opt = {'only': None, 'passes': PASSES, 'res': 1.0, 'samples': 32, 'pack': True}
    i = 0
    while i < len(a):
        k = a[i]
        if k == '--only':
            opt['only'] = [int(x) for x in a[i + 1].split(',')]
            i += 1
        elif k == '--passes':
            opt['passes'] = a[i + 1].split(',')
            i += 1
        elif k == '--res':
            opt['res'] = float(a[i + 1])
            i += 1
        elif k == '--samples':
            opt['samples'] = int(a[i + 1])
            i += 1
        elif k == '--no-pack':
            opt['pack'] = False
        i += 1
    return opt


def setup(opt):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    sc = bpy.context.scene
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = 'GPU'
    except Exception as e:  # 没有 GPU 就用 CPU（慢很多）
        print('GPU 不可用：', e)
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = opt['samples']
    sc.cycles.use_denoising = True
    # 云白不白靠多重散射：反弹次数少了，里面一片灰
    sc.cycles.volume_bounces = 32
    sc.cycles.max_bounces = 32
    sc.render.film_transparent = True
    sc.render.resolution_x = round(TILE_W * opt['res'])
    sc.render.resolution_y = round(TILE_H * opt['res'])
    sc.view_settings.view_transform = 'Standard'
    s = sc.render.image_settings
    s.file_format = 'OPEN_EXR'
    s.color_depth = '16'
    s.color_mode = 'RGBA'

    cam = bpy.data.cameras.new('cam')
    cam.type = 'ORTHO'
    cam.ortho_scale = WIDTH
    co = bpy.data.objects.new('cam', cam)
    co.location = (0, -40, WIDTH / 4)
    co.rotation_euler = (math.radians(90), 0, 0)
    sc.collection.objects.link(co)
    sc.camera = co

    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 3.0
    sun.angle = math.radians(1)
    so = bpy.data.objects.new('sun', sun)
    sc.collection.objects.link(so)

    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    # 天光：上亮下暗（天顶 1、地平线 0.6、地面 0.15）—— 四面八方一样亮的话，云底也被照亮，背光面一片死灰
    wt = world.node_tree
    bg = next(n for n in wt.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (1, 1, 1, 1)
    tc = wt.nodes.new('ShaderNodeTexCoord')
    sep = wt.nodes.new('ShaderNodeSeparateXYZ')
    wt.links.new(tc.outputs['Generated'], sep.inputs[0])
    up = wt.nodes.new('ShaderNodeMapRange')
    up.interpolation_type = 'SMOOTHSTEP'
    up.inputs['From Min'].default_value = -0.15
    up.inputs['From Max'].default_value = 0.0
    up.inputs['To Min'].default_value = 0.15
    up.inputs['To Max'].default_value = 0.6
    wt.links.new(sep.outputs['Z'], up.inputs['Value'])
    top = wt.nodes.new('ShaderNodeMapRange')
    top.inputs['From Min'].default_value = 0.0
    top.inputs['From Max'].default_value = 1.0
    top.inputs['To Min'].default_value = 0.0
    top.inputs['To Max'].default_value = 0.4
    wt.links.new(sep.outputs['Z'], top.inputs['Value'])
    add = wt.nodes.new('ShaderNodeMath')
    add.operation = 'ADD'
    add.use_clamp = False
    wt.links.new(up.outputs['Result'], add.inputs[0])
    wt.links.new(top.outputs['Result'], add.inputs[1])
    on = wt.nodes.new('ShaderNodeMath')
    on.operation = 'MULTIPLY'
    wt.links.new(add.outputs[0], on.inputs[0])
    wt.links.new(on.outputs[0], bg.inputs['Strength'])
    sc.world = world
    return sc, so, on.inputs[1]


def cloud_material():
    """
    密度场（Horizon Zero Dawn 那套体积云的思路）：体积本身给一个"离表面多深"的渐变 g（Mesh to Volume 的内部过渡带，
    表面 0、往里 3 个单位到 1），再减去"侵蚀"：Voronoi 的鼓包（一簇簇花椰菜）+ 大噪声（起伏）+ 细噪声（絮状）。
    表面附近 g 小，被侵蚀得七零八落；里面 g 接近 1，基本是实的。云底按高度切平。
    密度见 DENSITY：反弹次数够（32 次）云就白；密度高一点边界才清楚
    """
    mat = bpy.data.materials.new('cloud')
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    L = nt.links.new

    def math(op, a, b=None, clamp=False):
        n = nt.nodes.new('ShaderNodeMath')
        n.operation = op
        n.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                L(v, n.inputs[i])
        return n.outputs[0]

    out = nt.nodes.new('ShaderNodeOutputMaterial')
    pv = nt.nodes.new('ShaderNodeVolumePrincipled')
    pv.inputs['Color'].default_value = (1, 1, 1, 1)
    pv.inputs['Anisotropy'].default_value = 0.5
    pv.inputs['Density Attribute'].default_value = ''
    vi = nt.nodes.new('ShaderNodeVolumeInfo')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    seeds = []

    def noise(scale, detail, rough):
        n = nt.nodes.new('ShaderNodeTexNoise')
        n.noise_dimensions = '4D'
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough
        L(tc.outputs['Object'], n.inputs['Vector'])
        seeds.append(n.inputs['W'])
        return n.outputs['Fac']

    def puffs(scale):
        """圆的鼓包：平滑 F1 的距离 d（0 在格点中心），1 − d² 是一个个圆顶"""
        v = nt.nodes.new('ShaderNodeTexVoronoi')
        v.voronoi_dimensions = '4D'
        v.feature = 'SMOOTH_F1'
        v.inputs['Scale'].default_value = scale
        v.inputs['Smoothness'].default_value = 0.6
        L(tc.outputs['Object'], v.inputs['Vector'])
        seeds.append(v.inputs['W'])
        d = v.outputs['Distance']
        return math('SUBTRACT', 1.0, math('MULTIPLY', d, d), clamp=True)

    billow = math('ADD', math('MULTIPLY', puffs(0.75), 0.75), math('MULTIPLY', puffs(1.7), 0.25))
    big = noise(0.35, 3, 0.5)
    fine = noise(2.2, 6, 0.6)
    # 侵蚀场 e（0..1，大 = 实）
    e = math('ADD', math('MULTIPLY', billow, 0.65), math('ADD', math('MULTIPLY', big, 0.23), math('MULTIPLY', fine, 0.12)))
    # d = max(0, g·2.4 − (1 − e)·0.75)：离表面半米以内被侵蚀得七零八落，再往里基本是实的
    g = vi.outputs['Density']
    d = math('SUBTRACT', math('MULTIPLY', g, 2.4), math('MULTIPLY', math('SUBTRACT', 1.0, e), 0.75), clamp=True)
    # 云底切平
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    L(tc.outputs['Object'], sep.inputs[0])
    base = nt.nodes.new('ShaderNodeMapRange')
    base.interpolation_type = 'SMOOTHSTEP'
    base.inputs['From Min'].default_value = 0.4
    base.inputs['From Max'].default_value = 1.2
    L(sep.outputs['Z'], base.inputs['Value'])
    dens = math('MULTIPLY', math('MULTIPLY', d, base.outputs['Result']), DENSITY)
    L(dens, pv.inputs['Density'])
    L(pv.outputs[0], out.inputs['Volume'])
    return mat, seeds


def build_cloud(sc, seed, kind, mat):
    """metaball 堆出大形 → 体积 → 两层噪声置换。返回要在下一朵之前删掉的物体"""
    rnd = random.Random(seed)
    mb = bpy.data.metaballs.new('mb')
    mb.resolution = 0.25
    mb.render_resolution = 0.25
    mbo = bpy.data.objects.new('mb', mb)
    sc.collection.objects.link(mbo)

    def ball(x, y, z, r):
        e = mb.elements.new()
        e.co = (x, y, z)
        e.radius = r

    def lumps(x, y, z, r, k):
        """一团的上半边再长出几个小鼓包（花椰菜）"""
        for _ in range(k):
            ang = rnd.uniform(-0.15, 1.15) * math.pi  # 偏上半边
            rr = r * rnd.uniform(0.45, 0.65)
            d = r * rnd.uniform(0.75, 0.95)
            ball(x + math.cos(ang) * d, y + rnd.uniform(-0.6, 0.6) * r, z + math.sin(ang) * d * 0.9, rr)

    # 底下一排：密一些、两头收小（不然两头是一颗颗分开的珠子）
    span = 7.5 if kind == 'flat' else 7.0
    n = 13
    for k in range(n):
        t = k / (n - 1)
        mid = 1 - abs(t - 0.5) * 2
        x = -span + 2 * span * t + rnd.uniform(-0.3, 0.3)
        r = (1.0 + 1.3 * mid ** 0.6) * (0.85 if kind == 'flat' else 1.0) + rnd.uniform(-0.15, 0.15)
        z = 1.2 + r * 0.25
        ball(x, rnd.uniform(-1.0, 1.0), z, r)
        if mid > 0.2:
            lumps(x, 0, z, r, 1)
    if kind == 'flat':
        for _ in range(4):
            x = rnd.uniform(-5, 5)
            r = rnd.uniform(1.3, 1.8)
            ball(x, rnd.uniform(-0.8, 0.8), 2.4 + rnd.uniform(0, 0.6), r)
            lumps(x, 0, 2.6, r, 2)
    else:
        hi = (7.0, 8.3) if kind == 'tall' else (4.2, 5.6)
        towers = 2 if rnd.random() < 0.6 else 1
        for k in range(towers):
            cx = rnd.uniform(-3.5, 3.5) if towers == 1 else (-3.2 + 6.4 * k + rnd.uniform(-1.0, 1.0))
            top = rnd.uniform(*hi) * (1 if k == 0 else rnd.uniform(0.65, 0.85))
            m = 6
            for i in range(m):
                t = i / (m - 1)
                r = (2.6 - 1.1 * t) * rnd.uniform(0.9, 1.1)
                x = cx + rnd.uniform(-0.9, 0.9) * (1 - 0.4 * t)
                z = 2.0 + (top - 2.0) * t
                ball(x, rnd.uniform(-0.8, 0.8), z, r)
                lumps(x, 0, z, r, 3)

    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(mbo.evaluated_get(dg))
    bpy.data.objects.remove(mbo)
    src = bpy.data.objects.new('src', me)
    sc.collection.objects.link(src)
    src.hide_render = True

    vol = bpy.data.volumes.new('cloud')
    vo = bpy.data.objects.new('cloud', vol)
    sc.collection.objects.link(vo)
    m = vo.modifiers.new('m2v', 'MESH_TO_VOLUME')
    m.object = src
    m.resolution_mode = 'VOXEL_SIZE'
    m.voxel_size = 0.07
    m.interior_band_width = 3.0
    m.density = 1.0
    # 噪声的取样点按种子错开（不然每朵云的鼓包一模一样）
    off = bpy.data.objects.new('noise_offset', None)
    sc.collection.objects.link(off)
    off.location = (rnd.uniform(-50, 50), rnd.uniform(-50, 50), rnd.uniform(-50, 50))
    for name, scale, strength in [('big', 2.6, 0.9)]:
        tex = bpy.data.textures.get(name) or bpy.data.textures.new(name, 'CLOUDS')
        tex.noise_scale = scale
        tex.noise_depth = 2
        tex.noise_type = 'SOFT_NOISE'
        d = vo.modifiers.new(name, 'VOLUME_DISPLACE')
        d.texture = tex
        d.texture_map_mode = 'OBJECT'
        d.texture_map_object = off
        d.strength = strength
        d.texture_mid_level = (0.5, 0.5, 0.5)
    vol.materials.append(mat)
    return [vo, src, off]


def render_cloud(sc, so, bg, idx, passes):
    for p in passes:
        if p == 'sky':
            so.data.energy = 0
            bg.default_value = 1.0
        else:
            so.data.energy = 3.0
            so.rotation_euler = Vector(LIGHTS[p]).to_track_quat('Z', 'Y').to_euler()
            bg.default_value = 0.0
        sc.render.filepath = os.path.join(TMP, f'cloud{idx}_{p}.exr')
        t0 = time.time()
        bpy.ops.render.render(write_still=True)
        print(f'  云 {idx} {p}: {time.time() - t0:.1f}s', flush=True)


def read(path):
    buf = oiio.ImageBuf(path)
    px = buf.get_pixels(oiio.FLOAT)  # (h, w, 4)，第一行是图的最上面
    return px


def luma(px):
    return px[..., 0] * 0.2126 + px[..., 1] * 0.7152 + px[..., 2] * 0.0722


def write_rgb(path, arr):
    """arr: (H, W, 3) 0..1 → 8 位 PNG，再转无损 WebP"""
    png = path.replace('.webp', '.png')
    spec = oiio.ImageSpec(arr.shape[1], arr.shape[0], 3, oiio.UINT8)
    out = oiio.ImageOutput.create(png)
    out.open(png, spec)
    out.write_image(np.clip(arr * 255 + 0.5, 0, 255).astype(np.uint8))
    out.close()
    subprocess.run(['cwebp', '-quiet', '-lossless', '-z', '9', png, '-o', path], check=True)
    os.remove(png)


def pack():
    """读回所有 EXR → 三张 RGB 贴图集 + json"""
    n = len(CLOUDS)
    lum = {}
    alpha = {}
    for i in range(n):
        for p in PASSES:
            px = read(os.path.join(TMP, f'cloud{i}_{p}.exr'))
            if px.shape[0] != TILE_H or px.shape[1] != TILE_W:
                raise RuntimeError(f'cloud{i}_{p}.exr 尺寸不对（试渲的？）：{px.shape}')
            lum[i, p] = luma(px)
            if p == 'top':
                alpha[i] = px[..., 3]
    # 方向光共用一个缩放（相互之间的明暗关系不能变），天光单独一个
    dir_all = np.concatenate([lum[i, p].ravel() for i in range(n) for p in LIGHTS])
    s_dir = float(np.percentile(dir_all[dir_all > 1e-4], 99.9))
    sky_all = np.concatenate([lum[i, 'sky'].ravel() for i in range(n)])
    s_sky = float(np.percentile(sky_all[sky_all > 1e-4], 99.9))
    W, H = TILE_W * COLS, TILE_H * ROWS
    atlas = {k: np.zeros((H, W, 3), np.float32) for k in 'abc'}
    chans = {
        'a': ['right', 'left', 'top'],
        'b': ['bottom', 'front', 'back'],
        'c': ['sky', 'alpha', None],
    }
    for i in range(n):
        r, c = divmod(i, COLS)
        ys, xs = slice(r * TILE_H, (r + 1) * TILE_H), slice(c * TILE_W, (c + 1) * TILE_W)
        for k, names in chans.items():
            for ch, p in enumerate(names):
                if p is None:
                    continue
                v = alpha[i] if p == 'alpha' else lum[i, p] / (s_sky if p == 'sky' else s_dir)
                atlas[k][ys, xs, ch] = np.sqrt(np.clip(v, 0, 1))
    os.makedirs(OUT_DIR, exist_ok=True)
    for k in 'abc':
        write_rgb(os.path.join(OUT_DIR, f'clouds_{k}.webp'), atlas[k])
    meta = {
        'cols': COLS,
        'rows': ROWS,
        'count': n,
        # 一格的宽高比（宽 / 高）、云底在格子里的高度（0 = 最下面）
        'aspect': TILE_W / TILE_H,
        'base': 0.5 / (WIDTH / 2),
        'kinds': [k for _, k in CLOUDS],
        # 着色器里方向光 / 天光乘回去的倍数（打包时为了不溢出除掉的）
        'dirScale': s_dir / 3.0,
        'skyScale': s_sky,
    }
    with open(os.path.join(OUT_DIR, 'clouds.json'), 'w') as f:
        json.dump(meta, f, indent=2)
    print('打包完成', meta)


def main():
    opt = args()
    os.makedirs(TMP, exist_ok=True)
    sc, so, bg = setup(opt)
    mat, seeds = cloud_material()
    t0 = time.time()
    for i, (seed, kind) in enumerate(CLOUDS):
        if opt['only'] is not None and i not in opt['only']:
            continue
        for k, w in enumerate(seeds):
            w.default_value = seed * 0.37 + k * 11.1
        objs = build_cloud(sc, seed, kind, mat)
        render_cloud(sc, so, bg, i, opt['passes'])
        objs[0].modifiers.clear()  # 先拆掉修改器（它们引用着另外两个物体），再删
        for o in objs:
            bpy.data.objects.remove(o)
    print(f'渲染共 {time.time() - t0:.0f}s')
    if opt['pack'] and opt['only'] is None and opt['passes'] == PASSES and opt['res'] == 1.0:
        pack()


main()
