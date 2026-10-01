import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { Runtime } from '../runtime';
import type { ActScript, Emotion, MotionId } from '../act/schema';
import { MOTIONS } from '../act/schema';
import { motionSource, motionTalk } from '../vrm/motion';
import { GESTURES } from '../vrm/gestures';
import { isProceduralMotion } from '../act/schema';
import { parseTestCommand } from '../jev/testCommand';

/**
 * 开发用的观察工具（仅 dev，动态 import，不进生产包）。控制台里：
 *
 *   __trace('开心 80% > 难过 50%')         表情时间线（测试指令语法，不花钱）
 *   __filmstrip('惊讶 80%', [0.3, 1, 2])   指定时刻的脸部特写拼图
 *   await __faces('faces_Vivi.jpg')        默认取景 + 六种表情，存到 dev-out/
 *   await __motionstrip('greeting')        一个动作按时间截全身，存到 dev-out/
 *   __closeup([x, y, z], fov) / __closeup(null)   替身相机特写 / 换回主相机
 *   await __views('cafe.jpg')              场景截图：几个固定机位（半身 / 全身 / 侧面 / 背后 / 俯视）拼一张图
 *   await __hands('hands.jpg', [0, 3, 6])  双手特写：每一行一个时刻，左右手各一张正面、一张外侧、再加一张上半身
 *   await __hands('talk.jpg', [1, 3, 6], '开心 40% | 我跟你说，今天店里来了一只小猫！它就坐在窗台上晒太阳，可爱吧？')
 *                                          边说边截（测试指令语法，不花钱）。结果存成文件，屏幕上看不到变化
 *
 * 预览窗格被隐藏时浏览器会把 rAF 节流到几乎不动，这些函数都是同步逐帧推进的，不依赖 rAF。
 */

