import type { Edits, Version } from '../shared';
import { BONE_LABELS } from './boneEditing.ts';

export type Segment = { text: string; type: 'same' | 'add' | 'del' };
export interface CompareRow { label: string; before: string; after: string; changed: boolean }
export interface BoneChange { bone: string; label: string; kind: '新增' | '移除' | '调整'; detail: string }
export interface VersionComparison { prompt: Segment[] | null; detailsChanged: boolean; feedback?: string; rows: CompareRow[]; bones: BoneChange[] }

/** Character-level diff; descriptions are at most 128 characters, so plain LCS is cheap. */
export function diffText(before: string, after: string): Segment[] {
  const a = [...before]; const b = [...after];
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Segment[] = [];
  const push = (text: string, type: Segment['type']) => { const last = out.at(-1); if (last?.type === type) last.text += text; else out.push({ text, type }); };
  let i = 0; let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { push(a[i++], 'same'); j++; }
    else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) push(b[j++], 'add');
    else push(a[i++], 'del');
  }
  return out;
}

const seconds = (v: number) => `${+v.toFixed(2)}s`;
const onOff = (v: boolean) => v ? '开' : '关';
const signed = (v: number, unit: string) => `${v > 0 ? '+' : ''}${+v.toFixed(1)}${unit}`;
function axes(before: number[] | undefined, after: number[] | undefined, scale: number, unit: string, kind: string) {
  const parts = ['X', 'Y', 'Z'].flatMap((axis, i) => {
    const d = ((after?.[i] ?? 0) - (before?.[i] ?? 0)) * scale;
    return Math.abs(d) >= .05 ? [`${axis} ${signed(d, unit)}`] : [];
  });
  return parts.length ? `${kind} ${parts.join(' ')}` : '';
}
function boneChanges(before: Edits, after: Edits): BoneChange[] {
  const ids = new Set([...Object.keys(before.offsets), ...Object.keys(after.offsets), ...Object.keys(before.positions ?? {}), ...Object.keys(after.positions ?? {})]);
  const order = Object.keys(BONE_LABELS);
  return [...ids].sort((x, y) => order.indexOf(x) - order.indexOf(y)).flatMap(bone => {
    const had = bone in before.offsets || bone in (before.positions ?? {});
    const has = bone in after.offsets || bone in (after.positions ?? {});
    const detail = [axes(before.offsets[bone], after.offsets[bone], 1, '°', '旋转'), axes(before.positions?.[bone], after.positions?.[bone], 100, 'cm', '位置')].filter(Boolean).join('；');
    if (!detail && had === has) return [];
    return [{ bone, label: BONE_LABELS[bone] ?? bone, kind: !had ? '新增' : !has ? '移除' : '调整', detail: detail || '数值为 0' } as BoneChange];
  });
}

/** What changed from the parent version to this one; `edits` may be the unsaved edits on screen. */
export function compareVersions(parent: Version, version: Version, edits: Edits = version.edits): VersionComparison {
  const a = parent.edits; const b = edits;
  const trim = (e: Edits) => `${seconds(e.start)} – ${e.end ? seconds(e.end) : '结尾'}`;
  const rows: CompareRow[] = [
    ['时长', `${parent.duration}s`, `${version.duration}s`],
    ['描述扩写', onOff(parent.rewrite), onOff(version.rewrite)],
    ['裁剪', trim(a), trim(b)],
    ['播放速度', `${a.speed.toFixed(2)}×`, `${b.speed.toFixed(2)}×`],
    ['循环', onOff(a.loop), onOff(b.loop)],
    ['锁定水平位移', onOff(a.inPlace), onOff(b.inPlace)],
    ['校正地面', onOff(a.ground), onOff(b.ground)],
  ].map(([label, before, after]) => ({ label, before, after, changed: before !== after }));
  return {
    prompt: parent.prompt === version.prompt ? null : diffText(parent.prompt, version.prompt),
    detailsChanged: (parent.details ?? '') !== (version.details ?? ''),
    feedback: version.feedback, rows, bones: boneChanges(a, b),
  };
}
