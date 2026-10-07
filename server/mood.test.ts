import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mood, moodPosture } from '../src/act/mood.ts';
import { moodPrompt } from './mood.ts';

/** 一轮：倾听反应（权重 1）+ 她这句话（权重 0.4） */
function turn(m: Mood, reaction: Record<string, number>, line: Record<string, number> = reaction) {
  m.feed(reaction, 1, true);
  m.feed(line, 0.4, false);
}

test('夸她：连着开心几轮，不是一轮就没了', () => {
  const m = new Mood();
  turn(m, { happy: 0.85 });
  const after = m.joy;
  assert.ok(after > 0.45, `夸完一轮 joy=${after}`);
  turn(m, { neutral: 1 });
  turn(m, { neutral: 1 });
  assert.ok(m.joy > 0.15, `两轮平淡之后还留着 joy=${m.joy}`);
  for (let i = 0; i < 4; i++) turn(m, { neutral: 1 });
  assert.ok(m.joy < 0.05, `六轮之后平了 joy=${m.joy}`);
});

test('惹她生气：平淡的几轮消不了，要哄几轮才好', () => {
  const m = new Mood();
  turn(m, { angry: 0.85 });
  const mad = m.anger;
  assert.ok(mad > 0.5, `惹完 anger=${mad}`);
  turn(m, { neutral: 1 });
  turn(m, { neutral: 1 });
  assert.ok(m.anger > 0.45, `两轮平淡还在气头上 anger=${m.anger}`);

  // 哄：对方道歉 / 夸她，她的反应偏正面
  turn(m, { relaxed: 0.5, shy: 0.3 }, { angry: 0.3, relaxed: 0.3 });
  assert.ok(m.anger > 0.3, `哄一句还没好 anger=${m.anger}`);
  assert.ok(m.joy < 0.25, `生着气时开心涨得很慢 joy=${m.joy}`);
  turn(m, { happy: 0.6, shy: 0.4 });
  turn(m, { happy: 0.7 });
  assert.ok(m.anger < 0.25, `哄了三轮消得差不多 anger=${m.anger}`);
});

test('开心着被惹：开心被冲掉', () => {
  const m = new Mood();
  turn(m, { happy: 0.9 });
  turn(m, { angry: 0.8 });
  assert.ok(m.joy < 0.15, `joy=${m.joy}`);
  assert.equal(moodPosture(m.state), 'idle_alert');
});

test('隔着时间也会慢慢消气', () => {
  const m = new Mood(0);
  turn(m, { angry: 0.9 });
  const a = m.anger;
  m.decay(900);
  assert.ok(Math.abs(m.anger - a / 2) < 1e-6);
});

test('给输入层的心情段落：不明显时不加，生气时不说心情好', () => {
  assert.equal(moodPrompt({ joy: 0.1, anger: 0, gloom: 0 }), null);
  assert.equal(moodPrompt(null), null);
  const mad = moodPrompt({ joy: 0.6, anger: 0.7, gloom: 0 })!;
  assert.match(mad, /还在生气/);
  assert.doesNotMatch(mad, /心情很好/);
  assert.match(moodPrompt({ joy: 0.6, anger: 0, gloom: 0 })!, /心情很好/);
});
