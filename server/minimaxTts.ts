import type { VoiceMeta } from './qwenTts.ts';
import type { VoiceStyle } from '../src/act/voiceStyle.ts';

/** 官方系统音色：https://platform.minimax.cn/docs/faq/system-voice-id */
export const MINIMAX_VOICES: VoiceMeta[] = [
  ['female-shaonv', '少女', '少女女声'],
  ['female-tianmei', '甜美', '甜美女声'],
  ['qiaopi_mengmei', '俏皮萌妹', '俏皮、可爱的角色女声'],
  ['Chinese (Mandarin)_Warm_Girl', '温暖少女', '温暖的少女女声'],
  ['Chinese (Mandarin)_Crisp_Girl', '清脆少女', '清脆的少女女声'],
  ['Chinese (Mandarin)_Soft_Girl', '柔和少女', '柔和的少女女声'],
  ['danya_xuejie', '淡雅学姐', '淡雅的年轻女声'],
  ['tianxin_xiaoling', '甜心小玲', '甜心角色女声'],
  ['diadia_xuemei', '嗲嗲学妹', '撒娇风格的学妹女声'],
  ['Chinese (Mandarin)_Gentle_Senior', '温柔学姐', '温柔的学姐女声'],
  ['Chinese (Mandarin)_Warm_Bestie', '温暖闺蜜', '温暖的闺蜜女声'],
  ['Chinese (Mandarin)_Sweet_Lady', '甜美女声', '甜美的女性声线'],
  ['female-yujie', '御姐', '御姐风格女声'],
  ['wumei_yujie', '妩媚御姐', '妩媚的御姐角色女声'],
  ['Chinese (Mandarin)_Mature_Woman', '傲娇御姐', '傲娇风格的御姐女声'],
  ['Arrogant_Miss', '嚣张小姐', '个性鲜明的小姐角色女声'],
  ['female-shaonv-jingpin', '少女（Beta）', '官方少女音色的 Beta 版本'],
  ['female-tianmei-jingpin', '甜美（Beta）', '官方甜美女声音色的 Beta 版本'],
].map(([id, name, desc]) => ({ id: `minimax:${id}`, name, desc, group: 'MiniMax 女声' }));

export interface MiniMaxConfig {
  apiKey: string;
  baseUrl: string;
}

export const MINIMAX_SAMPLE_RATE = 24000;

const EDGE = `\\s，,。.!！?？…～~：:；;、「」『』“”"'（()）—`;
/** 台词里独立成词的拟声 → 语气词标签（speech-2.8 才认）。字幕仍显示原文 */
const SOUNDS: Array<[RegExp, (w: string) => string]> = [
  [/哈{2,}|嘿{2,}|嘻{2,}/, (w) => (w.startsWith('哈') ? '(laughs)' : '(chuckle)')],
  [/噗嗤|噗/, () => '(chuckle)'],
  [/唉/, () => '(sighs)'],
  [/呜{2,}/, () => '(sniffs)'],
  [/咳{2,}/, () => '(coughs)'],
];

/**
 * 发给 MiniMax 的文本：
 *   1. 独立的拟声词换成语气词标签（"哈哈"→(laughs)、"唉"→(sighs)、"呜呜"→(sniffs)……），"哈哈镜"这种不动
 *   2. 情绪刚开始、而且很强时，开口前加一声：很难过叹气、哭的时候先抽一下鼻子、被吓到 / 很意外倒吸一口气
 *      （见 leadFor）。开心本身不自动加笑声 —— 只有台词里写了笑才笑
 */
export function textForMiniMax(text: string, style?: VoiceStyle | null): string {
  return prepareMiniMaxText(text, style).text;
}

/**
 * 同上，外加位置映射：map[i] = 发送文本第 i 个 UTF-16 单元对应原台词的哪个位置（-1 = 开口前加的那一声，
 * 原台词里没有）；末尾多一个哨兵 = 原台词长度。字幕时间戳按发送文本的位置给，靠它换回原台词。
 * 标签里的每个字符都指向被替换的那个词的开头（"唉"→"(sighs)"：叹气的时候气泡点亮"唉"）。
 */
