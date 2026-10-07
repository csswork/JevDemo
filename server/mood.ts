/**
 * 跨轮心情 → 输入层 system prompt 的一段（前端只发数值，见 src/act/mood.ts）。
 *
 * 为什么要告诉输入层：心情在画面上会留着（生气时 💢 一直挂着、待机脸带着气），
 * 可台词要是下一轮就热情如常，脸和话就对不上了。所以台词也得"还在气头上""要哄一阵"。
 *
 * 只说状态和分寸，不给台词范例：怎么说是人设的事。
 */

interface MoodInput {
  joy: number;
  anger: number;
  gloom: number;
}

function validMood(raw: unknown): MoodInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
  return { joy: num(r.joy), anger: num(r.anger), gloom: num(r.gloom) };
}

/** 这一轮的心情段落。心情不明显就是 null（不加这一段） */
export function moodPrompt(raw: unknown): string | null {
  const m = validMood(raw);
  if (!m) return null;
  const lines: string[] = [];

  if (m.anger >= 0.55) {
    lines.push(
      '你还在生气：刚才对方惹到你了，气还没消。语气可以冷一点、带点赌气或别扭，不要像什么都没发生一样马上热情起来。' +
        '对方认真道歉、好好哄你，你才一点点缓和下来 —— 一句话哄不好。',
    );
  } else if (m.anger >= 0.25) {
    lines.push('你还有点不高兴（刚才的事还有点在意）。语气可以稍微别扭一点，但对方好好说话，你也会慢慢软下来。');
  }

  if (m.gloom >= 0.5) lines.push('你现在情绪有点低落，提不起劲，说话会比平时安静一些。');
  else if (m.gloom >= 0.25) lines.push('你心里有点闷闷的。');

  // 生着气的时候不说"心情很好"：两句话会打架
  if (m.anger < 0.25) {
    if (m.joy >= 0.5) lines.push('你现在心情很好（刚才聊得很开心），说话自然地轻快一些。');
    else if (m.joy >= 0.25) lines.push('你心情不错。');
  }

  if (!lines.length) return null;
  return ['【你此刻的心情】', ...lines, '这是你自己的心情，不用说出来，体现在语气和回应方式里就行。'].join('\n');
}
