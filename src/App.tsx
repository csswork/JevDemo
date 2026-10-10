import {GODRAY_RANGES,type ParkGodraySettings} from './vrm/godrays/settings';
import {loadSceneDefaults,saveSceneDefaults} from './vrm/sky/sceneDefaults';
import {DEFAULT_SCENE_SETTINGS as DEFAULT_SKY_SETTINGS,type SceneSettings as SkySettings} from './vrm/sky/sceneSettings';
import type {OceanSettings} from './vrm/ocean/oceanSettings';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Runtime, type LiveState } from './runtime';
import { assetUrl } from './assets';
import { MockDecider } from './jev/mockDecider';
import { HttpDecider, probeJev, type JevMeta, type JevStatus } from './jev/httpDecider';
import type { ActDecider } from './jev/decider';
import { baselineAct, fallbackAct, type ActScript } from './act/schema';
import { isTestCommand, parseTestCommand } from './jev/testCommand';
import { probeVoice, type VoiceSession, type VoiceStatus } from './speech/voice';
import { DEFAULT_TONE, styleFor, toneFor, type VoiceStyle } from './act/voiceStyle';
import type { JevMeta as Meta } from './act/fromJev';
import { MOTION_CREDIT, motionLabel, motionSource } from './vrm/motion';
import { isGreeting } from './act/motionRules';
import { EMOTIONS, MOTIONS, type Emotion, type MotionId } from './act/schema';
import { DEFAULT_BACKDROP, DEFAULT_MODEL, MODELS, VISIBLE_MODELS, modelUrl, probeModels } from './models';
import { appendChat, chatStorage, openChat, resetChat, type ChatSession } from './chat';
import { recentForModel } from './chatMemory';
import type { BackdropId, CameraView } from './vrm/stage';
import type { SceneContext } from './jev/scene';
import { presetHours, TIME_MODES } from './vrm/timeOfDay';
import { Picker, type PickerItem } from './ui/Picker';
import { TimeSlider } from './ui/TimeSlider';
import { SpeechBubble } from './ui/SpeechBubble';
import { HoverDock } from './ui/HoverDock';
import { Loader } from './ui/Loader';
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
  IconTree,
  IconVolume,
} from './ui/icons';
import './App.css';

/** 选过的模型存在这个 key 下（只是本机浏览器的偏好） */
const MODEL_KEY = 'jev.model';
const avatarUrl = (id: string | null) => assetUrl(`${import.meta.env.BASE_URL}avatars/${id}.png`);
/** 旧版的背景偏好（所有角色共用一个）：只在第一次迁移到按角色保存时读一次 */
const BACKDROP_KEY = 'jev.backdrop';

/**
 * 每个角色自己的偏好：音色、背景、镜头视角。以选中的角色为准 —— 换角色时一起换，
 * 没设置过的角色用默认（模型自己的默认音色、街景、半身机位，见 models.ts），不继承别的角色的
 */
