import type { PromptExpansion } from '../shared.ts';
import { InputError } from './store.ts';

export interface ExpansionOptions { apiKey: string; baseUrl?: string; model?: string }
export function validateExpansion(value: unknown, duration: number): PromptExpansion {
  const v = value as PromptExpansion | null;
  if (!v || typeof v.prompt !== 'string' || !v.prompt.trim() || [...v.prompt.trim()].length > 128) throw new Error('AI 返回的生成描述为空或超过 128 字，请重试');
  if (typeof v.details !== 'string' || !v.details.trim() || v.details.length > 8000) throw new Error('AI 没有返回有效的动作细节');
  if (!Array.isArray(v.keyframes) || v.keyframes.length < 3 || v.keyframes.length > 12) throw new Error('AI 返回的关键姿态数量无效');
  let last = -1;
  for (const frame of v.keyframes) {
    if (!frame || !Number.isFinite(frame.time) || frame.time < 0 || frame.time > duration || frame.time <= last || typeof frame.pose !== 'string' || !frame.pose.trim() || frame.pose.length > 1000) throw new Error('AI 返回的关键姿态时间或描述无效');
    last = frame.time;
  }
  if (v.keyframes[0].time !== 0 || Math.abs(v.keyframes.at(-1)!.time - duration) > .01) throw new Error('AI 的关键姿态需要覆盖起始与结束时刻');
  if (v.details.length + v.keyframes.reduce((sum, f) => sum + f.pose.length + 20, 0) > 7900) throw new Error('AI 返回的动作细节过长，请重试');
  return { prompt: v.prompt.trim(), details: v.details.trim(), keyframes: v.keyframes.map(f => ({ time: f.time, pose: f.pose.trim() })) };
}
export async function expandPrompt(opts: ExpansionOptions, input: { prompt: unknown; duration: unknown; details?: unknown }): Promise<PromptExpansion> {
  if (!opts.apiKey) throw new InputError('项目 .env.local 中未配置 DEEPSEEK_API_KEY');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || [...input.prompt].length > 128) throw new InputError('请先填写 1–128 字的动作描述');
  if (!Number.isInteger(input.duration) || Number(input.duration) < 1 || Number(input.duration) > 12) throw new InputError('时长须为 1–12 秒');
  if (input.details !== undefined && (typeof input.details !== 'string' || input.details.length > 8000)) throw new InputError('动作细节最多 8000 字');
  const duration = Number(input.duration);
  const system = `你是人体动画导演，帮助用户细化 HY-Motion 1.0 的动作描述。保留原动作意图、左右侧、方向、接触对象和动作顺序。不要擅自增加走路、跳跃、转身、道具或新的动作。不要把服装、灯光、场景美术或面部微表情作为骨骼动作重点。
输出一个 json 对象，格式：{"prompt":"可直接用于生成的中文动作描述（总计不超过128个字符）","details":"中文动作细节：起始姿态、身体重心、躯干朝向、肩肘腕配合、手掌方向、腿脚触地、动作节奏、停止和收势；有接触时说明接触部位，不确定角度不要编造精确数字","keyframes":[{"time":0,"pose":"起始关键姿态"},{"time":1.5,"pose":"过渡关键姿态"},{"time":3,"pose":"结束关键姿态"}]}。
prompt 要覆盖动作的主要阶段与最关键的身体细节，不能只是空泛修饰；超出长度时保留核心动作，省略次要修饰。details 与 keyframes 是用户的迭代参考，绝不声称它们已经约束了生成器。
根据用户指定的时长设计 3–8 个关键姿态，时间严格递增，第一项为0秒，最后一项必须等于用户时长。描述准备、抬起/发力、最高/接触姿态、停留/反向、缓动收势。若原动作是周期循环，说明首尾一致；若不是循环，不要自行改成循环。每个关键姿态要说明可以看见的肢体位置、重心/触地以及衔接方式。只输出 json，不要代码围栏或解释。`;
  const response = await fetch(`${(opts.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model || 'deepseek-flash', messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ description: input.prompt, durationSeconds: duration, previousDetails: input.details || '' }) }], response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 3000, stream: false }),
    signal: AbortSignal.timeout(90000),
  });
  const result = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(`DeepSeek 请求失败（${response.status}）${result?.error?.message ? `：${result.error.message}` : ''}`);
  const choice = result?.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('AI 输出被截断，请重试');
  if (!choice?.message?.content?.trim()) throw new Error('DeepSeek 没有返回动作描述，请重试');
  let decoded: unknown;
  try { decoded = JSON.parse(choice.message.content); } catch { throw new Error('DeepSeek 返回了无效 JSON，请重试'); }
  return validateExpansion(decoded, duration);
}
