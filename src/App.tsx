import { useCallback, useEffect, useRef, useState } from 'react';
import { Runtime, type LiveState } from './runtime';
import { MockDecider } from './jev/mockDecider';
import { HttpDecider, probeJev, type JevMeta, type JevStatus } from './jev/httpDecider';
import type { ActDecider } from './jev/decider';
import { baselineAct, fallbackAct, type ActScript } from './act/schema';
import { isTestCommand, parseTestCommand } from './jev/testCommand';
import { probeVoice, type VoiceSession, type VoiceStatus } from './speech/voice';
import { DEFAULT_TONE, toneFor } from './act/voiceStyle';
import type { JevMeta as Meta } from './act/fromJev';
import { MOTION_CREDIT, motionLabel, motionSource } from './vrm/motion';
import { isGreeting } from './act/motionRules';
import { EMOTIONS, MOTIONS, type Emotion, type MotionId } from './act/schema';
import { DEFAULT_BACKDROP, DEFAULT_MODEL, MODELS, VISIBLE_MODELS, modelUrl, probeModels } from './models';
import { appendChat, openChat, resetChat, type ChatSession } from './chat';
import type { BackdropId, CameraView } from './vrm/stage';
import type { SceneContext } from './jev/scene';
import { presetHours, TIME_MODES } from './vrm/timeOfDay';
import { Picker, type PickerItem } from './ui/Picker';
import { TimeSlider } from './ui/TimeSlider';
import { SpeechBubble } from './ui/SpeechBubble';
import { EMOTION_LABEL, emotionLabel } from './ui/labels';
import {
  IconBlank,
  IconChat,
  IconChevron,
  IconCity,
  IconClose,
  IconCoffee,
  IconCollapse,
  IconImage,
  IconMic,
  IconReset,
  IconSend,
  IconSliders,
  IconSwap,
  IconTree,
  IconVolume,
} from './ui/icons';
import './App.css';

/** 选过的模型存在这个 key 下（只是本机浏览器的偏好） */
const MODEL_KEY = 'jev.model';
/** 旧版的背景偏好（所有角色共用一个）：只在第一次迁移到按角色保存时读一次 */
const BACKDROP_KEY = 'jev.backdrop';

/**
 * 每个角色自己的偏好：音色、背景、镜头视角。以选中的角色为准 —— 换角色时一起换，
 * 没设置过的角色用默认（模型自己的默认音色、公园、半身机位，见 models.ts），不继承别的角色的
 */
const PREFS_KEY = 'jev.modelPrefs';
/** 调试面板开着还是收着 */
const PANEL_KEY = 'jev.panelOpen';
type TimeValue = 'now' | number;
interface ModelPrefs {
  speaker?: string;
  backdrop?: BackdropId;
  view?: CameraView;
  /** 背景音开关。没设置过 = 开 */
  ambient?: boolean;
  /** 时间（街景的昼夜）：'now' = 实时，数字 = 停在几点。没设置过 = 实时（旧版存的是清晨 / 白天…，读的时候换成钟点） */
  time?: TimeValue;
}
function allPrefs(): Record<string, ModelPrefs> {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function prefsOf(id: string | null): ModelPrefs {
  return (id && allPrefs()[id]) || {};
}
function savePrefs(id: string | null, patch: Partial<ModelPrefs>) {
  if (!id) return;
  try {
    const all = allPrefs();
    all[id] = { ...all[id], ...patch };
    localStorage.setItem(PREFS_KEY, JSON.stringify(all));
  } catch {
    // 存不了（隐私模式等）：这次照样生效，下次打开不记得
  }
}
/**
 * 第一次用按角色保存：把旧版全局的音色、背景交给当时选着的那个角色，之前的选择不丢。
 * 只搬真存过的 —— 没有旧设置就什么都不写，角色用自己的默认（否则默认背景会被写成咖啡店）
 */
function migratePrefs(id: string | null) {
  if (!id || allPrefs()[id]) return;
  let speaker: string | null = null;
  try {
    speaker = localStorage.getItem(SPEAKER_KEY);
  } catch {
    // 读不了就算了
  }
  const backdrop = savedBackdrop();
  if (!speaker && !backdrop) return;
  savePrefs(id, { ...(backdrop ? { backdrop } : {}), ...(speaker ? { speaker } : {}) });
}
const BACKDROPS: Array<{ id: BackdropId; label: string; icon: React.ReactNode }> = [
  { id: 'cafe', label: '咖啡店', icon: <IconCoffee size={18} /> },
  { id: 'animeCafe', label: '潮汐咖啡馆', icon: <IconCoffee size={18} /> },
  { id: 'park', label: '公园', icon: <IconTree size={18} /> },
  { id: 'street', label: '街景', icon: <IconCity size={18} /> },
  { id: 'none', label: '纯色', icon: <IconBlank size={18} /> },
];
function savedBackdrop(): BackdropId | null {
  try {
    const v = localStorage.getItem(BACKDROP_KEY);
    if (BACKDROPS.some((b) => b.id === v)) return v as BackdropId;
  } catch {
    // 读不了就当没存过
  }
  return null;
}
/** 角色的背景：存过的，否则默认 */
const backdropOf = (p: ModelPrefs): BackdropId => (BACKDROPS.some((b) => b.id === p.backdrop) ? p.backdrop! : DEFAULT_BACKDROP);
/** 角色的音色：用户给她选过的，否则模型自己的默认 */
const timeOf = (p: ModelPrefs): TimeValue => {
  const t = p.time as unknown;
  if (typeof t === 'number' && t >= 0 && t < 24) return t;
  const preset = TIME_MODES.find((m) => m.id === t && m.id !== 'now');
  return preset ? presetHours(preset.id as Exclude<typeof preset.id, 'now'>) : 'now';
};
const speakerOf = (id: string | null, p: ModelPrefs) => p.speaker ?? MODELS.find((m) => m.id === id)?.voice ?? null;

/**
 * 开始时用哪个模型。开发时可以用 ?model=Vita.vrm 直接指定文件（路径相对
 * public/models/，对比截图用）；否则用上次选的，文件不在（或已隐藏）就用默认模型
 */
function initialModel(avail: Record<string, boolean>): { id: string | null; url: string } {
  const param = import.meta.env.DEV ? new URLSearchParams(location.search).get('model') : null;
  if (param && /^[\w/.-]+\.vrmx?$/.test(param) && !param.includes('..')) {
    return { id: MODELS.find((m) => m.file === param)?.id ?? null, url: `${import.meta.env.BASE_URL}models/${param}` };
  }
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(MODEL_KEY);
  } catch {
    // 存不了就用默认
  }
  const m = VISIBLE_MODELS.find((x) => x.id === saved && avail[x.id]) ?? DEFAULT_MODEL;
  return { id: m.id, url: modelUrl(m) };
}

/**
 * 开发用：把每次前后台判断记下来，存到 dev-out/audio_<tab>.txt（每个标签页一个文件，开了两个页面也分得清）。
 * 排查"切到别处之后声音还在响"这类问题：浏览器在各种切换里到底报了什么，看日志一目了然。
 * 状态没变的定时复查不记
 */