const PREFS_KEY = 'jev.modelPrefs';
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
const ALL_BACKDROPS: Array<{ id: BackdropId; label: string; icon: React.ReactNode }> = [
  { id: 'cafe', label: '咖啡店', icon: <IconCoffee size={18} /> },
  { id: 'animeCafe', label: '潮汐咖啡馆', icon: <IconCoffee size={18} /> },
  { id: 'park', label: '公园', icon: <IconTree size={18} /> },
  { id: 'street', label: '街景', icon: <IconCity size={18} /> },
  { id: 'none', label: '纯色', icon: <IconBlank size={18} /> },
];
/** 只在本地开发时能选的背景：两个咖啡馆线上不列。存过它们的角色在线上退回默认背景（backdropOf） */
const DEV_ONLY_BACKDROPS: BackdropId[] = ['cafe', 'animeCafe'];
const BACKDROPS = ALL_BACKDROPS.filter((b) => import.meta.env.DEV || !DEV_ONLY_BACKDROPS.includes(b.id));
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
function initialModel(avail?: Record<string, boolean>): { id: string | null; url: string } {
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
  const m = VISIBLE_MODELS.find((x) => x.id === saved && (!avail || avail[x.id])) ?? DEFAULT_MODEL;
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

/**
 * 开发用：?boot=0.6 让载入画面一直停在 60%（本地模型有缓存，正常载入一闪就过去了，调不了样子）
 */
const BOOT_PREVIEW = (() => {
  if (!import.meta.env.DEV) return null;
  const v = new URLSearchParams(location.search).get('boot');
  return v != null && Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : null;
})();

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

/** 同一个判断的结构化版本（MiniMax 用）：这一段的主导情绪和上一段不一样才算"情绪刚开始" */
function segmentStyles(meta: Meta | null | undefined): VoiceStyle[] | undefined {
  if (!meta?.segments?.length) return undefined;
  const intensity = (meta.intensity?.score ?? 1) / 2;
  let prev: string | null = null;
  return meta.segments.map((s) => {
    const st = styleFor(s.probabilities, intensity, false);
    st.onset = st.emotion !== prev;
    prev = st.emotion;
    return st;
  });
}

/** 倾听反应 → 第一段的语气（整句判断还没回来时用） */
function reactionTone(meta: Meta): string {
  const r = meta.reaction!;
  return toneFor(r.probabilities, r.intensity / 2);
}
function reactionStyle(meta: Meta): VoiceStyle {
  const r = meta.reaction!;
  return styleFor(r.probabilities, r.intensity / 2);
}

/**
 * 测试指令用：台词和每段的情绪都已知，直接按段合成。合成失败返回 null（无声播放）。
 */
async function voiced(
  rt: Runtime,
  speech: string,
  meta: Meta,
  fallback?: string,
  fallbackStyle?: VoiceStyle,
): Promise<VoiceSession | null> {
  const session = rt.createVoice(speech);
  if (!session) return null;
  const tones = segmentTones(meta);
  if (fallback) session.setFallbackTone(fallback, fallbackStyle);
  if (tones) session.setJudgedTones(tones, segmentStyles(meta));
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
  const [chatOpen, setChatOpen] = useState(false);
  // 调试面板：每次打开页面都是收着的（以前记住开合，结果总是带着上次开着的状态进来）
  const [panelOpen, setPanelOpen] = useState(false);
  const togglePanel = setPanelOpen;
  // 界面的出场：boot = 载入中（所有工具栏都藏着）→ in = 依次滑进来 → idle = 平常
  const [uiPhase, setUiPhase] = useState<'boot' | 'in' | 'idle'>('boot');
  const revealUi = () => {
    setUiPhase('in');
    window.setTimeout(() => setUiPhase('idle'), 1600);
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
  /**
   * 换角色时盖住整个画面的载入层（和开场同一个 Loader）。key 每次换都不同，重新挂载；
   * 模型载好就 done（淡出），不等她打招呼 —— 不然开场白会在载入层后面说
   */
  const [switching, setSwitching] = useState<{ key: number; id: string; progress: number; done: boolean } | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const modelPick = useRef(0);
  const [backdrop, setBackdropState] = useState<BackdropId>(DEFAULT_BACKDROP);
  // 背景音（场景的环境音）：按角色记，默认开。第一次发送消息时才真正出声（浏览器要求用户手势）
  const [ambient, setAmbient] = useState(true);
  const [timeMode, setTimeMode] = useState<TimeValue>('now');
  const [skySettings,setSkySettings]=useState<SkySettings>({...DEFAULT_SKY_SETTINGS});
  const [skyLoading,setSkyLoading]=useState(true);
  const [skySaving,setSkySaving]=useState(false);
  const [skySaveStatus,setSkySaveStatus]=useState('');
  /** 能不能保存：只有本机的 dev / preview 服务能写 public/scene-defaults/；部署后只读 */
  const [skyWritable,setSkyWritable]=useState(false);
  const skySceneRef=useRef(backdrop);skySceneRef.current=backdrop;
  useEffect(()=>{
    const controller=new AbortController();setSkyLoading(true);setSkySaveStatus('');
    const defaults={...DEFAULT_SKY_SETTINGS};
    setSkySettings(defaults);runtimeRef.current?.setSceneSettings(defaults);
    loadSceneDefaults(backdrop,controller.signal).then(({settings,writable})=>{
      if(controller.signal.aborted)return;
      setSkySettings(settings);runtimeRef.current?.setSceneSettings(settings);setSkyWritable(writable);
    }).catch(error=>{
      if(!controller.signal.aborted)setSkySaveStatus(error instanceof Error?error.message:'读取失败');
    }).finally(()=>{if(!controller.signal.aborted)setSkyLoading(false);});
    return ()=>controller.abort();
  },[backdrop]);
  // 部署后改了只是这一页里看效果，不提示"未保存"
  const unsaved=()=>setSkySaveStatus(skyWritable?'未保存':'');
  const changeSky=(values:Partial<SkySettings>)=>{
    setSkySettings(previous=>({...previous,...values}));runtimeRef.current?.setSkySettings(values);unsaved();
  };
  const changeOcean=(values:Partial<OceanSettings>)=>{setSkySettings(previous=>({...previous,ocean:{...previous.ocean,...values}}));runtimeRef.current?.setOceanSettings(values);unsaved();};
  const changeGodrays=(values:Partial<ParkGodraySettings>)=>{setSkySettings(previous=>({...previous,godrays:{...previous.godrays,...values}}));runtimeRef.current?.setGodraySettings(values);unsaved();};
  const saveSky=async()=>{
    const scene=backdrop;setSkySaving(true);setSkySaveStatus('');
    try{
      await saveSceneDefaults(scene,{...skySettings});
      if(skySceneRef.current===scene)setSkySaveStatus('已保存为场景默认参数');
    }catch(error){
      if(skySceneRef.current===scene)setSkySaveStatus(error instanceof Error?error.message:'保存失败');
    }finally{setSkySaving(false);}
  };
  /** 场景参数面板底部：本机能保存；部署后只读，改动只在这一页生效 */
  const skySaveRow=(
    <div className="sky-save">
      {skyWritable&&<button className="sky-save-button" onClick={saveSky} disabled={skyLoading||skySaving}>{skySaving?'保存中…':'Save'}</button>}
      <span role="status">{skyLoading?'读取默认参数…':skyWritable?skySaveStatus:skySaveStatus||'线上只读：默认参数在本地保存、提交推送后更新'}</span>
    </div>
  );
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
    // 首屏只等上次选中的角色；其余角色的探测放到画面出来之后。
    const preferred = initialModel();
    const preferredMeta = VISIBLE_MODELS.find((m) => m.id === preferred.id);
    probeModels(preferredMeta ? [preferredMeta] : [])
      .then((avail) => {
        if (disposed) return;
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
        revealUi();
        void probeModels().then((avail) => {
          if (!disposed) setModelAvail(avail);
        });
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
        revealUi();
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

  // 合成语音（MiniMax）。服务端配了 key 就可用，探一次就够
  const [voice, setVoice] = useState<VoiceStatus>({ ready: false });
  const ttsTouched = useRef(false);
  useEffect(() => {
    let alive = true;
    void probeVoice().then((s) => {
      if (!alive) return;
      setVoice(s);
      // 合成语音可用就默认开口说话（用户手动关过就不再替他打开）
      if (s.ready && !ttsTouched.current) setTts(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // 系统语音只在合成语音不可用时兜底
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
  const match = (id?: string | null) => voices.find((v) => id && v.id.toLowerCase() === id.toLowerCase());
  // 存下来的选择不在列表里（比如以前选的千问音色，已经删了）：退回这个角色自己的默认音色
  const model = MODELS.find((m) => m.id === modelId);
  const activeVoice = match(speaker) ?? match(model?.voice) ?? match(voice.speaker) ?? voices[0];
  const activeSpeaker = activeVoice?.id ?? voice.speaker ?? 'minimax:female-shaonv';
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
          judgeP
            .then(() => {
              const m = (decider as HttpDecider).lastMeta;
              v.setJudgedTones(segmentTones(m) ?? [], segmentStyles(m));
            })
            .catch(() => v.setJudgedTones([]));
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
    const where = chatStorage() === 'browser' ? '浏览器里留一份' : '会归档在 data/chats/archive/';
    if (!window.confirm(`清空和${who}的聊天记录？\n她会忘掉之前聊过的内容（旧记录${where}，不会删除）。`)) return;
    if (useVoice) rt.unlockAudio();
    rt.stop();
    setJevMeta(null);
    setJevError(null);
    // 聊天记录清空了，之前的心情也一起放下
    rt.resetMood();
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
    if (rt) rt.voiceSpeaker = (match(sp) ?? match(voice.speaker) ?? voices[0])?.id ?? voice.speaker ?? 'minimax:female-shaonv';
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
    setModelLoading(0);
    setModelError(null);
    setSwitching({ key: pick, id, progress: 0, done: false });
    // 先让载入层画出来：换背景（场景生成）和模型解析会把主线程占住好一阵，不等这两帧，载入层要到最后才露面。
    // 页面在后台时浏览器会暂停 requestAnimationFrame，所以最多等 120ms，不然换角色会一直卡在 0%
    await new Promise<void>((r) => {
      requestAnimationFrame(() => requestAnimationFrame(() => r()));
      setTimeout(r, 120);
    });
    if (pick !== modelPick.current) return;
    rt.pendingView = applyPrefs(id).view ?? null;
    const progress = (p: number) => {
      setModelLoading(p);
      setSwitching((s) => (s?.key === pick ? { ...s, progress: p } : s));
    };
    const leave = () => setSwitching((s) => (s?.key === pick ? { ...s, progress: 1, done: true } : s));
    try {
      // 先定好外展量再换模型：setModel 会把它交给新角色
      rt.setIdleArmClearance(m.armOut ?? 0);
      if (!(await rt.setModel(modelUrl(m), progress))) return;
      leave();
      try {
        localStorage.setItem(MODEL_KEY, id);
      } catch {
        // 存不了：这次照样生效，下次打开不记得
      }
      // 每个模型一个 session：换成她的聊天记录，第一次见面就打招呼
      await showChat(id, () => openChat(id));
    } catch (e) {
      if (pick !== modelPick.current) return;
      leave();
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
    // 记录存浏览器时服务端不记得之前聊过什么：把截好的历史带给输入层
    const browserChat = chatStorage() === 'browser';
    const memory = browserChat ? recentForModel(turns).map(({ role, text }) => ({ role, text })) : undefined;
    const ctx = { history, memory, session, scene: sceneNow(), mood: rt.moodState };
    // 台词不是服务端写的（规则模板、passthrough），或者记录存浏览器时，由前端把这一轮记进聊天记录
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
          useVoice
            ? voiced(rt, cmd.act.speech, cmd.meta, toneFor(Object.fromEntries(mix), 0.6), styleFor(Object.fromEntries(mix), 0.6))
            : null,
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
    //              （有合成语音时：先合成第一段，语气用第一反应；合成要 0.5~1.5s，角色还在"想"）
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
            if (r.meta.reaction) session?.setFallbackTone(reactionTone(r.meta), reactionStyle(r.meta));
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
            if (meta?.reaction) session.setFallbackTone(reactionTone(meta), reactionStyle(meta));
            else session.setFallbackTone(DEFAULT_TONE);
            const s = session;
            // 判断失败（降级）也要通知：后面的段不必再等，直接用倾听反应的语气合成
            judgeP
              .then(() => s.setJudgedTones(segmentTones(decider.lastMeta) ?? [], segmentStyles(decider.lastMeta)))
              .catch(() => s.setJudgedTones([]));
            if (!(await session.prepare())) session = null;
          }
        }
        const compiled = rt.play(baselineAct(speech, reaction), { voice: session });
        setTurns((t) => [...t, { role: 'character', text: compiled.text }]);
        if (browserChat) record(compiled.text);
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
      // Jev 模式下这条路的台词也是服务端写的（服务端存记录时已经记了），其余情况前端记
      if (browserChat || !(decider instanceof HttpDecider && jev.mode === 'jev')) record(compiled.text);
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
  const voiceItems: PickerItem[] = groups.flatMap((g) =>
    voices
      .filter((v) => v.group === g)
      .map((v) => ({ id: v.id, label: v.name, desc: v.desc, group: g })),
  );
  const voiceBackend = 'MiniMax Turbo';

  return (
    <div className={`app ui-${uiPhase}${backdrop === 'street' ? ' has-time' : ''}`}>
      <div className="stage">
        <canvas ref={canvasRef} />

        <SpeechBubble runtime={runtimeRef} text={subtitle} thinking={busy} name={persona?.name ?? currentModel?.name} />

        {error && (
          <div className="overlay">
            <div className="err">
              <strong>模型载入失败</strong>
              <code>{error}</code>
            </div>
          </div>
        )}
      </div>

      {/* ---------- 左上：角色（换谁）+ 她的声音（给她设定）。平时收成胶囊 ---------- */}
      <HoverDock
        className="dock-char"
        label="角色：换角色、她的声音"
        pill={
          <>
            <Avatar id={modelId ?? '?'} name={currentModel?.name ?? '?'} size={26} />
            <span className="dock-pill-label">{modelLoading != null ? `载入 ${Math.round((modelLoading ?? 0) * 100)}%` : '换角色'}</span>
            <IconChevron size={13} />
          </>
        }
      >
        {/* 现在是谁 */}
        <div className="dock-who">
          <Avatar id={modelId ?? '?'} name={currentModel?.name ?? '?'} size={40} />
          <span className="who">
            <b>{currentModel?.name ?? '地址栏指定的模型'}</b>
            <small>{currentModel?.desc ?? '（?model= 参数）'}</small>
          </span>
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

        {/* 换谁：头像一格一格摆开，点一下就换（选择会记住） */}
        <div className="dock-sec">
          <div className="dock-sec-head">换角色</div>
          <div className="char-grid" role="radiogroup" aria-label="换角色">
            {VISIBLE_MODELS.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={m.id === modelId}
                className={`char-cell${m.id === modelId ? ' on' : ''}${modelAvail[m.id] ? '' : ' na'}`}
                disabled={loading || busy || !modelAvail[m.id]}
                title={`${m.name} · ${m.desc}${modelAvail[m.id] ? '' : '（未下载）'}`}
                onClick={() => void pickModel(m.id)}
              >
                <Avatar id={m.id} name={m.name} size={42} />
                <span>{m.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 给她设定：只属于当前这个角色（按角色记住） */}
        <div className="dock-sec">
          <div className="dock-sec-head">
            <IconMic size={14} />
            她的声音
            <Switch
              checked={tts}
              onChange={(v) => {
                ttsTouched.current = true;
                setTts(v);
              }}
              label={tts ? '开口' : '静音'}
              title={voice.ready ? `语音合成：${voiceBackend}` : '合成语音不可用时用系统内置语音'}
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
              {voice.disabled || voice.error ? (
                '系统内置语音'
              ) : (
                <>
                  <span className="spinner" /> 语音连接中…
                </>
              )}
            </div>
          )}
        </div>
      </HoverDock>

      {/* ---------- 左下：场景（胶囊，往上展开换背景）+ 环境音开关（单独一个图标按钮） ---------- */}
      <div className="corner-bl" data-bubble-avoid>
        <HoverDock
          className="dock-scene"
          from="bottom"
          label="场景：换背景、环境音"
          pill={
            <>
              <span className="dock-pill-icon">{BACKDROPS.find((b) => b.id === backdrop)?.icon}</span>
              <span className="dock-pill-label">{BACKDROPS.find((b) => b.id === backdrop)?.label ?? '场景'}</span>
              <IconChevron size={13} />
            </>
          }
        >
          <div className="dock-sec">
            <div className="dock-sec-head">
              <IconImage size={14} />
              场景
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
        </HoverDock>
        {/* 环境音：只有图标（有声 / 静音），鼠标放上去提示点一下会怎样 */}
        <button
          className={`ambient-btn glass ${ambient ? 'on' : 'off'}`}
          onClick={() => pickAmbient(!ambient)}
          aria-pressed={ambient}
          aria-label={ambient ? '关闭环境音' : '打开环境音'}
          data-tip={ambient ? '环境音开着 · 点一下静音' : '环境音关了 · 点一下打开'}
        >
          <IconVolume size={17} off={!ambient} />
        </button>
      </div>

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
                  <Track
                    label="心情"
                    value={moodText(live.mood)}
                    active={Math.max(live.mood.joy, live.mood.anger, live.mood.gloom) >= 0.15}
                  />
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

            {backdrop==='street'&&(
              <details className="section" open>
                <summary>天空与海洋 <span className="count">街景</span></summary>
                <fieldset className="sky-fields" disabled={skyLoading||skySaving}>
                <div className="sliders sky-sliders">
                  {([
                    ['coverage','积云云量',0,1,.01,'%'],
                    ['cirrus','卷云云量',0,1,.01,'%'],
                    ['windDirection','风向',0,360,1,'°'],
                    ['windSpeed','风速',0,12,.1,'m/s'],
                  ] as const).map(([key,label,min,max,step,unit])=>(
                    <label className="on" key={key}>
                      <span className="n">{label}</span>
                      <input type="range" aria-label={label} min={min} max={max} step={step} value={skySettings[key]} onChange={e=>changeSky({[key]:Number(e.target.value)})}/>
                      <span className="w">{unit==='%'?Math.round(skySettings[key]*100):unit==='m/s'?skySettings[key].toFixed(1):skySettings[key]}{unit}</span>
                    </label>
                  ))}
                </div>
                <div className="sky-options">
                  <label className="live-chip"><input type="checkbox" checked={skySettings.moonPhase===null} onChange={e=>changeSky({moonPhase:e.target.checked?null:.5})}/><i className="dot"/>自动月相</label>
                  <label>质量 <select aria-label="天空质量" value={skySettings.quality} onChange={e=>changeSky({quality:e.target.value as SkySettings['quality']})}><option value="low">节能</option><option value="balanced">均衡</option><option value="high">精细</option></select></label>
                </div>
                {skySettings.moonPhase!==null&&<div className="sliders sky-sliders"><label className="on"><span className="n">月相</span><input aria-label="月相" type="range" min="0" max="1" step=".01" value={skySettings.moonPhase} onChange={e=>changeSky({moonPhase:Number(e.target.value)})}/><span className="w">{Math.round(skySettings.moonPhase*100)}%</span></label></div>}
                <div className="environment-heading">海洋</div>
                <div className="sliders sky-sliders">
                  {([
                    ['waves','波浪',0,1.5],['roughness','粗糙度',.08,.6],['foam','泡沫',0,1],['reflection','反射',0,1],['glitter','波光',0,2],
                  ] as const).map(([key,label,min,max])=>(
                    <label className="on" key={key}><span className="n">{label}</span><input type="range" aria-label={'海洋'+label} min={min} max={max} step=".01" value={skySettings.ocean[key]} onChange={e=>changeOcean({[key]:Number(e.target.value)})}/><span className="w">{skySettings.ocean[key].toFixed(2)}</span></label>
                  ))}
                </div>
                <div className="sky-options">
                  <label>波场 <select aria-label="海洋波场分辨率" value={skySettings.ocean.resolution} onChange={e=>changeOcean({resolution:Number(e.target.value) as 128|256})}><option value="128">128²</option><option value="256">256²</option></select></label>
                  <label>反射质量 <select aria-label="海洋反射质量" value={skySettings.ocean.quality} onChange={e=>changeOcean({quality:e.target.value as OceanSettings['quality']})}><option value="low">节能</option><option value="balanced">均衡</option><option value="high">精细</option></select></label>
                </div>
                {skySaveRow}
                </fieldset>
              </details>
            )}

            {backdrop==='park'&&(
              <details className="section" open>
                <summary>丁达尔光束 <span className="count">公园</span></summary>
                <fieldset className="sky-fields" disabled={skyLoading||skySaving}>
                  <div className="sky-options">
                    <label className="live-chip"><input type="checkbox" checked={skySettings.godrays.enabled} onChange={e=>changeGodrays({enabled:e.target.checked})}/><i className="dot"/>显示光束</label>
                    <label>光色 <input type="color" aria-label="光束颜色" value={skySettings.godrays.color} onChange={e=>changeGodrays({color:e.target.value})}/></label>
                  </div>
                  <div className="sliders sky-sliders">
                    {([
                      ['density','雾密度'],['maxDensity','散射上限'],['distanceAttenuation','距离衰减'],['raymarchSteps','采样步数'],['sunElevation','太阳高度'],
                    ] as const).map(([key,label])=>(
                      <label className="on" key={key}><span className="n">{label}</span><input type="range" aria-label={'光束'+label} min={GODRAY_RANGES[key][0]} max={GODRAY_RANGES[key][1]} step={key==='sunElevation'||key==='raymarchSteps'?1:key==='density'?.0005:.05} value={skySettings.godrays[key]} onChange={e=>changeGodrays({[key]:Number(e.target.value)})}/><span className="w">{key==='density'?skySettings.godrays[key].toFixed(4):skySettings.godrays[key]}{key==='sunElevation'?'°':''}</span></label>
                    ))}
                  </div>
                  <div className="sky-options"><label>分辨率 <select aria-label="体积光分辨率" value={skySettings.godrays.resolutionScale} onChange={e=>changeGodrays({resolutionScale:Number(e.target.value)})}><option value="0.25">1/4 · 节能</option><option value="0.5">1/2 · 均衡</option><option value="1">完整 · 精细</option></select></label></div>
                  {skySaveRow}
                </fieldset>
              </details>
            )}

            <div className="credits">动作：{MOTION_CREDIT}</div>
          </div>
        </aside>
      )}

      {/* 换角色的载入画面：和开场同一个，淡入盖住整个画面，模型载好就淡出 */}
      {switching && (
        <Loader
          key={switching.key}
          fadeIn
          done={switching.done}
          progress={switching.progress}
          name={MODELS.find((m) => m.id === switching.id)?.name}
          avatar={avatarUrl(switching.id)}
        />
      )}

      {/* 开场的载入画面：盖在最上面，载完了自己淡出 */}
      <Loader
        done={BOOT_PREVIEW == null && !loading}
        progress={BOOT_PREVIEW ?? progress}
        name={currentModel?.name}
        avatar={modelId ? avatarUrl(modelId) : undefined}
      />
    </div>
  );
}

/** 跨轮心情的一行字（调试面板）：只列明显的 */
function moodText(m: LiveState['mood']): string {
  const parts = (
    [
      ['开心', m.joy],
      ['生气', m.anger],
      ['低落', m.gloom],
    ] as Array<[string, number]>
  )
    .filter(([, v]) => v >= 0.05)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`);
  return parts.length ? parts.join('  ') : '平静';
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
        <img src={avatarUrl(id)} alt="" draggable={false} onError={() => setMissingId(id)} />
      )}
    </span>
  );
}
