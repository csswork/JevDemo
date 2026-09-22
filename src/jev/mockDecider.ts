import type { ActScript } from '../act/schema';
import type { ActDecider, DecideContext } from './decider';

/**
 * 离线规则决策器 —— 没有任何后端也能把整条链路跑起来。
 *
 * 它不是要冒充 Jev，而是充当**表演密度的参照基准**：每条模板都刻意写成
 * 2~3 个 expression beat + 中途的视线移动，接上真 Jev 之后如果观感变差，
 * 问题多半出在 prompt 的表演密度上，而不是渲染层。
 */

type Intent =
  | 'greeting'
  | 'farewell'
  | 'thanks'
  | 'praise'
  | 'question'
  | 'low'
  | 'funny'
  | 'selfintro'
  | 'capability'
  | 'default';

const RULES: Array<[Intent, RegExp]> = [
  ['greeting', /^(hi|hello|hey)\b|你好|您好|哈喽|在吗|早上好|早安|晚上好/i],
  ['farewell', /再见|拜拜|byebye|bye\b|下次聊|晚安|先走了/i],
  ['thanks', /谢谢|感谢|多谢|thx|thanks/i],
  ['praise', /厉害|太棒|很棒|好棒|好看|可爱|喜欢你|做得好|牛/],
  ['selfintro', /你是谁|你叫什么|自我介绍|介绍一下你/],
  ['capability', /会做什么|会什么|能做什么|有什么功能|能干嘛|会干嘛|哪些能力/],
  ['low', /难过|难受|累|好烦|不开心|郁闷|糟糕|失败|压力|emo/i],
  ['funny', /哈哈|233|笑死|好笑|搞笑|有意思/],
  ['question', /[?？]|吗$|呢$|什么|为什么|怎么|如何|能不能|可不可以|是不是/],
];

function classify(input: string): Intent {
  for (const [intent, re] of RULES) {
    if (re.test(input.trim())) return intent;
  }
  return 'default';
}

/**
 * 模板。半身景别下手势看不见，所以这里全部按**表情节拍**写：
 * 每条台词 3~4 个 expression beat，落在语义转折处，并配合视线移动。
 * 锚点（<b:xxx>）名字不在手势表里时是纯时间标记，只用来给 beat 定位。
 */
