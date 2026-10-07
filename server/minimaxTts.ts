import type { VoiceMeta } from './qwenTts.ts';

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

/** 仅转换独立的笑声词，保留字幕原文；开心情绪本身不自动添加笑声。 */
export function textForMiniMax(text: string): string {
  return text.replace(
    /(^|[\s，,。.!！?？…～~：:；;、「」『』“”"'（()）—])(哈{2,}|嘿{2,}|嘻{2,})(?=$|[\s，,。.!！?？…～~：:；;、「」『』“”"'（()）—])/g,
    (_match, boundary: string, laugh: string) => `${boundary}${laugh.startsWith('哈') ? '(laughs)' : '(chuckle)'}`,
  );
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
  params: { text: string; voice: string; instructions?: string | null },
  onAudio: (bytes: Buffer) => void,
  signal?: AbortSignal,
): Promise<{ sampleRate: number }> {
  if (!MINIMAX_VOICES.some((v) => v.id === params.voice)) throw new Error('未知 MiniMax 音色');
  const emotion = emotionFor(params.instructions);
  const r = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/v1/t2a_v2`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'speech-2.8-turbo',
      text: textForMiniMax(params.text),
      stream: true,
      stream_options: { exclude_aggregated_audio: true },
      voice_setting: { voice_id: params.voice.slice('minimax:'.length), speed: 1, vol: 1, pitch: 0, ...(emotion ? { emotion } : {}) },
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
  const consume = (event: string) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') return;
    const json = JSON.parse(data) as {
      base_resp?: { status_code?: number; status_msg?: string };
      data?: { audio?: string; status?: number };
    };
    check(json);
    // status=2 是结束事件；不播放可能包含的整段聚合音频，避免重复朗读。
    if (json.data?.status === 2) complete = true;
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
  return { sampleRate: MINIMAX_SAMPLE_RATE };
}
