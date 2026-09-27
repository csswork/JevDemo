/**
 * 远程语音合成：千问 Qwen3-TTS（DashScope 接口）。
 *
 * 本地跑 Qwen3-TTS（tts/server.py）要加载 4.5~9GB 的模型、只能在 Apple Silicon 上跑，
 * 以后搬到服务器也不合适。远程版是同一个模型家族，接口是 DashScope 那套 HTTP + SSE。
 *
 *   模型   qwen3-tts-instruct-flash —— 支持 instructions（用一句话指定语气），
 *          每一段的语气就是 Jev 对这一段的判断（src/act/voiceStyle.ts）
 *   音色   系统音色里说普通话的女声（下面的 VOICES，来自官方音色列表）
 *
 * 对浏览器的接口和本地版完全一样（server/ttsProxy.ts 转发）：
 *   流式   原始 PCM 16bit 单声道 + X-Sample-Rate
 *   非流式 WAV + X-Audio-Seconds
 * 所以前端的播放、口型、时间轴一行都不用改。内部两种都走 SSE 流式，非流式只是攒齐了再给。
 *
 * key 放在 .env.local 的 DASHSCOPE_API_KEY，只在 Node 侧，不进浏览器。
 */

/** 同一套接口有几个部署，key 各不通用。没指定时自动探测（见 detectBase） */
const BASES = [
  'https://maas.qianwenaiapi.com', // 千问 AI 平台
  'https://dashscope.aliyuncs.com', // 阿里云百炼（北京）
  'https://dashscope-intl.aliyuncs.com', // 阿里云百炼（国际 / 新加坡）
];
const PATH = '/api/v1/services/aigc/multimodal-generation/generation';

export interface VoiceMeta {
  id: string;
  name: string;
  desc: string;
  group: string;
}

/** qwen3-tts-instruct-flash 的系统音色里说普通话的女声（官方音色列表） */
export const QWEN_VOICES: VoiceMeta[] = [
  ['Chelsie', '千雪', '二次元虚拟女友'],
  ['Cherry', '芊悦', '阳光积极、亲切自然的小姐姐'],
  ['Serena', '苏瑶', '温柔小姐姐'],
  ['Vivian', '十三', '拽拽的、可爱的小暴躁'],
  ['Momo', '茉兔', '撒娇搞怪，逗你开心'],
  ['Maia', '四月', '知性与温柔的碰撞'],
  ['Stella', '少女阿月', '甜到发腻的迷糊少女音'],
  ['Nini', '邻家妹妹', '软软糯糯的嗓音'],
  ['Mia', '乖小妹', '温顺乖巧'],
  ['Seren', '小婉', '温和舒缓的声线'],
  ['Bellona', '燕铮莺', '声音洪亮，吐字清晰'],
  ['Bella', '萌宝', '小萝莉'],
  ['Bunny', '萌小姬', '萌属性爆棚的小萝莉'],
].map(([id, name, desc]) => ({ id, name, desc, group: '千问系统音色' }));

export interface QwenConfig {
  apiKey: string;
  /** 省略则自动探测 */
  baseUrl?: string;
  model: string;
  defaultVoice: string;
}

let resolvedBase: string | null = null;
let detectError: string | null = null;

/**
 * 这个 key 属于哪个部署：给每个地址发一个缺字段的请求。key 不对的地址回 401/403，
 * key 对的地址回 400（参数错误）—— 不产生合成，也就不计费。
 */
export async function detectBase(cfg: QwenConfig): Promise<string | null> {
  if (cfg.baseUrl) return (resolvedBase = cfg.baseUrl.replace(/\/+$/, ''));
  if (resolvedBase) return resolvedBase;
  const errors: string[] = [];
  for (const base of BASES) {
    try {
      const r = await fetch(base + PATH, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, input: {} }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.status !== 401 && r.status !== 403) {
        detectError = null;
        return (resolvedBase = base);
      }
      errors.push(`${new URL(base).host} ${r.status}`);
    } catch (e) {
      errors.push(`${new URL(base).host} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  detectError = `这个 key 在三个部署上都不能用（${errors.join('；')}）`;
  return null;
}

export function lastDetectError() {
  return detectError;
}

/** 从 SSE 事件里取出的音频块：base64 解码后的字节 */
type OnAudio = (bytes: Buffer) => void;

/**
 * 合成一段。SSE 流式：中间的事件带 base64 音频块，最后一个带完整音频的 URL（这里用不上）。
 * 返回采样率。
 */
export async function synthesize(
  cfg: QwenConfig,
  params: { text: string; voice?: string; instructions?: string | null },
  onAudio: OnAudio,
  signal?: AbortSignal,
): Promise<{ sampleRate: number }> {
  const base = await detectBase(cfg);
  if (!base) throw new Error(detectError ?? '千问语音不可用');
  const voice = QWEN_VOICES.some((v) => v.id === params.voice) ? params.voice! : cfg.defaultVoice;
  const input: Record<string, unknown> = { text: params.text, voice, language_type: 'Chinese' };
  if (params.instructions && /instruct/.test(cfg.model)) {
    input.instructions = params.instructions;
    // 不让服务端改写指令：语气已经是从 Jev 的判断精确换算出来的
    input.optimize_instructions = false;
  }
  const r = await fetch(base + PATH, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-SSE': 'enable',
    },
    body: JSON.stringify({ model: cfg.model, input }),
    signal,
  });
  if (!r.ok || !r.body) {
    const detail = await r.text().catch(() => '');
    throw new Error(`千问语音 ${r.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }

  let sampleRate = 24000;
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    // SSE：事件之间空行分隔，数据在 data: 行里
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (!data) continue;
      let json: {
        output?: { audio?: { data?: string; sample_rate?: number } };
        code?: string;
        message?: string;
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.code) throw new Error(`千问语音 ${json.code}：${json.message ?? ''}`);
      const audio = json.output?.audio;
      if (audio?.sample_rate) sampleRate = audio.sample_rate;
      if (audio?.data) onAudio(Buffer.from(audio.data, 'base64'));
    }
  }
  return { sampleRate };
}