const TEMPLATES: Record<Intent, ActScript[]> = {
  greeting: [
    {
      speech: '你好呀<b:hit>！我在这儿呢<b:soft>，今天想聊点什么？',
      emotion: { valence: 0.7, arousal: 0.6 },
      tracks: {
        posture: 'idle_cheerful',
        expression: [
          { at: 0, preset: 'surprised', weight: 0.35, fade: 0.1 },
          { at: { anchor: 'hit' }, preset: 'happy', weight: 1, fade: 0.18 },
          { at: { anchor: 'soft' }, preset: 'relaxed', weight: 0.8, fade: 0.35 },
          { at: 2.6, preset: 'happy', weight: 0.6, fade: 0.3 },
        ],
        gesture: [],
        gaze: [{ at: 0, target: 'camera' }],
      },
    },
    {
      speech: '嗨<b:hit>，等你好久啦<b:soft>。坐下说？',
      emotion: { valence: 0.6, arousal: 0.45 },
      tracks: {
        posture: 'idle_cheerful',
        expression: [
          { at: 0, preset: 'happy', weight: 0.9, fade: 0.15 },
          { at: { anchor: 'soft' }, preset: 'relaxed', weight: 0.9, fade: 0.4 },
          { at: 2.2, preset: 'happy', weight: 0.5, fade: 0.3 },
        ],
        gesture: [],
        gaze: [
          { at: 0, target: 'camera' },
          { at: 1.4, target: 'away_right', hold: 0.5 },
        ],
      },
    },
  ],

  farewell: [
    {
      speech: '那就下次见啦<b:turn>，路上小心。',
      emotion: { valence: 0.3, arousal: 0.35 },
      tracks: {
        posture: 'idle_neutral',
        expression: [
          { at: 0, preset: 'happy', weight: 0.7, fade: 0.25 },
          { at: { anchor: 'turn' }, preset: 'relaxed', weight: 0.9, fade: 0.45 },
          { at: 2.0, preset: 'sad', weight: 0.2, fade: 0.6 },
        ],
        gesture: [],
        gaze: [
          { at: 0, target: 'camera' },
          { at: 1.8, target: 'down', hold: 0.9 },
        ],
      },
    },
  ],

  thanks: [
    {
      speech: '不客气<b:turn>，这点小事而已。',
      emotion: { valence: 0.5, arousal: 0.35 },
      tracks: {
        posture: 'idle_neutral',
        expression: [
          { at: 0, preset: 'relaxed', weight: 0.8, fade: 0.2 },
          { at: { anchor: 'turn' }, preset: 'happy', weight: 0.8, fade: 0.28 },
          { at: 1.6, preset: 'relaxed', weight: 0.6, fade: 0.35 },
        ],
        gesture: [],
        gaze: [
          { at: 0, target: 'camera' },
          { at: 0.9, target: 'away_right', hold: 0.6 },
        ],
      },
    },
  ],

  praise: [
    {
      speech: '诶<b:hit>……被这么一夸<b:turn>，我还有点不好意思。',
      emotion: { valence: 0.6, arousal: 0.55 },
      tracks: {
        posture: 'idle_cheerful',
        expression: [
          { at: 0, preset: 'surprised', weight: 0.9, fade: 0.1 },
          { at: { anchor: 'turn' }, preset: 'happy', weight: 1, fade: 0.3 },
          { at: 2.6, preset: 'relaxed', weight: 0.85, fade: 0.4 },
        ],
        gesture: [],
        gaze: [
          { at: 0, target: 'camera' },
          { at: 0.5, target: 'away_left', hold: 1.4 },
          { at: 2.6, target: 'camera' },
        ],
      },
    },
  ],

  question: [
    {
      speech: '唔<b:think>……让我想想。这个问题得分两头看<b:turn>，你更关心哪一边？',
      emotion: { valence: 0.1, arousal: 0.45 },
      tracks: {
        posture: 'idle_alert',
        expression: [
          { at: 0, preset: 'neutral', weight: 1, fade: 0.15 },
          { at: { anchor: 'think' }, preset: 'sad', weight: 0.3, fade: 0.35 },
          { at: { anchor: 'turn' }, preset: 'relaxed', weight: 0.7, fade: 0.3 },
          { at: 4.4, preset: 'surprised', weight: 0.4, fade: 0.2 },
        ],
        gesture: [],
        gaze: [
          { at: 0, target: 'camera' },
          { at: { anchor: 'think' }, target: 'up', hold: 1.8 },
          { at: { anchor: 'turn' }, target: 'camera' },
        ],
      },
    },
    {
      speech: '嗯？<b:hit>你是说……这个意思吗<b:turn>？',
      emotion: { valence: 0.05, arousal: 0.5 },
      tracks: {
        posture: 'idle_alert',
        expression: [
          { at: 0, preset: 'surprised', weight: 0.7, fade: 0.12 },
          { at: 1.0, preset: 'neutral', weight: 1, fade: 0.3 },
          { at: { anchor: 'turn' }, preset: 'surprised', weight: 0.5, fade: 0.2 },
        ],
        gesture: [],
        gaze: [
          { at: 0, target: 'camera' },
          { at: 1.1, target: 'away_left', hold: 0.6 },
        ],
      },
    },
  ],

  low: [
    {
      speech: '……听起来今天挺不容易的<b:turn>。要不先歇一会儿，剩下的我们慢慢来。',
      emotion: { valence: -0.4, arousal: 0.2 },
      tracks: {
        posture: 'idle_low',
        expression: [
          { at: 0, preset: 'sad', weight: 0.9, fade: 0.45 },
          { at: { anchor: 'turn' }, preset: 'sad', weight: 0.55, fade: 0.5 },
          { at: 3.4, preset: 'relaxed', weight: 0.7, fade: 0.7 },
        ],
        gesture: [],
        gaze: [
          { at: 0, target: 'down', hold: 1.4 },
          { at: 2.4, target: 'camera' },
        ],
      },
    },
  ],

  funny: [
    {
      speech: '哈哈哈<b:hit>，这个我真的笑出声了。',
      emotion: { valence: 0.85, arousal: 0.8 },
      tracks: {
        posture: 'idle_cheerful',
        expression: [
          { at: 0, preset: 'happy', weight: 1, fade: 0.1 },
          { at: 1.6, preset: 'relaxed', weight: 0.9, fade: 0.35 },
          { at: 2.6, preset: 'happy', weight: 0.7, fade: 0.3 },
        ],
        gesture: [],
        gaze: [
          { at: 0, target: 'camera' },
          { at: 0.5, target: 'up', hold: 0.6 },
        ],
      },
    },
  ],

  selfintro: [
    {
      speech: '我是这套 demo 里的角色<b:turn>。文字进来，Jev 决定我怎么演，剩下的交给 three-vrm。',
      emotion: { valence: 0.4, arousal: 0.5 },
      tracks: {
        posture: 'idle_neutral',
        expression: [
          { at: 0, preset: 'relaxed', weight: 0.7, fade: 0.2 },
          { at: { anchor: 'turn' }, preset: 'neutral', weight: 1, fade: 0.3 },
          { at: 3.6, preset: 'happy', weight: 0.85, fade: 0.3 },
        ],
        gesture: [],
        gaze: [
          { at: 0, target: 'camera' },
          { at: 2.0, target: 'away_right', hold: 0.8 },
        ],
      },
    },
  ],

  capability: [
    {
      speech: '表情、视线、口型、待机是分开的四条轨道<b:turn>。所以我可以一边皱眉一边笑给你看。',
      emotion: { valence: 0.45, arousal: 0.55 },
      tracks: {
        posture: 'idle_alert',
        expression: [
          { at: 0, preset: 'neutral', weight: 1, fade: 0.2 },
          { at: { anchor: 'turn' }, preset: 'angry', weight: 0.45, fade: 0.25 },
          { at: 4.2, preset: 'happy', weight: 1, fade: 0.25 },
        ],
        gesture: [],
        gaze: [{ at: 0, target: 'camera' }],
      },
    },
  ],

  default: [
    {
      speech: '嗯<b:hit>，我听着呢。你接着说。',
      emotion: { valence: 0.2, arousal: 0.35 },
      tracks: {
        posture: 'idle_alert',
        expression: [
          { at: 0, preset: 'neutral', weight: 1, fade: 0.18 },
          { at: 0.9, preset: 'relaxed', weight: 0.7, fade: 0.35 },
          { at: 2.0, preset: 'happy', weight: 0.4, fade: 0.3 },
        ],
        gesture: [],
        gaze: [{ at: 0, target: 'camera' }],
      },
    },
    {
      speech: '这个说法有点意思<b:turn>……展开讲讲？',
      emotion: { valence: 0.3, arousal: 0.45 },
      tracks: {
        posture: 'idle_alert',
        expression: [
          { at: 0, preset: 'surprised', weight: 0.6, fade: 0.12 },
          { at: { anchor: 'turn' }, preset: 'relaxed', weight: 0.8, fade: 0.35 },
          { at: 2.4, preset: 'happy', weight: 0.55, fade: 0.25 },
        ],
        gesture: [],
        gaze: [
          { at: 0, target: 'camera' },
          { at: 1.2, target: 'away_left', hold: 0.8 },
          { at: 2.4, target: 'camera' },
        ],
      },
    },
  ],
};

export class MockDecider implements ActDecider {
  readonly name = 'mock-rules';
  private lastIndex = new Map<Intent, number>();

  async decide(input: string, _ctx: DecideContext): Promise<ActScript> {
    void _ctx;
    const intent = classify(input);
    const pool = TEMPLATES[intent];
    // 同一 intent 连续命中时轮换模板，避免复读机
    const prev = this.lastIndex.get(intent) ?? -1;
    const idx = pool.length === 1 ? 0 : (prev + 1) % pool.length;
    this.lastIndex.set(intent, idx);
    // 模拟一点决策延迟，方便观察"思考中"的 UI 状态
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
    return structuredClone(pool[idx]);
  }
}