export function installAudit(rt: Runtime) {
  const ch = () => rt.character!;
  const vrm = () => ch().vrm!;
  const node = (n: VRMHumanBoneName) => vrm().humanoid.getNormalizedBoneNode(n)!;

  /**
   * 截图用的特写：换上一台替身相机对准某个点（世界坐标），直到 __closeup(null) 换回来。
   * 不挪主相机：视线层看的是主相机的位置，真值检测也按主相机打射线。
   * side = 绕 Y 转多少度（负值 = 从角色右侧看）
   */
  const closeup = (target: [number, number, number] | null, fov = 9, side = 0) => {
    const stage = rt.stage!;
    if (!target) {
      stage.view.camera = null;
      return 'main camera';
    }
    const main = stage.camera;
    const cam = main.clone();
    const t = new THREE.Vector3(...target);
    const dist = main.position.distanceTo(t);
    const a = THREE.MathUtils.degToRad(side);
    cam.position.set(t.x + Math.sin(a) * dist, main.position.y, t.z + Math.cos(a) * dist);
    cam.fov = fov;
    cam.updateProjectionMatrix();
    cam.lookAt(t);
    stage.view.camera = cam;
    stage.render();
    return 'closeup';
  };

  /**
   * 表情时间线：用测试指令的语法（不花钱）跑一句台词，逐帧推进，每隔 every 秒采样一次：
   * 对话状态、语义情绪、实际的部位形状、视线。
   * 带「反应」前缀时按 App 里的节奏模拟：思考 0.9s → 第一反应 → 再过 1.3s 开口。
   */
  const trace = (cmd: string, opts: { every?: number; tail?: number } = {}) => {
    const c = ch();
    const parsed = parseTestCommand(cmd.startsWith('测试') ? cmd : `测试: ${cmd}`);
    if (!parsed) return 'parse failed';
    const every = opts.every ?? 0.1;
    const rows: string[] = [];
    // 从干净的状态开始，结果才可比（否则带着上一次的心情惯性）
    rt.stopMotion();
    c.expression.reset();
    let t = 0;
    let next = 0;
    const sample = (tag: string) => {
      const emo = c.expression
        .snapshot()
        .map(([k, v]) => `${k}${v.toFixed(2)}`)
        .join(' ');
      const parts = c.expression
        .partSnapshot()
        .slice(0, 4)
        .map(([k, v]) => `${k.replace('part:', '')}${v.toFixed(2)}`)
        .join(' ');
      rows.push(`${t.toFixed(2)} ${tag.padEnd(9)} ${c.gaze.currentTarget.padEnd(10)} | ${emo || '-'} | ${parts}`);
    };
    const run = (secs: number, tag: () => string) => {
      const end = t + secs;
      while (t < end - 1e-6) {
        rt.step(1 / 60);
        t += 1 / 60;
        if (t >= next) {
          sample(tag());
          next += every;
        }
      }
    };
    const state = () => c.conversationState;
    if (parsed.reaction) {
      rt.think();
      run(0.9, state);
      rt.react(parsed.reaction);
      run(1.3, state);
    }
    const compiled = rt.play(parsed.act);
    const cues = compiled.events.filter((e) => e.kind === 'cue' || e.kind === 'expression');
    run(compiled.duration + (opts.tail ?? 3), state);
    return [
      `台词：${compiled.text}（${compiled.duration.toFixed(2)}s）`,
      `事件：${cues.map((e) => `${e.time.toFixed(2)}${e.kind === 'cue' ? e.cue : 'expr'}`).join(' ')}`,
      ...rows,
    ].join('\n');
  };

  const FACE_SET: Array<[string, Partial<Record<Emotion, number>>]> = [
    ['平静', {}],
    ['开心', { happy: 0.9 }],
    ['放松', { relaxed: 0.7 }],
    ['难过', { sad: 0.8 }],
    ['生气', { angry: 0.8 }],
    ['惊讶', { surprised: 0.8 }],
  ];

  /**
   * 同一条测试指令，在指定时刻各截一张脸部特写，拼成一张图盖在页面上。
   * 也可以直接传一份 Act（比如真实对话后的 __jev.act），不花钱重放同一段表演
   */
  const filmstrip = (cmd: string | ActScript, times: number[], cols = 4) => {
    const parsed =
      typeof cmd === 'string' ? parseTestCommand(cmd.startsWith('测试') ? cmd : `测试: ${cmd}`) : { act: cmd, reaction: null };
    if (!parsed) return 'parse failed';
    const stage = rt.stage!;
    const cvs = stage.renderer.domElement;
    const head = node('head');
    rt.stopMotion();
    ch().expression.reset();
    const tw = 400, th = 360;
    const sheet = document.createElement('canvas');
    sheet.width = cols * tw;
    sheet.height = Math.ceil(times.length / cols) * th;
    const g = sheet.getContext('2d')!;
    let t = 0;
    let k = 0;
    const lead = parsed.reaction ? 2.2 : 0;
    const shoot = () => {
      const p = head.getWorldPosition(new THREE.Vector3());
      closeup([p.x, p.y + 0.045, p.z + 0.08], 9);
      const cw = (cvs.height * tw) / th;
      g.drawImage(cvs, (cvs.width - cw) / 2, 0, cw, cvs.height, (k % cols) * tw, Math.floor(k / cols) * th, tw, th);
      g.fillStyle = '#ff0';
      g.font = 'bold 28px sans-serif';
      g.fillText(`${(t - lead).toFixed(1)}s`, (k % cols) * tw + 8, Math.floor(k / cols) * th + 32);
      k++;
    };
    const until = (goal: number) => {
      while (t < goal - 1e-6) {
        rt.step(1 / 60);
        t += 1 / 60;
      }
    };
    const shots = times.map((x) => x + lead).sort((a, b) => a - b);
    // 按时间顺序推进，途中到了哪个节点就做哪件事（思考 / 第一反应 / 开口 / 截图）
    const plan: Array<[number, () => void]> = shots.map((x) => [x, shoot] as [number, () => void]);
    if (parsed.reaction) {
      plan.push([0, () => rt.think()], [0.9, () => rt.react(parsed.reaction!)]);
    }
    plan.push([lead, () => rt.play(parsed.act)]);
    // 同一时刻：先思考 / 反应 / 开口，再截图
    plan.sort((a, b) => a[0] - b[0] || (a[1] === shoot ? 1 : 0) - (b[1] === shoot ? 1 : 0));
    for (const [at, fn] of plan) {
      until(at);
      fn();
    }
    closeup(null);
    let img = document.getElementById('__sheet') as HTMLImageElement | null;
    if (!img) {
      img = document.createElement('img');
      img.id = '__sheet';
      img.onclick = () => img!.remove();
      document.body.appendChild(img);
    }
    Object.assign(img.style, { position: 'fixed', left: '0', top: '0', width: '100vw', zIndex: '99999', background: '#000' });
    img.src = sheet.toDataURL('image/jpeg', 0.9);
    return `${k} shots（点图片关闭）`;
  };

  /**
   * 换模型对比用：默认取景一张 + 几种表情的脸部特写，拼成一张图存到 dev-out/。
   * 截图期间关掉眨眼和微表情，免得正好截到闭眼
   */
  const faces = async (name: string, mixes: Array<[string, Partial<Record<Emotion, number>>]> = FACE_SET) => {
    const stage = rt.stage!;
    const cvs = stage.renderer.domElement;
    const exr = ch().expression;
    // nextBlink 是私有字段，只有这里的截图需要把它推远
    const ex = exr as unknown as { nextBlink: number };
    const saved = { micro: exr.microEnabled };
    exr.microEnabled = false;
    rt.stopMotion();
    const tw = 360, th = 400;
    const cols = mixes.length + 1;
    const sheet = document.createElement('canvas');
    sheet.width = cols * tw;
    sheet.height = th + 36;
    const g = sheet.getContext('2d')!;
    g.fillStyle = '#111';
    g.fillRect(0, 0, sheet.width, sheet.height);
    const label = (text: string, k: number) => {
      g.fillStyle = '#fff';
      g.font = 'bold 24px sans-serif';
      g.fillText(text, k * tw + 10, th + 27);
    };
    const settle = (secs: number) => {
      for (let t = 0; t < secs; t += 1 / 60) {
        ex.nextBlink = 1e9;
        rt.step(1 / 60);
      }
    };
    // 默认取景（用户看到的样子）：主相机，画面中间裁一条
    exr.reset();
    settle(1.5);
    stage.view.camera = null;
    stage.render();
    const cw = (cvs.height * tw) / th;
    g.drawImage(cvs, (cvs.width - cw) / 2, 0, cw, cvs.height, 0, 0, tw, th);
    label('默认取景', 0);
    const head = node('head');
    for (let k = 0; k < mixes.length; k++) {
      const [text, mix] = mixes[k];
      exr.reset();
      exr.setBlend(mix, 0.2);
      settle(1.2);
      const p = head.getWorldPosition(new THREE.Vector3());
      closeup([p.x, p.y + 0.045, p.z + 0.08], 9);
      const fw = (cvs.height * tw) / th;
      g.drawImage(cvs, (cvs.width - fw) / 2, 0, fw, cvs.height, (k + 1) * tw, 0, tw, th);
      label(text, k + 1);
    }
    closeup(null);
    exr.reset();
    exr.microEnabled = saved.micro;
    ex.nextBlink = 2;
    const blob = await new Promise<Blob>((r) => sheet.toBlob((b) => r(b!), 'image/jpeg', 0.88));
    const res = await fetch(`/__dev/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return res.json();
  };

  /**
   * 一个动作从头到尾按时间截全身（替身相机拉远到全身景别），拼成一张图存到 dev-out/。
   * 动作层在隐藏窗格里也照样推进：这里同步逐帧跑，不等 rAF
   */
  const motionstrip = async (
    id: MotionId,
    count = 8,
    name = `motion_${id}.jpg`,
    opts: { bust?: boolean; talk?: boolean } = {},
  ) => {
    if (!(MOTIONS as readonly string[]).includes(id)) return `没有这个动作：${id}`;
    const stage = rt.stage!;
    const cvs = stage.renderer.domElement;
    ch().expression.reset();
    rt.stopMotion();
    for (let i = 0; i < 60; i++) rt.step(1 / 60);
    // 程序生成的表演动作带着它该配的表情一起看
    const face = isProceduralMotion(id) ? GESTURES[id].preview : undefined;
    if (face) ch().expression.setBlend(face, 0.3);
    // talk = 按对话里自动触发时的那一段播；bust = 用主相机（用户看到的半身景别）
    const range = opts.talk ? (motionTalk(id) ?? {}) : {};
    if (!(await ch().playMotion(id, range))) return `动作文件不在：${motionSource(id)}`;
    const from = range.from ?? 0;
    const duration = (ch().currentMotion?.duration ?? 8) - from;
    const tw = 300, th = 460, cols = count;
    const sheet = document.createElement('canvas');
    sheet.width = cols * tw;
    sheet.height = th + 34;
    const g = sheet.getContext('2d')!;
    g.fillStyle = '#111';
    g.fillRect(0, 0, sheet.width, sheet.height);
    // 全身景别：对准胸口，视角放大到能装下 1.7m 的人（56°）
    const hips = node('hips').getWorldPosition(new THREE.Vector3());
    let t = 0;
    for (let k = 0; k < count; k++) {
      const at = (duration * (k + 0.5)) / count;
      while (t < at) {
        rt.step(1 / 60);
        t += 1 / 60;
      }
      if (opts.bust) {
        stage.view.camera = null;
        stage.render();
      } else closeup([0, hips.y + 0.05, 0], 56);
      const cw = (cvs.height * tw) / th;
      g.drawImage(cvs, (cvs.width - cw) / 2, 0, cw, cvs.height, k * tw, 0, tw, th);
      g.fillStyle = '#fff';
      g.font = 'bold 22px sans-serif';
      g.fillText(`${(at + from).toFixed(1)}s`, k * tw + 8, th + 25);
    }
    closeup(null);
    rt.stopMotion();
    const blob = await new Promise<Blob>((r) => sheet.toBlob((b) => r(b!), 'image/jpeg', 0.85));
    const res = await fetch(`/__dev/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return { ...(await res.json()), duration: +duration.toFixed(2) };
  };

  /**
   * 场景截图：按 [标题, 距离, 水平转角°, 俯仰°] 依次摆主相机、渲染，拼成一张图存到 dev-out/。
   * size 指定临时画布大小（默认 1280×720 横向 —— 大多数窗口是横的），截完还原
   */
  const views = async (
    name: string,
    list: Array<[string, number, number?, number?]> = [
      ['默认半身', 1.58],
      ['拉到最远', 99],
      ['左侧', 3, -65],
      ['右侧', 3, 65],
      ['背后', 99, 180],
      ['俯视', 3.5, 20, 25],
    ],
    size: [number, number] = [1280, 720],
    cols = 2,
  ) => {
    const stage = rt.stage!;
    const r = stage.renderer;
    const cvs = r.domElement;
    const cam = stage.camera;
    const c = stage.controls;
    const eye = vrm().humanoid.getRawBoneNode('leftEye') ?? vrm().humanoid.getRawBoneNode('head')!;
    const eyeY = eye.getWorldPosition(new THREE.Vector3()).y + (vrm().humanoid.getRawBoneNode('leftEye') ? 0 : 0.06);
    const pr = r.getPixelRatio();
    r.setPixelRatio(1);
    r.setSize(size[0], size[1], false);
    cam.aspect = size[0] / size[1];
    cam.updateProjectionMatrix();
    const [tw, th] = size;
    const sheet = document.createElement('canvas');
    sheet.width = tw * cols;
    sheet.height = th * Math.ceil(list.length / cols);
    const g = sheet.getContext('2d')!;
    list.forEach(([label, dist, az = 0, el = 0], k) => {
      stage.frame(eyeY);
      const sph = new THREE.Spherical().setFromVector3(cam.position.clone().sub(c.target));
      sph.radius = Math.min(dist, c.maxDistance);
      sph.theta += THREE.MathUtils.degToRad(az);
      sph.phi -= THREE.MathUtils.degToRad(el);
      cam.position.copy(c.target).add(new THREE.Vector3().setFromSpherical(sph));
      for (let i = 0; i < 40; i++) {
        rt.step(1 / 60);
        stage.render();
      }
      stage.render();
      g.drawImage(cvs, (k % cols) * tw, Math.floor(k / cols) * th);
      g.fillStyle = '#ff0';
      g.font = 'bold 26px sans-serif';
      g.fillText(label, (k % cols) * tw + 12, Math.floor(k / cols) * th + 34);
    });
    stage.frame(eyeY);
    r.setPixelRatio(pr);
    stage.resize();
    const blob = await new Promise<Blob>((res) => sheet.toBlob((b) => res(b!), 'image/jpeg', 0.85));
    const res = await fetch(`/__dev/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return res.json();
  };

  /**
   * 双手特写：从现在起逐帧推进，到 times 里的每个时刻（秒）截一行 —— 左手正面、右手正面、左手外侧、右手外侧、上半身。
   * 看手指的自然弯曲和随机变化（hands.ts）。正面看到的是手指弯曲的侧影，外侧看到的是手背。
   * say = 测试指令（同 __trace），第 0 秒开口，看说话时手上的小动作
   */
  const hands = async (name = 'hands.jpg', times = [0, 2, 4, 6], say?: string, fov = 7) => {
    // 说话时：台词多长、有没有触发动作（动作自带手指和手臂，播的时候手的层让出来，截到的是动作）
    let talk: { speech: number; motions: string[] } | null = null;
    if (say) {
      const parsed = parseTestCommand(say.startsWith('测试') ? say : `测试: ${say}`);
      if (!parsed) return 'parse failed';
      rt.stopMotion();
      const compiled = rt.play(parsed.act);
      talk = {
        speech: +compiled.duration.toFixed(2),
        motions: compiled.events.flatMap((e) => (e.kind === 'motion' ? [e.clip] : [])),
      };
    }
    const stage = rt.stage!;
    const r = stage.renderer;
    const cvs = r.domElement;
    const tile = 360;
    const pr = r.getPixelRatio();
    r.setPixelRatio(1);
    r.setSize(tile, tile, false);
    stage.camera.aspect = 1;
    stage.camera.updateProjectionMatrix();
    const shots: Array<[string, 'left' | 'right' | 'body', number]> = [
      ['左手 正面', 'left', 0],
      ['右手 正面', 'right', 0],
      ['左手 外侧', 'left', 70],
      ['右手 外侧', 'right', -70],
      ['上半身', 'body', 35],
    ];
    const sheet = document.createElement('canvas');
    sheet.width = tile * shots.length;
    sheet.height = tile * times.length;
    const g = sheet.getContext('2d')!;
    const p = new THREE.Vector3();
    let t = 0;
    // 截图那一刻有没有动作在播（不一定是这句台词触发的：预览面板、上一句对话留下的也算）
    const playing = new Set<string>();
    times.forEach((at, row) => {
      while (t < at - 1e-6) {
        rt.step(1 / 60);
        t += 1 / 60;
      }
      const cur = ch().motion.current;
      if (cur) playing.add(`${at}s ${cur.id}`);
      shots.forEach(([label, side, az], col) => {
        if (side === 'body') {
          // 胯部往上一点，装得下两只小臂
          const hips = node('hips').getWorldPosition(new THREE.Vector3());
          closeup([hips.x, hips.y + 0.12, hips.z], 26, az);
          g.drawImage(cvs, col * tile, row * tile);
          g.fillStyle = '#ff0';
          g.font = 'bold 20px sans-serif';
          g.fillText(`${label} ${at}s`, col * tile + 10, row * tile + 28);
          return;
        }
        // 对准手掌中间：手腕和中指第二节的中点
        const wrist = vrm().humanoid.getRawBoneNode(`${side}Hand`)!.getWorldPosition(new THREE.Vector3());
        const mid = vrm().humanoid.getRawBoneNode(`${side}MiddleIntermediate`)?.getWorldPosition(p) ?? wrist;
        closeup(wrist.lerp(mid, 0.5).toArray(), fov, az);
        g.drawImage(cvs, col * tile, row * tile);
        g.fillStyle = '#ff0';
        g.font = 'bold 20px sans-serif';
        g.fillText(`${label} ${at}s`, col * tile + 10, row * tile + 28);
      });
    });
    closeup(null);
    r.setPixelRatio(pr);
    stage.resize();
    const blob = await new Promise<Blob>((res) => sheet.toBlob((b) => res(b!), 'image/jpeg', 0.85));
    const res = await fetch(`/__dev/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    const saved = await res.json();
    const notes: string[] = [];
    if (playing.size) notes.push(`截图时有动作在播（${[...playing].join('，')}）：动作自带手指和手臂，手的层让出来，截到的是动作本身`);
    if (!talk) return notes.length ? { ...saved, notes } : saved;
    if (talk.motions.length) notes.push(`这句台词触发了动作 ${talk.motions.join('、')}`);
    const late = times.filter((at) => at > talk.speech);
    if (late.length) notes.push(`台词只有 ${talk.speech}s，${late.join('、')}s 已经说完了（回到待机）`);
    return { ...saved, ...talk, notes };
  };

  const w = window as unknown as Record<string, unknown>;
  w.__views = views;
  w.__hands = hands;
  w.__faces = faces;
  w.__trace = trace;
  w.__filmstrip = filmstrip;
  w.__closeup = closeup;
  w.__motionstrip = motionstrip;
}