export function prepareMiniMaxText(text: string, style?: VoiceStyle | null): { text: string; map: number[] } {
  const reps: Array<{ at: number; len: number; tag: string }> = [];
  for (const [word, tag] of SOUNDS) {
    const re = new RegExp(`(^|[${EDGE}])(${word.source})(?=$|[${EDGE}])`, 'g');
    for (const m of text.matchAll(re)) reps.push({ at: m.index! + m[1].length, len: m[2].length, tag: tag(m[2]) });
  }
  reps.sort((a, b) => a.at - b.at);
  // 台词自己已经以语气词开头（原文就是标签，或者第一个词被换成了标签）就不再叠一声
  const first = text.length - text.trimStart().length;
  const lead = text.trimStart().startsWith('(') || reps.some((r) => r.at === first) ? undefined : leadFor(style, text);
  let out = '';
  const map: number[] = [];
  const push = (str: string, from: number | ((i: number) => number)) => {
    for (let i = 0; i < str.length; i++) map.push(typeof from === 'number' ? from : from(i));
    out += str;
  };
  if (lead) push(lead, -1);
  let i = 0;
  for (const r of reps) {
    push(text.slice(i, r.at), (k) => i + k);
    push(r.tag, r.at);
    i = r.at + r.len;
  }
  push(text.slice(i), (k) => i + k);
  map.push(text.length);
  return { text: out, map };
}

/** 一个字幕词：在发送文本里的位置、在音频里的起止（毫秒） */
interface SubtitleWord {
  word_begin: number;
  word_end: number;
  time_begin: number;
  time_end: number;
}

/**
 * 字幕时间戳 → 原台词里的"第几个字 ↔ 第几秒"（字按码点数，和前端的分段一致；秒相对这段音频的开头）。
 * 开口前加的那一声不对应任何字，跳过 —— 第一个字的时间就落在那一声之后，气泡不会提前亮。
 * 结果严格递增（字和时间都不回退），最后一个点是最后一个字说完的时刻
 */
export function timesFromSubtitles(words: SubtitleWord[], map: number[], text: string): Array<{ c: number; t: number }> {
  const cp = (i: number) => [...text.slice(0, i)].length;
  const out: Array<{ c: number; t: number }> = [];
  const add = (c: number, t: number) => {
    const last = out[out.length - 1];
    if (!last || (c > last.c && t >= last.t)) out.push({ c, t });
  };
  let end: { c: number; t: number } | null = null;
  for (const w of [...words].sort((a, b) => a.time_begin - b.time_begin)) {
    const b = map[w.word_begin];
    if (b == null || b < 0) continue;
    const e = map[Math.min(w.word_end, map.length - 1)];
    add(cp(b), w.time_begin / 1000);
    if (e != null && e > b) end = { c: cp(e), t: w.time_end / 1000 };
  }
  if (end) add(end.c, end.t);
  return out;
}

/** 开口前的一声（只在情绪刚开始的那一段、强度高的时候） */
export function leadFor(style: VoiceStyle | null | undefined, text: string): string | undefined {
  if (!style?.onset || style.intensity < 0.7) return undefined;
  const { emotion, p, intensity } = style;
  if (emotion === 'sad' && p >= 0.5) return intensity >= 0.9 && p >= 0.65 ? '(sniffs)' : '(sighs)';
  // 倒吸一口气要台词本身是"诶？""啊！""哇"这类开头，不然突兀
  const startled = /^[\s…～~]*(诶|欸|啊|哇|咦|哎呀|天哪|天啊|什么)/.test(text);
  if (startled && (emotion === 'surprised' || isPanic(style)) && p >= 0.45) return '(gasps)';
  return undefined;
}