function audioStateLog() {
  const tab = Math.random().toString(36).slice(2, 6);
  const lines = [`# ${location.href} 打开于 ${new Date().toLocaleString()}`];
  let last = '';
  let timer = 0;
  const flush = () =>
    void fetch(`/__dev/save?name=audio_${tab}.txt`, { method: 'POST', body: lines.join('\n') + '\n' }).catch(() => {});
  return (why: string, a: { active: boolean; ctx: string } | undefined) => {
    const state = `hidden=${document.hidden} focus=${document.hasFocus()} → active=${a?.active ?? '-'} ctx=${a?.ctx ?? '-'}`;
    if (why === 'poll' && state === last) return;
    last = state;
    lines.push(`${new Date().toISOString().slice(11, 23)} ${why.padEnd(16)} ${state}`);
    if (lines.length > 400) lines.splice(1, lines.length - 400);
    clearTimeout(timer);
    timer = window.setTimeout(flush, 300);
  };
}
/** 每个页面一份（StrictMode 会把 effect 跑两遍，放在组件外才不会一页出两个文件） */
const audioLog = import.meta.env.DEV ? audioStateLog() : null;

interface Turn {
  role: 'user' | 'character';
  text: string;
}

/** 旧版的音色偏好（所有角色共用一个）：只在第一次迁移到按角色保存时读一次 */
const SPEAKER_KEY = 'jev.voice.speaker';

/** Jev 按段的判断 → 每段的语气指令（声音和表情用同一个判断） */
function segmentTones(meta: Meta | null | undefined): string[] | null {
  if (!meta?.segments?.length) return null;
  const intensity = (meta.intensity?.score ?? 1) / 2;
  return meta.segments.map((s) => toneFor(s.probabilities, intensity));
}

/** 倾听反应 → 第一段的语气（整句判断还没回来时用） */
function reactionTone(meta: Meta): string {
  const r = meta.reaction!;
  return toneFor(r.probabilities, r.intensity / 2);
}

/**
 * 测试指令用：台词和每段的情绪都已知，直接按段合成。合成失败返回 null（无声播放）。
 */
async function voiced(
  rt: Runtime,
  speech: string,
  meta: Meta,
  fallback?: string,
): Promise<VoiceSession | null> {
  const session = rt.createVoice(speech);
  if (!session) return null;
  const tones = segmentTones(meta);
  if (fallback) session.setFallbackTone(fallback);
  if (tones) session.setJudgedTones(tones);
  return (await session.prepare()) ? session : null;
}

