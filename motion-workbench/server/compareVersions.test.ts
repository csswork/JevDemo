import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, diffText } from '../src/compareVersions.ts';
import { defaultEdits, type Version } from '../shared.ts';

const base: Version = { id: 'a', label: '版本 1', createdAt: '', prompt: '站在原地，右手挥手', details: '', duration: 4, rewrite: true, source: 'generated', status: 'DONE', edits: defaultEdits(), notes: '' };

test('description diff marks only inserted and removed characters', () => {
  const segments = diffText('右手挥手', '右手抬过头顶挥手三下');
  assert.equal(segments.filter(s => s.type !== 'add').map(s => s.text).join(''), '右手挥手');
  assert.equal(segments.filter(s => s.type !== 'del').map(s => s.text).join(''), '右手抬过头顶挥手三下');
  assert.deepEqual(segments.filter(s => s.type === 'add').map(s => s.text), ['抬过头顶', '三下']);
  assert.deepEqual(diffText('同样', '同样'), [{ text: '同样', type: 'same' }]);
});

test('comparison lists changed settings and per-bone deltas, including unsaved edits', () => {
  const parent = { ...base, edits: { ...defaultEdits(), offsets: { L_Wrist: [10, 0, 0] as [number, number, number], R_Elbow: [0, 5, 0] as [number, number, number] } } };
  const child: Version = { ...base, id: 'b', label: '版本 2', parentId: 'a', feedback: '手不够高', prompt: '站在原地，右手抬过头顶挥手', details: '新细节', edits: parent.edits };
  const current = { ...parent.edits, start: .5, speed: .8, offsets: { L_Wrist: [22, 0, -3] as [number, number, number], Head: [0, 0, 8] as [number, number, number] }, positions: { Pelvis: [0, -.284, 0] as [number, number, number] } };
  const c = compareVersions(parent, child, current);
  assert.equal(c.feedback, '手不够高'); assert.equal(c.detailsChanged, true);
  assert.deepEqual(c.prompt!.filter(s => s.type === 'add').map(s => s.text), ['抬过头顶']);
  assert.deepEqual(c.rows.filter(r => r.changed).map(r => [r.label, r.before, r.after]), [['裁剪', '0s – 结尾', '0.5s – 结尾'], ['播放速度', '1.00×', '0.80×']]);
  assert.deepEqual(c.bones.map(b => [b.bone, b.kind, b.detail]), [
    ['Pelvis', '新增', '位置 Y -28.4cm'], ['Head', '新增', '旋转 Z +8°'],
    ['R_Elbow', '移除', '旋转 Y -5°'], ['L_Wrist', '调整', '旋转 X +12° Z -3°'],
  ]);
  const same = compareVersions(parent, { ...parent, id: 'c', parentId: 'a' });
  assert.equal(same.prompt, null); assert.equal(same.bones.length, 0); assert.ok(same.rows.every(r => !r.changed));
});
