import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emotionFor, MINIMAX_VOICES, synthesizeMiniMax, textForMiniMax } from './minimaxTts.ts';

const cfg = { apiKey: 'test-key', baseUrl: 'https://example.invalid/' };
const params = { text: '你好呀！', voice: MINIMAX_VOICES[0].id, instructions: '用开心、轻快的语气说' };
const event = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;

test('独立笑声转为表演标签，普通词语、引用和现有标签不误改', () => {
  assert.equal(textForMiniMax('哈哈哈，这个太好笑了！'), '(laughs)，这个太好笑了！');
  assert.equal(textForMiniMax('真的？嘿嘿，嘻嘻。'), '真的？(chuckle)，(chuckle)。');
  assert.equal(textForMiniMax('看这个哈哈镜。'), '看这个哈哈镜。');
  assert.equal(textForMiniMax('你说的哈哈是什么意思？'), '你说的哈哈是什么意思？');
  assert.equal(textForMiniMax('今天很开心！'), '今天很开心！');
  assert.equal(textForMiniMax('(laughs) 好好笑！'), '(laughs) 好好笑！');
});

function streamResponse(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      // 刻意在 JSON、中文和 CRLF 边界拆开网络包。
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('解码跨网络包的 PCM，结束事件的聚合音频不重复播放', async (t) => {
  const signal = new AbortController().signal;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://example.invalid/v1/t2a_v2');
    assert.equal(init.signal, signal);
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-key');
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, 'speech-2.8-turbo');
    assert.equal(body.voice_setting.voice_id, 'female-shaonv');
    assert.equal(body.voice_setting.emotion, 'happy');
    assert.deepEqual(body.audio_setting, { format: 'pcm', sample_rate: 24000, channel: 1 });
    assert.equal(body.stream_options.exclude_aggregated_audio, true);
    return streamResponse(event({ data: { status: 1, audio: '01000200' } }) + event({ data: { status: 1, audio: '0300' } }) + event({ data: { status: 2, audio: '010002000300' } }));
  });
  const chunks: Buffer[] = [];
  assert.deepEqual(await synthesizeMiniMax(cfg, params, (b) => chunks.push(b), signal), { sampleRate: 24000 });
  assert.equal(Buffer.concat(chunks).toString('hex'), '010002000300');
});

test('HTTP 200 的 JSON 鉴权错误也必须报错', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ base_resp: { status_code: 1004, status_msg: '鉴权失败' } }));
  await assert.rejects(synthesizeMiniMax(cfg, params, () => assert.fail('不应返回音频')), /1004.*鉴权失败/);
});

test('SSE 错误、空音频和截断的音频流均报错', async (t) => {
  for (const [body, error] of [
    [event({ base_resp: { status_code: 1008, status_msg: '余额不足' } }), /1008.*余额不足/],
    [event({ data: { status: 2 } }), /未返回音频/],
    [event({ data: { status: 1, audio: '0100' } }), /提前结束/],
    [event({ data: { status: 1, audio: 'xyz' } }), /无效音频编码/],
  ] as const) {
    const mock = t.mock.method(globalThis, 'fetch', async () => streamResponse(body));
    await assert.rejects(synthesizeMiniMax(cfg, params, () => {}), error);
    mock.mock.restore();
  }
});

test('拒绝未知音色，不发送付费请求', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('不应发请求'));
  await assert.rejects(synthesizeMiniMax(cfg, { ...params, voice: 'minimax:unknown' }, () => {}), /未知 MiniMax 音色/);
});

test('情绪描述按主导情绪映射，未识别描述交给模型自行判断', () => {
  assert.equal(emotionFor('用温柔里带点伤感的语气说'), 'calm');
  assert.equal(emotionFor('用难过里带点温柔的语气说'), 'sad');
  assert.equal(emotionFor('用害羞又开心的语气说'), 'calm');
  assert.equal(emotionFor('用生气、不耐烦的语气说'), 'angry');
  assert.equal(emotionFor(null), undefined);
  assert.equal(emotionFor('用播音腔说'), undefined);
});