/** 慌：惊讶里带着难过 / 生气（或者反过来）→ MiniMax 的 fearful */
function isPanic(s: VoiceStyle): boolean {
  const pair = new Set([s.emotion, s.second]);
  return pair.has('surprised') && (pair.has('sad') || pair.has('angry')) && (s.p2 ?? 0) >= 0.25;
}

export interface Delivery {
  emotion?: string;
  speed: number;
  vol: number;
  pitch: number;
}

/**
 * Jev 的判断 → MiniMax 的 emotion + 语速 / 音量 / 音高。
 *
 *   emotion  只在情绪明确（主导 ≥ 0.35）而且强度不低（≥ 0.3）时给。平静、放松、害羞、弱情绪都**不给**：
 *            不给时模型按文本自己判断语气（官方默认行为），比硬塞一个 calm 自然 —— 以前全都映射成 calm，
 *            语气被压平。慌（惊讶 + 难过 / 生气）给 fearful
 *   韵律     按"强度 × 主导情绪有多纯"微调，幅度都很小（语速 ±8%、音高 ±1~2 个半音、音量 ±15%）：
 *            开心快一点高一点，难过慢一点低一点轻一点，生气快一点响一点，惊讶高一点；
 *            害羞没有对应的 emotion，靠慢一点、轻一点、略高一点
 * 没有结构化的判断（老客户端）时退回从中文语气描述里认情绪，calm 同样不给。
 */
export function deliveryFor(style?: VoiceStyle | null, instructions?: string | null): Delivery {
  const d: Delivery = { speed: 1, vol: 1, pitch: 0 };
  if (!style) {
    const e = emotionFor(instructions);
    if (e && e !== 'calm') d.emotion = e;
    return d;
  }
  const { emotion, p, intensity: k } = style;
  const w = k * Math.min(1, p / 0.6);
  if (isPanic(style) && k >= 0.3) d.emotion = 'fearful';
  else if (p >= 0.35 && k >= 0.3 && (emotion === 'happy' || emotion === 'sad' || emotion === 'angry' || emotion === 'surprised')) {
    d.emotion = emotion;
  }
  switch (emotion) {
    case 'happy':
      d.speed += 0.05 * w;
      d.pitch += Math.round(w);
      break;
    case 'sad':
      d.speed -= 0.08 * w;
      d.pitch -= Math.round(w);
      d.vol -= 0.1 * w;
      break;
    case 'angry':
      d.speed += 0.05 * w;
      d.vol += 0.15 * w;
      break;
    case 'surprised':
      d.pitch += Math.round(1.5 * w);
      break;
    case 'shy':
      d.speed -= 0.06 * Math.min(1, p / 0.6);
      d.vol -= 0.15 * Math.min(1, p / 0.6);
      if (p >= 0.5) d.pitch += 1;
      break;
    case 'relaxed':
      d.speed -= 0.04 * Math.min(1, p / 0.6);
      break;
  }
  d.speed = Math.round(d.speed * 100) / 100;
  d.vol = Math.round(d.vol * 100) / 100;
  return d;
}

/** MiniMax 不接收千问的自然语言指令；取描述中最先出现的基本情绪。混合情绪近似处理。 */
export function emotionFor(instructions?: string | null): string | undefined {
  if (!instructions) return undefined;
  const words: Array<[RegExp, string]> = [
    [/开心|轻快|惊喜|笑着/, 'happy'],
    [/生气|不耐烦|愤怒/, 'angry'],
    [/难过|失落|伤感|心酸|委屈|苦笑/, 'sad'],
    [/惊讶|又惊又喜/, 'surprised'],
    [/害怕|恐惧|慌张/, 'fearful'],
    [/厌恶/, 'disgusted'],
    [/自然|平静|温柔|放松|平和|亲切|害羞|无奈/, 'calm'],
  ];
  return words
    .map(([pattern, emotion]) => ({ index: instructions.search(pattern), emotion }))
    .filter(({ index }) => index >= 0)
    .sort((a, b) => a.index - b.index)[0]?.emotion;
}

