import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandPrompt, validateExpansion } from './expandPrompt.ts';

const expansion = { prompt: '原地站稳，右臂抬起轻轻挥手，再自然垂下，双脚始终触地。', details: '肩部放松，重心稳定，手掌朝前，收势缓慢。', keyframes: [{ time: 0, pose: '双脚触地，手臂自然垂下。' }, { time: 2, pose: '右肘弯曲，手掌抬到肩部高度朝前。' }, { time: 4, pose: '右臂自然垂下，恢复站立姿态。' }] };
test('AI expansion preserves input context and returns validated description and timed key poses', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, 'deepseek-flash'); assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.thinking.type, 'disabled');
    assert.deepEqual(JSON.parse(body.messages[1].content), { description: '挥手', durationSeconds: 4, previousDetails: '双脚不动' });
    return Response.json({ choices: [{ message: { content: JSON.stringify(expansion) }, finish_reason: 'stop' }] });
  };
  try { assert.deepEqual(await expandPrompt({ apiKey: 'test' }, { prompt: '挥手', duration: 4, details: '双脚不动' }), expansion); }
  finally { globalThis.fetch = original; }
});
test('AI rejects malformed/overlong output and invalid time coverage without silent truncation', async () => {
  assert.throws(() => validateExpansion({ ...expansion, prompt: '动'.repeat(129) }, 4), /128/);
  assert.throws(() => validateExpansion({ ...expansion, keyframes: [expansion.keyframes[0], expansion.keyframes[2], expansion.keyframes[1]] }, 4), /时间/);
  assert.throws(() => validateExpansion({ ...expansion, keyframes: [{ time: 1, pose: '开始' }, ...expansion.keyframes.slice(1)] }, 4), /覆盖/);
  assert.throws(() => validateExpansion({ ...expansion, keyframes: [null, null, null] }, 4), /无效/);
  await assert.rejects(expandPrompt({ apiKey: '' }, { prompt: '挥手', duration: 4 }), /未配置/);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '{' }, finish_reason: 'length' }] });
    await assert.rejects(expandPrompt({ apiKey: 'test' }, { prompt: '挥手', duration: 4 }), /截断/);
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'wrong' } }] });
    await assert.rejects(expandPrompt({ apiKey: 'test' }, { prompt: '挥手', duration: 4 }), /JSON/);
  } finally { globalThis.fetch = original; }
});
