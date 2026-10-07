import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkImages, expandPrompt, reviseFromFeedback, validateExpansion, validateRevision } from './expandPrompt.ts';

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
test('feedback revision sends the previous round, feedback and history, and requires a change summary', async () => {
  const original = globalThis.fetch;
  const history = [{ label: '版本 1', prompt: '挥手' }, { label: '版本 2', prompt: '站在原地挥手', feedback: '双脚乱动' }];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init!.body as string);
    assert.match(body.messages[0].content, /最小必要修改/);
    assert.deepEqual(JSON.parse(body.messages[1].content), { previousDescription: '站在原地挥手', previousDetails: '', durationSeconds: 4, feedback: '手抬得不够高', history });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ ...expansion, changes: '右手抬到头顶高度，回应“手不够高”。' }) }, finish_reason: 'stop' }] });
  };
  try {
    const revision = await reviseFromFeedback({ apiKey: 'test' }, { prompt: '站在原地挥手', duration: 4, feedback: ' 手抬得不够高 ', history });
    assert.equal(revision.changes, '右手抬到头顶高度，回应“手不够高”。'); assert.equal(revision.prompt, expansion.prompt);
  } finally { globalThis.fetch = original; }
  assert.throws(() => validateRevision(expansion, 4), /改了什么/);
  await assert.rejects(reviseFromFeedback({ apiKey: 'test' }, { prompt: '挥手', duration: 4, feedback: '', history: [] }), /哪里需要改/);
  await assert.rejects(reviseFromFeedback({ apiKey: 'test' }, { prompt: '', duration: 4, feedback: '手高点', history: [] }), /手动/);
});
test('screenshots go to DeepSeek as image parts next to the JSON text, and malformed images are rejected', async () => {
  const original = globalThis.fetch; const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init!.body as string);
    assert.match(body.messages[0].content, /当前帧/);
    const [text, ...parts] = body.messages[1].content;
    assert.equal(text.type, 'text'); assert.equal(JSON.parse(text.text).feedback, '手太低');
    assert.deepEqual(parts, [{ type: 'image_url', image_url: { url: image, detail: 'auto' } }, { type: 'image_url', image_url: { url: image, detail: 'auto' } }]);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ ...expansion, changes: '图中第 4 帧右手只到胸口，改为抬过头顶。' }) }, finish_reason: 'stop' }] });
  };
  try { assert.match((await reviseFromFeedback({ apiKey: 'test' }, { prompt: '挥手', duration: 4, feedback: '手太低', history: [], images: [image, image] })).changes, /第 4 帧/); }
  finally { globalThis.fetch = original; }
  assert.deepEqual(checkImages(undefined), []);
  assert.throws(() => checkImages(['https://example.com/a.jpg']), /截图无效/);
  assert.throws(() => checkImages(['data:image/svg+xml;base64,AAAA']), /截图无效/);
  assert.throws(() => checkImages(Array(5).fill(image)), /截图无效/);
});