/** HTTP + SSE → 24kHz 单声道 PCM16，与现有浏览器播放契约一致。 */
export async function synthesizeMiniMax(
  cfg: MiniMaxConfig,
  params: { text: string; voice: string; instructions?: string | null; style?: VoiceStyle | null },
  onAudio: (bytes: Buffer) => void,
  signal?: AbortSignal,
): Promise<{ sampleRate: number; times?: Array<{ c: number; t: number }> }> {
  if (!MINIMAX_VOICES.some((v) => v.id === params.voice)) throw new Error('未知 MiniMax 音色');
  const { emotion, speed, vol, pitch } = deliveryFor(params.style, params.instructions);
  const prepared = prepareMiniMaxText(params.text, params.style);
  const r = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/v1/t2a_v2`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'speech-2.8-turbo',
      text: prepared.text,
      // 逐字时间戳：气泡逐字点亮、表情锚点按真实发音的时刻走（开口前的叹气 / 倒吸气会占零点几秒）
      subtitle_enable: true,
      subtitle_type: 'word',
      stream: true,
      stream_options: { exclude_aggregated_audio: true },
      voice_setting: { voice_id: params.voice.slice('minimax:'.length), speed, vol, pitch, ...(emotion ? { emotion } : {}) },
      audio_setting: { format: 'pcm', sample_rate: MINIMAX_SAMPLE_RATE, channel: 1 },
      language_boost: 'Chinese',
    }),
    signal,
  });
  if (!r.ok || !r.body) throw new Error(`MiniMax 语音 HTTP ${r.status}`);
  const check = (json: { base_resp?: { status_code?: number; status_msg?: string } }) => {
    if (json.base_resp?.status_code) {
      throw new Error(`MiniMax 语音 ${json.base_resp.status_code}：${json.base_resp.status_msg ?? '合成失败'}`);
    }
  };
  // 鉴权或参数错误可能返回 HTTP 200 JSON，而不是 SSE。
  if (r.headers.get('content-type')?.includes('application/json')) {
    check(await r.json() as Parameters<typeof check>[0]);
    throw new Error('MiniMax 未返回语音流');
  }
  let received = false;
  let complete = false;
  /** 字幕：一段的字幕在它最后一块音频里给，结束事件里再给一份汇总（有汇总以汇总为准） */
  let words: SubtitleWord[] = [];
  let summary: SubtitleWord[] | null = null;
  const consume = (event: string) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') return;
    const json = JSON.parse(data) as {
      base_resp?: { status_code?: number; status_msg?: string };
      data?: {
        audio?: string;
        status?: number;
        subtitle?: { timestamped_words?: SubtitleWord[] };
        subtitles?: Array<{ timestamped_words?: SubtitleWord[] }>;
      };
    };
    check(json);
    // status=2 是结束事件；不播放可能包含的整段聚合音频，避免重复朗读。
    if (json.data?.status === 2) complete = true;
    if (json.data?.subtitles) summary = json.data.subtitles.flatMap((x) => x.timestamped_words ?? []);
    else if (json.data?.subtitle?.timestamped_words) words = words.concat(json.data.subtitle.timestamped_words);
    if (json.data?.status === 1 && json.data.audio) {
      if (!/^(?:[\da-f]{2})+$/i.test(json.data.audio)) throw new Error('MiniMax 返回了无效音频编码');
      onAudio(Buffer.from(json.data.audio, 'hex'));
      received = true;
    }
  };
  let pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n/.exec(pending))) {
      consume(pending.slice(0, separator.index));
      pending = pending.slice(separator.index + separator[0].length);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) consume(pending);
  if (!received) throw new Error('MiniMax 未返回音频');
  if (!complete) throw new Error('MiniMax 语音流提前结束');
  const stamped = summary ?? words;
  return stamped.length
    ? { sampleRate: MINIMAX_SAMPLE_RATE, times: timesFromSubtitles(stamped, prepared.map, params.text) }
    : { sampleRate: MINIMAX_SAMPLE_RATE };
}