/** 概率分布的简写："happy 0.62 + surprised 0.21"（只列 ≥ 0.15 的） */
function topMix(probs: Record<string, number>): string {
  return (
    Object.entries(probs)
      .filter(([, p]) => p >= 0.15)
      .sort((a, b) => b[1] - a[1])
      .map(([k, p]) => `${emotionLabel(k)} ${p.toFixed(2)}`)
      .join(' + ') || '平静'
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const deciderRef = useRef<ActDecider>(new MockDecider());
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 界面：左上的角色设定展开着没有、聊天记录开着没有、调试面板开着没有（面板的开合记在浏览器里）
  // 窄屏（手机）上先收着，不然会挡住脸
  const [dockOpen, setDockOpen] = useState(() => window.innerWidth >= 720);
  const [chatOpen, setChatOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      const v = localStorage.getItem(PANEL_KEY);
      if (v) return v === '1';
    } catch {
      // 读不了就按屏幕宽度定
    }
    // 第一次打开：窄屏先收着，别挡住角色
    return window.innerWidth >= 720;
  });
  const togglePanel = (open: boolean) => {
    setPanelOpen(open);
    try {
      localStorage.setItem(PANEL_KEY, open ? '1' : '0');
    } catch {
      // 记不住就算了
    }
  };
  // 刚发出去的那句话：聊天记录收着的时候在输入框上面飘一下再淡掉，让人知道发出去了
  const [echo, setEcho] = useState<{ id: number; text: string } | null>(null);
  useEffect(() => {
    if (!echo) return;
    const t = window.setTimeout(() => setEcho((e) => (e?.id === echo.id ? null : e)), 4200);
    return () => clearTimeout(t);
  }, [echo]);
  // 输入框跟着内容长高（最多 5 行左右）
  const [input, setInput] = useState('');
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // 空的时候用 CSS 的一行高（Chrome 的 scrollHeight 会把换行的占位文字也算进去）
    el.style.height = '';
    if (input) el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [input]);

  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [tts, setTts] = useState(false);
  const [live, setLive] = useState<LiveState | null>(null);
  const [lastAct, setLastAct] = useState<ActScript | null>(null);
  const [subtitle, setSubtitle] = useState('');
  const [useJev, setUseJev] = useState(false);
  const [jev, setJev] = useState<JevStatus>({ configured: false, mode: 'unconfigured' });
  const [jevMeta, setJevMeta] = useState<JevMeta | null>(null);
  const [jevError, setJevError] = useState<string | null>(null);
  // 上一轮服务端告诉输入层的场景（调试面板看"她知道自己在哪、几点了"）
  const [sceneNote, setSceneNote] = useState<string | null>(null);
  // 测试预览（仅 dev）
  const [previewing, setPreviewing] = useState<string | null>(null);
  // 模型
  const [modelId, setModelId] = useState<string | null>(null);
  const [modelAvail, setModelAvail] = useState<Record<string, boolean>>({});
  const [modelLoading, setModelLoading] = useState<number | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const modelPick = useRef(0);
  const [backdrop, setBackdropState] = useState<BackdropId>(DEFAULT_BACKDROP);
  // 背景音（场景的环境音）：按角色记，默认开。第一次发送消息时才真正出声（浏览器要求用户手势）
  const [ambient, setAmbient] = useState(true);
  const [timeMode, setTimeMode] = useState<TimeValue>('now');
  // 音色：按角色记在浏览器里（见 ModelPrefs），角色加载时换成她的；没选过就用服务端的默认音色（TTS_SPEAKER）
  const [speaker, setSpeaker] = useState<string | null>(null);
  // 偏好按角色存：存的时候要用最新的角色 id（闭包里的可能是旧的）。换角色时在事件里直接改，这里兜底同步
  const modelIdRef = useRef<string | null>(null);
  useEffect(() => {
    modelIdRef.current = modelId;
  }, [modelId]);
  // 聊天记录：每个模型一个 session（session id = 模型 id）
  const [persona, setPersona] = useState<ChatSession['persona'] | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const session = modelId ?? 'default';
  const [previewSpeed, setPreviewSpeed] = useState(1);
  const [previewLoop, setPreviewLoop] = useState(false);
  const [previewClock, setPreviewClock] = useState<{
    time: number;
    duration: number;
    paused: boolean;
  } | null>(null);


  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rt = new Runtime();
    runtimeRef.current = rt;
    rt.onState = setLive;
    // 转完 / 拉完镜头就把视角记在当前角色下；关页面时再记一次（见下面的 pagehide）
    rt.onViewChange = () => {
      const v = rt.getView();
      if (v) savePrefs(modelIdRef.current, { view: v });
    };
    rt.onSpeechText = setSubtitle;

    let disposed = false;
    let sessionId = 'default';
    probeModels()
      .then((avail) => {
        setModelAvail(avail);
        const init = initialModel(avail);
        setModelId(init.id);
        modelIdRef.current = init.id;
        sessionId = init.id ?? 'default';
        // 这个角色上次的音色、背景、视角
        migratePrefs(init.id);
        const p = prefsOf(init.id);
        const bd = backdropOf(p);
        setBackdropState(bd);
        rt.setBackdrop(bd);
        setAmbient(p.ambient ?? true);
        rt.setAmbience(p.ambient ?? true);
        setTimeMode(timeOf(p));
        rt.setTimeOfDay(timeOf(p));
        setSpeaker(speakerOf(init.id, p));
        rt.pendingView = p.view ?? null;
        rt.setIdleArmClearance(MODELS.find((m) => m.id === init.id)?.armOut ?? 0);
        return rt.mount(canvas, init.url, setProgress);
      })
      .then(async () => {
        if (disposed) return;
        setLoading(false);
        // 先试着把音频建起来：浏览器允许自动播放（常来的站点）时刷新完背景音就出来；
        // 不允许的话上下文是挂起的，第一次点击 / 按键时再放行（见上面的 unlock）
        rt.unlockAudio();
        // 接着上次的聊天记录；第一次见面就先打招呼（页面刚打开还不能出声，只有字幕）
        try {
          const chat = await openChat(sessionId);
          if (disposed) return;
          setPersona(chat.persona);
          setTurns(chat.turns);
          if (chat.greeted) {
            const act = baselineAct(chat.persona.greeting);
            if (isGreeting(chat.persona.greeting)) act.tracks.motion = [{ at: 0.15, clip: 'greeting' }];
            rt.play(act);
          }
        } catch (e) {
          // 没有聊天记录服务（比如生产构建）：退回以前的规则模板开场，这一轮不存
          setChatError(`聊天记录不可用：${e instanceof Error ? e.message : String(e)}`);
          const act = await deciderRef.current.decide('你好', { history: [] });
          if (disposed) return;
          setLastAct(act);
          rt.play(act);
          setTurns([{ role: 'character', text: act.speech.replace(/<b:[a-z0-9_]+>/gi, '') }]);
        }
      })
      .catch((e: unknown) => {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });

    const onResize = () => rt.resize();
    window.addEventListener('resize', onResize);
    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      rt.dispose();
      runtimeRef.current = null;
    };
  }, []);

  // 本地语音（Vivian）。模型加载要 20 秒左右，没就绪时每 3 秒探一次
  const [voice, setVoice] = useState<VoiceStatus>({ ready: false });
  const ttsTouched = useRef(false);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      const s = await probeVoice();
      if (!alive) return;
      setVoice(s);
      if (s.ready && !ttsTouched.current) {
        // 本地语音就绪就默认开口说话（用户手动关过就不再替他打开）
        setTts(true);
      }
      // 本地后端的设计音色模型比预设音色晚十几秒：都好了才停止探测
      if (!s.disabled && !s.error && (!s.ready || s.pending)) timer = window.setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    // 系统语音只在本地语音不可用时兜底
    if (runtimeRef.current) runtimeRef.current.ttsEnabled = tts && !voice.ready;
  }, [tts, voice.ready]);

  // 只有「这个窗口在前台，并且这个 tab 是当前 tab」时才出声：切到别的 tab、别的窗口都停，两样都回来才恢复。
  //
  // 每次有事件都按当前状态重新判一遍，而不是一个事件管一件事 —— 后者会漏：从别的窗口直接点回
  // 这个窗口里的另一个 tab 时，这个页面先变成隐藏，随后还会收到一个迟到的 focus，按"focus 就恢复"
  // 的写法，声音就在后台的 tab 里响起来了。
  //
  // 以前不敢把 document.hidden 和 hasFocus() 合起来判断：休眠唤醒 / 浏览器恢复之后，标签页变可见的
  // 那一瞬间 hasFocus() 可能还是 false，随后的 focus 事件有时压根不来，于是永久静音。
  // 现在加了每秒一次的复查兜住这种情况（setPageActive 只在状态真的变化时才做事，平时没有开销；
  // 后台 tab 的定时器被浏览器节流，本来也该是静音的）。
  //
  // 多显示器上从另一块屏点回来、点的是别的 tab：focus → blur → hidden 在 3ms 内连着来，
  // focus 发出的异步 resume 会在页面已经切走之后才完成 —— 这个竞态在 runtime.setPageActive 里处理。
  useEffect(() => {
    const evaluate = (e?: Event) => {
      runtimeRef.current?.setPageActive(!document.hidden && document.hasFocus());
      audioLog?.(e?.type ?? 'poll', runtimeRef.current?.audioDebug);
    };
    // 浏览器只在用户手势里放行音频：页面上随便点一下 / 按一个键就把声音打开
    // （以前只有点特定按钮才解锁，刷新之后点别处是不出声的）。unlockAudio 可以重复调
    const unlock = () => runtimeRef.current?.unlockAudio();
    const events: Array<[EventTarget, string]> = [
      [document, 'visibilitychange'],
      [window, 'blur'],
      [window, 'focus'],
      [window, 'pageshow'],
      // 兜底：用户一动就说明页面在前台
      [window, 'pointerdown'],
      [window, 'keydown'],
    ];
    for (const [t, e] of events) t.addEventListener(e, evaluate);
    for (const e of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(e, unlock);
    const timer = window.setInterval(evaluate, 1000);
    evaluate();
    return () => {
      for (const [t, e] of events) t.removeEventListener(e, evaluate);
      for (const e of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(e, unlock);
      clearInterval(timer);
    };
  }, []);

  const useVoice = tts && voice.ready;

  const voices = voice.voices ?? [];
  // 不区分大小写：本地后端的音色 id 是小写（serena），千问的是首字母大写（Serena），
  // 换后端之后存下来的选择还能对上。暂时不能选的（加载中）不算，但不改用户存的选择
  const usable = voices.filter((v) => !v.disabled);
  const match = (id?: string | null) => usable.find((v) => id && v.id.toLowerCase() === id.toLowerCase());
  const activeVoice = match(speaker) ?? match(voice.speaker) ?? usable[0];
  const activeSpeaker = activeVoice?.id ?? voice.speaker ?? 'Vivian';
  const activeName = activeVoice?.name ?? activeSpeaker;
  const groups = [...new Set(voices.map((v) => v.group))];
  useEffect(() => {
    if (runtimeRef.current) runtimeRef.current.voiceSpeaker = activeSpeaker;
  }, [activeSpeaker]);

  /** 换了音色：记在当前角色下，并让角色用新音色说一句，直接听效果 */
  const pickSpeaker = async (id: string) => {
    setSpeaker(id);
    savePrefs(modelIdRef.current, { speaker: id });
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.voiceSpeaker = id;
    if (busy || !useVoice) return;
    rt.unlockAudio();
    const line = '嗨，换成这个声音了，你觉得怎么样？';
    const session = rt.createVoice(line);
    if (!session) return;
    session.setFallbackTone(DEFAULT_TONE);
    if (await session.prepare()) rt.play(baselineAct(line), { voice: session });
  };

  /**
   * 开场白：新 session 或刚重置时她先开口。有 Jev 就让 Jev 判断怎么演（1 次评估），
   * 和普通的一轮一样先用基线表演开口、判断到了再升级
   */
  const greet = async (text: string, sid: string) => {
    const rt = runtimeRef.current;
    if (!rt) return;
    const decider = deciderRef.current;
    const judgeP =
      decider instanceof HttpDecider && jev.progressive
        ? decider.judge('（对方来了）', { history: [], session: sid }, text)
        : null;
    let voice: VoiceSession | null = null;
    if (useVoice) {
      voice = rt.createVoice(text);
      if (voice) {
        voice.setFallbackTone(DEFAULT_TONE);
        const v = voice;
        if (judgeP) {
          judgeP.then(() => v.setJudgedTones(segmentTones((decider as HttpDecider).lastMeta) ?? [])).catch(() => v.setJudgedTones([]));
        } else v.setJudgedTones([]);
        if (!(await voice.prepare())) voice = null;
      }
    }
    // 开场白是问候（"你好""欢迎光临""你来啦"）就挥手；"……哦，是你啊"这种冷淡的不挥
    const act = baselineAct(text);
    if (isGreeting(text)) act.tracks.motion = [{ at: 0.15, clip: 'greeting' }];
    rt.play(act, { voice });
    judgeP?.then((judged) => rt.upgrade(judged)).catch(() => {});
  };

  /** 读一个 session 的聊天记录显示出来；是新开场就打招呼 */
  const showChat = async (sid: string, load: () => Promise<ChatSession>) => {
    try {
      const chat = await load();
      setPersona(chat.persona);
      setTurns(chat.turns);
      setChatError(null);
      if (chat.greeted) await greet(chat.persona.greeting, sid);
    } catch (e) {
      setChatError(`聊天记录不可用：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** 重置对话：她会忘掉之前聊过的内容。旧记录在服务端归档，不是删除 */
  const resetConversation = async () => {
    const rt = runtimeRef.current;
    if (!rt || busy) return;
    const who = persona?.name ?? '她';
    if (!window.confirm(`清空和${who}的聊天记录？\n她会忘掉之前聊过的内容（旧记录会归档在 data/chats/archive/，不会删除）。`)) return;
    if (useVoice) rt.unlockAudio();
    rt.stop();
    setJevMeta(null);
    setJevError(null);
    await showChat(session, () => resetChat(session));
  };

  /** 换背景：记在当前角色下。换背景也是一次用户操作，顺手解锁音频（背景音这才出得来） */
  const pickBackdrop = (id: BackdropId) => {
    setBackdropState(id);
    runtimeRef.current?.unlockAudio();
    runtimeRef.current?.setBackdrop(id);
    savePrefs(modelIdRef.current, { backdrop: id });
  };

  /** 背景音开关：记在当前角色下 */
  const pickAmbient = (on: boolean) => {
    setAmbient(on);
    runtimeRef.current?.unlockAudio();
    runtimeRef.current?.setAmbience(on);
    savePrefs(modelIdRef.current, { ambient: on });
  };

  /** 时间（街景的昼夜）：拖拉杆的时候直接跳过去、不存；松手 / 勾「实时」时过渡过去并记在当前角色下 */
  const dragTime = (v: TimeValue) => {
    setTimeMode(v);
    runtimeRef.current?.setTimeOfDay(v, true);
  };
  const pickTime = (v: TimeValue) => {
    setTimeMode(v);
    runtimeRef.current?.setTimeOfDay(v);
    savePrefs(modelIdRef.current, { time: v });
  };

  /** 换到某个角色的音色和背景（换角色时、换失败退回时） */
  const applyPrefs = (id: string | null) => {
    const p = prefsOf(id);
    const bd = backdropOf(p);
    setBackdropState(bd);
    runtimeRef.current?.setBackdrop(bd);
    setAmbient(p.ambient ?? true);
    runtimeRef.current?.setAmbience(p.ambient ?? true);
    setTimeMode(timeOf(p));
    runtimeRef.current?.setTimeOfDay(timeOf(p));
    const sp = speakerOf(id, p);
    setSpeaker(sp);
    // 状态更新是异步的，新角色马上就要打招呼：直接把音色交给 runtime
    const rt = runtimeRef.current;
    if (rt) rt.voiceSpeaker = (match(sp) ?? match(voice.speaker) ?? usable[0])?.id ?? voice.speaker ?? 'Vivian';
    return p;
  };

  // 关页面 / 切到后台时把当前视角记下来（转完镜头时已经记过一次，这里兜底）
  useEffect(() => {
    const save = () => {
      const v = runtimeRef.current?.getView();
      if (v) savePrefs(modelIdRef.current, { view: v });
    };
    const onHide = () => document.visibilityState === 'hidden' && save();
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  /** 换模型：旧模型留在画面里直到新的加载好；选择记下来，下次打开默认用它 */
  const pickModel = async (id: string) => {
    const m = MODELS.find((x) => x.id === id);
    const rt = runtimeRef.current;
    if (!m || !rt || id === modelId) return;
    const prev = modelId;
    const pick = ++modelPick.current;
    // 选择框的改动就是用户操作：趁现在解锁音频，新角色打招呼时才能出声
    if (useVoice) rt.unlockAudio();
    // 旧角色的视角记下来，换成新角色的音色、背景、视角（视角在取景的同一帧里换）
    const v = rt.getView();
    if (v) savePrefs(prev, { view: v });
    setModelId(id);
    modelIdRef.current = id;
    rt.pendingView = applyPrefs(id).view ?? null;
    setModelLoading(0);
    setModelError(null);
    try {
      // 先定好外展量再换模型：setModel 会把它交给新角色
      rt.setIdleArmClearance(m.armOut ?? 0);
      if (!(await rt.setModel(modelUrl(m), setModelLoading))) return;
      try {
        localStorage.setItem(MODEL_KEY, id);
      } catch {
        // 存不了：这次照样生效，下次打开不记得
      }
      // 每个模型一个 session：换成她的聊天记录，第一次见面就打招呼
      await showChat(id, () => openChat(id));
    } catch (e) {
      if (pick !== modelPick.current) return;
      setModelId(prev);
      modelIdRef.current = prev;
      rt.pendingView = null;
      applyPrefs(prev);
      setModelError(`${m.name} 载入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (pick === modelPick.current) setModelLoading(null);
    }
  };

  // 探测服务端代理有没有配好。key 在代理那一侧，前端只知道"能不能用"。
  useEffect(() => {
    let alive = true;
    void probeJev().then((s) => {
      if (!alive) return;
      setJev(s);
      // 配好了就默认走 Jev —— 否则每次刷新都要手点一下
      if (s.configured) setUseJev(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (useJev && jev.configured) {
      // 输入层没配 DeepSeek 时，用 MockDecider 的规则模板补台词。
      deciderRef.current = new HttpDecider({
        draftSource: jev.needsDraft ? new MockDecider() : null,
      });
    } else {
      deciderRef.current = new MockDecider();
    }
  }, [useJev, jev.configured, jev.needsDraft]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);
  // 打开聊天记录时直接停在最新的一条
  useEffect(() => {
    if (chatOpen) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [chatOpen]);

  const previewMotion = (id: MotionId) => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.playMotion(id, previewSpeed, previewLoop);
    setPreviewing(id);
  };

  // 预览播放器的时间轴：动画在 React 之外跑，这里 20Hz 拉一次状态就够了
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const timer = setInterval(() => {
      const st = runtimeRef.current?.previewState();
      if (!st?.id) {
        setPreviewClock(null);
        return;
      }
      setPreviewClock((prev) =>
        st.current
          ? { time: st.current.t, duration: st.current.duration, paused: st.paused }
          : prev && { ...prev, time: prev.duration, paused: true },
      );
    }, 50);
    return () => clearInterval(timer);
  }, []);

  const previewEmotion = (emo: Emotion) => {
    const ch = runtimeRef.current?.character;
    if (!ch) return;
    // 预览要看的是这一个情绪本身，先清掉上一个的惯性
    ch.expression.reset();
    ch.expression.setBlend({ [emo]: 0.9 }, 0.2);
    setPreviewing(emo);
  };

  const resetPreview = () => {
    const rt = runtimeRef.current;
    setPreviewClock(null);
    rt?.stopMotion();
    rt?.character?.expression.reset();
    setPreviewing(null);
  };

  /**
   * 此刻的场景，跟着这一轮对话发给输入层：她就知道自己在哪、几点了。
   * 时间只有有昼夜的场景（街景）才带，取的是场景里实际的时间（过渡中就是此刻过渡到的那一刻）
   */
  const sceneNow = (): SceneContext => {
    const t = runtimeRef.current?.stage?.time;
    if (backdrop !== 'street' || !t) return { id: backdrop };
    const live = timeMode === 'now';
    const d = new Date();
    return {
      id: backdrop,
      time: {
        hours: t.hours,
        sunElev: t.sunElev,
        live,
        date: live ? { month: d.getMonth() + 1, day: d.getDate(), weekday: d.getDay() } : undefined,
      },
    };
  };

  const send = useCallback(async () => {
    const text = input.trim();
    const rt = runtimeRef.current;
    if (!text || !rt || busy || modelLoading != null) return;

    setInput('');
    setEcho({ id: Date.now(), text });
    // 上一句的气泡收起来，换成"思考云"
    setSubtitle('');
    setBusy(true);
    setJevMeta(null);
    setJevError(null);
    // 音频必须在用户操作里启动：发送这一下（点击或回车）就是。
    // 背景音和语音共用同一个 AudioContext，所以不开语音时也要解锁
    if (useVoice || ambient) rt.unlockAudio();
    const history = turns.slice(-6).map(({ role, text }) => ({ role, text }));
    const ctx = { history, session, scene: sceneNow() };
    // 台词不是服务端写的（规则模板、passthrough）时，由前端把这一轮记进聊天记录
    const record = (reply: string) => {
      if (!chatError) void appendChat(session, [{ role: 'user', text }, { role: 'character', text: reply }]).catch(() => {});
    };
    setTurns((t) => [...t, { role: 'user', text }]);

    // 测试指令：跳过 DeepSeek 和真实 Jev，用合成答案走同一份 composeAct。
    // 不花钱、不等网络、结果可复现。
    if (isTestCommand(text)) {
      const cmd = parseTestCommand(text);
      if (cmd?.reaction) {
        // 模拟真实链路的节奏：思考 → 第一反应（约 0.9s 后）→ 开口（约 2.2s 后，
        // 大致是 DeepSeek 写台词的耗时）。整句判断直接随台词到，不再模拟延迟
        setLastAct(cmd.act);
        setJevMeta({ ...cmd.meta, reaction: undefined });
        rt.think();
        const mix = cmd.reaction;
        await new Promise((r) => setTimeout(r, 900));
        rt.react(mix);
        const [session] = await Promise.all([
          useVoice ? voiced(rt, cmd.act.speech, cmd.meta, toneFor(Object.fromEntries(mix), 0.6)) : null,
          new Promise((r) => setTimeout(r, 1300)),
        ]);
        const compiled = rt.play(cmd.act, { voice: session });
        setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
      } else if (cmd) {
        setLastAct(cmd.act);
        setJevMeta(cmd.meta);
        const session = useVoice ? await voiced(rt, cmd.act.speech, cmd.meta) : null;
        const compiled = rt.play(cmd.act, { voice: session });
        setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
      } else {
        setTurns((t) => [
          ...t,
          {
            role: 'character',
            text:
              '测试指令没看懂。用法：测试: 开心 90%　·　测试: 难过 40% 放松 30% | 自定义台词　·　' +
              '测试: 惊讶 80% > 开心 70%（一句话里的情绪变化）　·　测试: 反应 惊讶 70%; 开心 80%',
          },
        ]);
      }
      setBusy(false);
      return;
    }

    const decider = deciderRef.current;

    // 渐进式：台词一到就开口，判断层的结果后到再升级还没触发的节拍。
    // 感知延迟因此只剩输入层那一段 —— Jev 是在角色已经开口之后才回来的。
    //
    // 一轮对话的节奏（像人一样）：
    //   发出消息 → 角色"想"（视线移开、抿嘴）
    //            ↘ 同时 Jev 判断第一反应（只看用户那句话），到了就先上脸
    //   台词到了 → 带着第一反应开口
    //              （有本地语音时：先合成第一段，语气用第一反应；合成要 0.5~1.5s，角色还在"想"）
    //   整句判断到了 → 每一段换成 Jev 判断的情绪（一句话里情绪可以变），
    //                  还没合成的段也换成这一段的语气
    //   说完 → 表情慢慢淡成余韵，不是一下子回到面无表情
    if (decider instanceof HttpDecider && jev.progressive) {
      rt.think();
      let reaction: Array<[Emotion, number]> | null = null;
      let reactionMeta: JevMeta | null = null;
      let session: VoiceSession | null = null;
      const reactP = jev.reaction
        ? decider.react(text, ctx).then((r) => {
            if (!r) return;
            reaction = r.mix;
            reactionMeta = r.meta;
            rt.react(r.mix);
            if (r.meta.reaction) session?.setFallbackTone(reactionTone(r.meta));
          })
        : Promise.resolve();
      try {
        const speech = await decider.speak(text, ctx);
        setSceneNote(decider.lastScene);
        // 整句判断立刻发出去，不等语音 —— 语音后面几段要等它给语气
        const judgeP = decider.judge(text, ctx, speech);
        if (useVoice) {
          const meta = reactionMeta as JevMeta | null;
          session = rt.createVoice(speech);
          if (session) {
            session.setFallbackTone(meta?.reaction ? reactionTone(meta) : DEFAULT_TONE);
            const s = session;
            // 判断失败（降级）也要通知：后面的段不必再等，直接用倾听反应的语气合成
            judgeP
              .then(() => s.setJudgedTones(segmentTones(decider.lastMeta) ?? []))
              .catch(() => s.setJudgedTones([]));
            if (!(await session.prepare())) session = null;
          }
        }
        const compiled = rt.play(baselineAct(speech, reaction), { voice: session });
        setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
        setBusy(false);

        // 不 await：让它在角色说话的同时跑
        void judgeP
          .then(async (act) => {
            rt.upgrade(act);
            await reactP;
            setJevMeta({ ...decider.lastMeta, reaction: reactionMeta?.reaction });
            setJevError(decider.lastError);
          })
          .catch((e: unknown) => {
            setJevError(e instanceof Error ? e.message : String(e));
          });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const compiled = rt.play(fallbackAct(`输入层出错了：${msg}`));
        setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
        setBusy(false);
      }
      return;
    }

    // 一次性：passthrough 模式和纯 Mock 走这条
    try {
      const act = await decider.decide(text, ctx);
      setLastAct(act);
      setJevMeta(decider instanceof HttpDecider ? decider.lastMeta : null);
      setJevError(decider instanceof HttpDecider ? decider.lastError : null);
      if (decider instanceof HttpDecider) setSceneNote(decider.lastScene);
      const compiled = rt.play(act);
      setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
      // Jev 模式下这条路的台词也是服务端写的（已经记了），其余情况前端记
      if (!(decider instanceof HttpDecider && jev.mode === 'jev')) record(compiled.text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const act = fallbackAct(`决策层出错了：${msg}`);
      setLastAct(act);
      const compiled = rt.play(act);
      setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sceneNow 只读 backdrop / timeMode，已经在依赖里
  }, [input, busy, turns, jev.progressive, jev.reaction, jev.mode, useVoice, ambient, session, chatError, modelLoading, backdrop, timeMode]);



  const currentModel = MODELS.find((m) => m.id === modelId);
  const modelItems: PickerItem[] = VISIBLE_MODELS.map((m) => ({
    id: m.id,
    label: m.name,
    desc: m.desc,
    disabled: !modelAvail[m.id],
    note: modelAvail[m.id] ? undefined : '未下载',
    lead: <Avatar id={m.id} name={m.name} size={36} />,
  }));
  const voiceItems: PickerItem[] = groups.flatMap((g) =>
    voices
      .filter((v) => v.group === g)
      .map((v) => ({ id: v.id, label: v.name, desc: v.desc, group: g, disabled: v.disabled })),
  );
  const voiceBackend = voice.backend === 'qwen' ? '千问' : '本地 Qwen3-TTS';

  return (
    <div className={`app${backdrop === 'street' ? ' has-time' : ''}`}>
      <div className="stage">
        <canvas ref={canvasRef} />

        <SpeechBubble runtime={runtimeRef} text={subtitle} thinking={busy} name={persona?.name ?? currentModel?.name} />

        {loading && (
          <div className="overlay">
            <div className="loader">
              <div className="bar">
                <div className="fill" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <span>载入模型 {Math.round(progress * 100)}%</span>
            </div>
          </div>
        )}

        {error && (
          <div className="overlay">
            <div className="err">
              <strong>模型载入失败</strong>
              <code>{error}</code>
            </div>
          </div>
        )}
      </div>

      {/* ---------- 左上：角色，和挂在她名下的音色 / 背景 ---------- */}
      <section className={`dock glass ${dockOpen ? '' : 'folded'}`} data-bubble-avoid>
        <div className="dock-head">
          <Picker
            className="model-picker"
            value={modelId}
            items={modelItems}
            onPick={(id) => void pickModel(id)}
            disabled={loading || busy}
            title="换角色（会记住，下次打开默认是她）"
            icon={false}
          >
            <Avatar id={modelId ?? '?'} name={currentModel?.name ?? '?'} size={38} />
            <span className="who">
              <b>{currentModel?.name ?? '地址栏指定的模型'}</b>
              <small>{currentModel?.desc ?? '（?model= 参数）'}</small>
            </span>
            {/* 整块都能点；右边写明这是干什么的，不只放一个箭头 */}
            <span className="switch-pill">
              <IconSwap size={13} />
              换角色
            </span>
          </Picker>
        </div>

        {(modelLoading != null || modelError) && (
          <div className={`dock-note${modelError ? ' error' : ''}`}>
            {modelError ?? (
              <>
                <span>载入中 {Math.round((modelLoading ?? 0) * 100)}%</span>
                <span className="mini-bar">
                  <i style={{ width: `${Math.round((modelLoading ?? 0) * 100)}%` }} />
                </span>
              </>
            )}
          </div>
        )}

        <div className="dock-tree" aria-hidden={!dockOpen}>
          <div className="dock-tree-inner">
            <div className="leaf">
              <div className="leaf-head">
                <IconMic size={15} />
                <span>音色</span>
                <Switch
                  checked={tts}
                  onChange={(v) => {
                    ttsTouched.current = true;
                    setTts(v);
                  }}
                  label={tts ? '开口' : '静音'}
                  title={voice.ready ? `语音合成：${voiceBackend}` : '本地语音没就绪时用系统内置语音'}
                />
              </div>
              {voice.ready && voices.length > 0 ? (
                <Picker
                  value={activeSpeaker}
                  items={voiceItems}
                  onPick={(id) => void pickSpeaker(id)}
                  disabled={!tts}
                  title="换了马上试听一句；按角色记住"
                >
                  <span className="voice-name">{activeName}</span>
                  <span className="voice-desc">{activeVoice?.desc ?? voiceBackend}</span>
                </Picker>
              ) : (
                <div className="leaf-hint">
                  {voice.disabled || voice.error ? '系统内置语音' : (
                    <>
                      <span className="spinner" /> 本地语音加载中…
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="leaf">
              <div className="leaf-head">
                <IconImage size={15} />
                <span>背景</span>
                <button
                  className={`chip-toggle ${ambient ? 'on' : ''}`}
                  onClick={() => pickAmbient(!ambient)}
                  title="场景的环境音：咖啡店的人声 / 公园的鸟鸣 / 街上的声音（说话时自动压低）"
                  aria-pressed={ambient}
                >
                  <IconVolume size={14} off={!ambient} />
                  环境音
                </button>
              </div>
              <div className="seg" role="radiogroup" aria-label="背景">
                {BACKDROPS.map((b) => (
                  <button
                    key={b.id}
                    role="radio"
                    aria-label={b.label}
                    aria-checked={backdrop === b.id}
                    className={backdrop === b.id ? 'on' : ''}
                    onClick={() => pickBackdrop(b.id)}
                  >
                    {b.icon}
                    <span>{b.label}</span>
                  </button>
                ))}
              </div>

            </div>
          </div>
        </div>

        {/* 展开 / 收起她的设定：收着的时候这一行就是设定的摘要，点一下展开 */}
        <button className="dock-toggle" onClick={() => setDockOpen((o) => !o)} aria-expanded={dockOpen}>
          {dockOpen ? (
            <span>收起设定</span>
          ) : (
            <span className="dock-summary">
              <IconMic size={13} />
              <span>{tts ? activeName : '静音'}</span>
              <i />
              <IconImage size={13} />
              <span>{BACKDROPS.find((b) => b.id === backdrop)?.label}</span>
              <em>展开</em>
            </span>
          )}
          <IconChevron size={14} />
        </button>
      </section>

      {jevError && (
        <div className="degraded" title={jevError}>
          判断层降级 · 表演退回基线，台词不受影响
        </div>
      )}

      {/* ---------- 右下：时间（只有街景有昼夜） ---------- */}
      {backdrop === 'street' && (
        <section className="time-card glass" data-bubble-avoid>
          <TimeSlider value={timeMode} onChange={dragTime} onCommit={pickTime} />
        </section>
      )}

      {/* ---------- 正下方：输入框 + 聊天记录 ---------- */}
      <div className="chatbar" data-bubble-avoid>
        {chatOpen && (
          <div className="chatlog glass solid">
            <div className="chatlog-head">
              <span>
                {persona ? `和 ${persona.name} 的对话` : '对话'}
                {turns.length > 0 && <em>{` · ${turns.length} 条`}</em>}
              </span>
              <button
                className="text-btn"
                onClick={() => void resetConversation()}
                disabled={loading || busy || !!chatError || modelLoading != null}
                title="清空这个角色的聊天记录，她会忘掉之前聊过的内容（旧记录归档，不删除）"
              >
                <IconReset size={13} /> 重置
              </button>
              <button className="icon-btn" onClick={() => setChatOpen(false)} title="收起">
                <IconClose size={15} />
              </button>
            </div>
            {chatError && <div className="chat-error">{chatError}</div>}
            <div className="log" ref={logRef}>
              {turns.length === 0 && <div className="log-empty">还没有聊过</div>}
              {turns.map((t, i) => (
                <div key={i} className={`turn ${t.role}`}>
                  {t.text}
                </div>
              ))}
              {busy && (
                <div className="turn character thinking">
                  <i />
                  <i />
                  <i />
                </div>
              )}
            </div>
          </div>
        )}

        {echo && !chatOpen && (
          <div className="echo" key={echo.id}>
            {echo.text}
          </div>
        )}

        <div className={`composer glass ${busy ? 'busy' : ''}`}>
          <button
            className={`icon-btn history ${chatOpen ? 'on' : ''}`}
            onClick={() => setChatOpen((o) => !o)}
            title={chatOpen ? '收起聊天记录' : '聊天记录'}
            aria-expanded={chatOpen}
          >
            <IconChat size={18} />
            {turns.length > 0 && <span className="badge">{turns.length > 99 ? '99+' : turns.length}</span>}
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            placeholder={persona ? `和${persona.name}说点什么…` : '说点什么…'}
            onChange={(e) => {
              setInput(e.target.value);
              // 用户在打字：角色看着对方、在听
              runtimeRef.current?.setListening(e.target.value.trim().length > 0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={loading || !!error}
          />
          <button
            className="send"
            onClick={() => void send()}
            disabled={busy || loading || modelLoading != null || !input.trim()}
            title="发送（Enter）"
          >
            <IconSend size={18} />
          </button>
        </div>
        <div className="composer-hint">Enter 发送 · Shift+Enter 换行 · 调试可用「测试: 开心 90%」跳过模型直接看表情</div>
      </div>

      {/* ---------- 右侧：调试面板（半透明悬浮，可折叠） ---------- */}
      {!panelOpen ? (
        <button className="panel-fab glass" onClick={() => togglePanel(true)} title="展开调试面板">
          <IconSliders size={16} />
          <span>调试</span>
          {jevError && <i className="dot warn" />}
        </button>
      ) : (
        <aside className="panel glass" data-bubble-avoid>
          <header>
            <div>
              <h1>Jev × three-vrm</h1>
              <p>文本驱动的表演管线</p>
            </div>
            <button className="icon-btn" onClick={() => togglePanel(false)} title="收起">
              <IconCollapse size={15} />
            </button>
          </header>

          <div className="panel-scroll">
            {/*
              这里刻意没有任何表演参数的控件。
              情绪、强度、视线、姿态全部由 Jev 判断，前端不提供竞争性的手动通道 ——
              留一个滑块就意味着"到底谁说了算"没有唯一答案。
              调参走 window.__jev（仅 dev），见 README。
              Jev 开关不是表演参数：是没配 key 时的回落。
            */}
            <div className="opt-row">
              <Switch
                checked={useJev}
                disabled={!jev.configured}
                onChange={(v) => {
                  setUseJev(v);
                  setJevMeta(null);
                }}
                title={jev.endpoint ?? jev.backend ?? '在 .env.local 里配置后重启 dev server'}
              />
              <div className="opt-text">
                <b>接入 Jev</b>
                <small>
                  {!jev.configured
                    ? '未配置 .env.local · 用规则模板'
                    : useJev
                      ? `${jev.mode === 'jev' ? jev.backend : '自有服务'}${jev.speechSource === 'deepseek' ? ` · 台词 ${jev.speechModel}` : ''}`
                      : '已关闭 · 用规则模板'}
                </small>
              </div>
            </div>

            {live && (
              <details className="section" open>
                <summary>
                  实时轨道 <span className="count">{live.fps} fps</span>
                </summary>
                <div className="tracks">
                  <Track
                    label="表情"
                    value={
                      live.expressions.length
                        ? live.expressions.map(([k, v]) => `${emotionLabel(k)} ${v.toFixed(2)}`).join('  ')
                        : '—'
                    }
                    active={live.expressions.length > 0}
                  />
                  <Track label="视线" value={live.gaze} />
                  <Track label="口型" value={live.speaking ? '说话中' : '闭合'} active={live.speaking} />
                  <Track label="姿态" value={live.posture} />
                  <Track label="动作" value={live.motion ? motionLabel(live.motion as MotionId) : '—'} active={!!live.motion} />
                </div>
              </details>
            )}

            {sceneNote && (
              <details className="section">
                <summary>
                  她感知到的场景 <span className="count">上一轮</span>
                </summary>
                <div className="hint">每一轮跟着对话发给输入层（server/scene.ts）。换背景、拖时间之后，下一句就按新的来。</div>
                <pre className="schema">{sceneNote}</pre>
              </details>
            )}

            {jevError && (
              <details className="section" open>
                <summary>判断层降级原因</summary>
                <pre className="schema">{jevError}</pre>
              </details>
            )}

            {jevMeta && (
              <details className="section" open>
                <summary>
                  Jev 的判断
                  {jevMeta.backend && <span className="count">{jevMeta.backend}</span>}
                  {jevMeta.credits && (
                    <span className="count">
                      {jevMeta.credits.charged} credit · 余 {jevMeta.credits.remaining}
                    </span>
                  )}
                  {jevMeta.costUsd && <span className="count">${jevMeta.costUsd}</span>}
                </summary>
                <div className="hint">
                  只读。choice 回的是整个概率分布，不只是 top-1 —— 混合表情直接由它驱动。
                  一句话按句切成最多 3 段，每段单独判断情绪；标「推导」的项不是 Jev 直接回答的。
                </div>
                <div className="sliders">
                  {jevMeta.reaction && (
                    <label className="on">
                      <span className="n">第一反应</span>
                      <span className="v-wide">{topMix(jevMeta.reaction.probabilities)}</span>
                      <span className="w">{jevMeta.reaction.confidence.toFixed(2)}</span>
                    </label>
                  )}
                  {jevMeta.segments &&
                    jevMeta.segments.length > 1 &&
                    jevMeta.segments.map((seg, i) => (
                      <label key={`seg${i}`} className="on">
                        <span className="n">段 {i + 1}</span>
                        <span className="v-wide" title={seg.text}>
                          {topMix(seg.probabilities)} · <span className="seg-text">{seg.text}</span>
                        </span>
                        <span className="w">{seg.confidence.toFixed(2)}</span>
                      </label>
                    ))}
                  {jevMeta.emotion && (
                    <>
                      <label className="on">
                        <span className="n">{jevMeta.segments && jevMeta.segments.length > 1 ? '整句' : '情绪'}</span>
                        <span className="v-wide">{emotionLabel(jevMeta.emotion.choice)}</span>
                        <span className="w">{jevMeta.emotion.confidence.toFixed(2)}</span>
                      </label>
                      {Object.entries(jevMeta.emotion.probabilities)
                        .sort((a, b) => b[1] - a[1])
                        .map(([k, p]) => (
                          <label key={k} className={p >= 0.15 ? 'on' : ''}>
                            <span className="n sub">└ {emotionLabel(k)}</span>
                            <span className="bar">
                              <i style={{ width: `${Math.round(p * 100)}%` }} />
                            </span>
                            <span className="w">{p.toFixed(2)}</span>
                          </label>
                        ))}
                    </>
                  )}
                  {jevMeta.intensity && (
                    <label className="on">
                      <span className="n">强度</span>
                      <span className="v-wide">score {jevMeta.intensity.score.toFixed(2)}</span>
                      <span className="w">{jevMeta.intensity.confidence.toFixed(2)}</span>
                    </label>
                  )}
                  {jevMeta.gaze && (
                    <label className="on">
                      <span className="n">视线</span>
                      <span className="v-wide">{jevMeta.gaze.choice}</span>
                      <span className="w">{jevMeta.gaze.confidence.toFixed(2)}</span>
                    </label>
                  )}
                  {jevMeta.posture && (
                    <label className={jevMeta.posture.derived ? 'on derived' : 'on'}>
                      <span className="n">{jevMeta.posture.derived ? '→ 姿态' : '姿态'}</span>
                      <span className="v-wide">{jevMeta.posture.choice}</span>
                      <span className="w">{jevMeta.posture.derived ? '推导' : jevMeta.posture.confidence.toFixed(2)}</span>
                    </label>
                  )}
                  {jevMeta.looksAway != null && (
                    <label className={`${jevMeta.looksAway > 0.5 ? 'on' : ''} ${jevMeta.looksAwayDerived ? 'derived' : ''}`}>
                      <span className="n">{jevMeta.looksAwayDerived ? '→ 移开视线' : '移开视线'}</span>
                      <span className="bar">
                        <i style={{ width: `${Math.round(jevMeta.looksAway * 100)}%` }} />
                      </span>
                      <span className="w">{jevMeta.looksAway.toFixed(2)}</span>
                    </label>
                  )}
                  <label className={jevMeta.motion ? 'on derived' : 'derived'} title={jevMeta.motion?.reason}>
                    <span className="n">→ 动作</span>
                    <span className="v-wide">{jevMeta.motion ? `${jevMeta.motion.label}（${jevMeta.motion.reason}）` : '不做动作'}</span>
                    <span className="w" />
                  </label>
                </div>
              </details>
            )}

            {import.meta.env.DEV && (
              <details className="section preview">
                <summary>
                  测试预览 <span className="count">dev</span>
                  <button
                    className="mini"
                    onClick={(e) => {
                      e.preventDefault();
                      resetPreview();
                    }}
                  >
                    复位
                  </button>
                </summary>
                <div className="hint">
                  只在开发环境出现，不进生产构建。动作是 VRoid 官方的动捕（.vrma），
                  从当前姿势交叉淡入；「掩嘴笑」是程序生成的（vrm/gestures.ts），预览时带着开心的表情。
                  对话里只有打招呼、比耶、转圈会自动触发（act/motionRules.ts）。
                </div>

                <div className="preview-row">
                  <span className="preview-k">动作</span>
                </div>
                <div className="chips">
                  {MOTIONS.map((id) => (
                    <button
                      key={id}
                      className={previewing === id ? 'on' : ''}
                      title={`${id} · ${motionSource(id)}`}
                      onClick={() => previewMotion(id)}
                    >
                      {motionLabel(id)}
                    </button>
                  ))}
                </div>

                <div className="player">
                  <div className="player-bar">
                    <button
                      className="mini"
                      disabled={!previewing || !previewClock}
                      onClick={() => runtimeRef.current?.setPreviewPaused(!(previewClock?.paused ?? true))}
                    >
                      {previewClock && !previewClock.paused ? '暂停' : '播放'}
                    </button>
                    <div className="speeds">
                      {[0.25, 0.5, 1].map((v) => (
                        <button
                          key={v}
                          className={previewSpeed === v ? 'on' : ''}
                          onClick={() => {
                            setPreviewSpeed(v);
                            runtimeRef.current?.setPreviewSpeed(v);
                          }}
                        >
                          {v}×
                        </button>
                      ))}
                    </div>
                    <label className="hold">
                      <input
                        type="checkbox"
                        checked={previewLoop}
                        onChange={(e) => {
                          setPreviewLoop(e.target.checked);
                          runtimeRef.current?.setPreviewLoop(e.target.checked);
                        }}
                      />
                      循环
                    </label>
                  </div>

                  {previewClock && (
                    <div className="timeline">
                      <div className="track-wrap">
                        <input
                          type="range"
                          min={0}
                          max={previewClock.duration}
                          step={1 / 120}
                          value={Math.min(previewClock.time, previewClock.duration)}
                          onChange={(e) => runtimeRef.current?.seekPreview(Number(e.target.value))}
                        />
                      </div>
                      <div className="timeline-meta">
                        <span>
                          {previewClock.time.toFixed(2)}s / {previewClock.duration.toFixed(2)}s
                        </span>
                      </div>
                    </div>
                  )}
                  <div className="hint">拖动时间轴会暂停在那一帧；慢速 + 循环适合反复看过渡段。</div>
                </div>

                <div className="preview-row">
                  <span className="preview-k">表情</span>
                </div>
                <div className="chips">
                  {EMOTIONS.map((e) => (
                    <button key={e} className={previewing === e ? 'on' : ''} title={e} onClick={() => previewEmotion(e)}>
                      {EMOTION_LABEL[e]}
                    </button>
                  ))}
                </div>
              </details>
            )}

            <details className="section">
              <summary>上一次的 Act IR</summary>
              <pre>{lastAct ? JSON.stringify(lastAct, null, 2) : '—'}</pre>
            </details>

            <div className="credits">动作：{MOTION_CREDIT}</div>
          </div>
        </aside>
      )}
    </div>
  );
}

function Track({ label, value, active }: { label: string; value: string; active?: boolean }) {
  return (
    <div className={`track ${active ? 'on' : ''}`}>
      <span className="k">{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  disabled,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  title?: string;
}) {
  return (
    <label className={`switch ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="knob" />
      {label && <span className="switch-label">{label}</span>}
    </label>
  );
}

/**
 * 角色的头像：每个模型提前拍好的头部特写（public/avatars/<id>.png，透明背景；用 dev 工具 __avatars() 重拍）。
 * 没有图（地址栏 ?model= 指定的模型等）就退回名字的第一个字
 */
function Avatar({ id, name, size }: { id: string; name: string; size: number }) {
  // 记的是"哪个 id 没有图"：换了角色自动重新试
  const [missingId, setMissingId] = useState<string | null>(null);
  const missing = missingId === id;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.44 }}>
      {missing ? (
        name.slice(0, 1)
      ) : (
        <img src={`${import.meta.env.BASE_URL}avatars/${id}.png`} alt="" draggable={false} onError={() => setMissingId(id)} />
      )}
    </span>
  );
}
