/**
 * 把一句回应切成最多 3 个"情绪段"。
 *
 * 一句话里情绪是会变的：「诶？真的吗！那太好了……不过我有点担心。」是惊讶 → 开心 → 担忧。
 * 整句只判断一个情绪，演出来就是一张脸从头挂到尾。所以按句切段，每段让 Jev 单独判断。
 *
 * 为什么最多 3 段：Jev 一次评估 5 个问题以内算 1 credit。3 段情绪 + 强度 + 视线正好 5 个。
 * 为什么按标点切而不是让输入层标：台词二期会换成实时语音（gpt-live），那边不会配合标段；
 * 标点是两边都有的东西。
 *
 * 服务端（出题）和前端（放锚点）都调用这一个函数，保证两边切出来的段一致。
 * 在配置链上（jevProxy → jev.ts → fromJev.ts → 这里），所以 import 要写 .ts 扩展名。
 */

export interface Segment {
  text: string;
  /** 在整句（去掉锚点后）里的起始字符下标 */
  start: number;
}

const SENTENCE_END = /[。！？!?…~～]/;
const CLAUSE_END = /[，,、；;：:]/;
const PUNCT = /[\s。！？!?…~～，,、；;：:""''「」『』（）()—·]/g;

/** 去掉标点后的字数 */
const weight = (s: string) => s.replace(PUNCT, '').length;

function splitBy(text: string, isEnd: (ch: string) => boolean): Segment[] {
  const out: Segment[] = [];
  const chars = [...text];
  let start = 0;
  let buf = '';
  for (let i = 0; i < chars.length; i++) {
    buf += chars[i];
    // 连续的标点（"？！"、"……"）归到同一段末尾
    const next = chars[i + 1];
    if (isEnd(chars[i]) && !(next && isEnd(next))) {
      out.push({ text: buf, start });
      start = i + 1;
      buf = '';
    }
  }
  if (buf) out.push({ text: buf, start });
  return out;
}

export function splitSegments(text: string, max = 3): Segment[] {
  const clean = text.trim();
  if (!clean) return [{ text: '', start: 0 }];

  let segs = splitBy(clean, (ch) => SENTENCE_END.test(ch));

  // 只有一句但很长、中间有逗号：按分句再切一次（"虽然有点累，但是真的很开心"）
  if (segs.length < max) {
    const refined: Segment[] = [];
    for (const s of segs) {
      if (weight(s.text) >= 14) {
        refined.push(
          ...splitBy(s.text, (ch) => CLAUSE_END.test(ch)).map((c) => ({ ...c, start: c.start + s.start })),
        );
      } else refined.push(s);
    }
    segs = refined;
  }

  // 太短的段（"嗯，""那个，"）并进下一段。但"诶？""啊！"这种单字感叹是很强的情绪单元，保留
  const merged: Segment[] = [];
  let carry: Segment | null = null;
  for (const s of segs) {
    const cur: Segment = carry ? { text: carry.text + s.text, start: carry.start } : { ...s };
    carry = null;
    if (weight(cur.text) < 2 && !/[！？!?]/.test(cur.text)) {
      carry = cur;
      continue;
    }
    merged.push(cur);
  }
  if (carry) {
    if (merged.length) merged[merged.length - 1].text += carry.text;
    else merged.push(carry);
  }
  segs = merged;

  // 超过上限：反复合并相邻两段里合起来最短的一对
  while (segs.length > max) {
    let best = 0;
    for (let i = 1; i < segs.length - 1; i++) {
      if (weight(segs[i].text) + weight(segs[i + 1].text) < weight(segs[best].text) + weight(segs[best + 1].text)) {
        best = i;
      }
    }
    segs.splice(best, 2, { text: segs[best].text + segs[best + 1].text, start: segs[best].start });
  }
  return segs;
}
