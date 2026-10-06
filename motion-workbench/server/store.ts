import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultEdits, type Motion, type Version, type Edits } from '../shared.ts';

export class InputError extends Error { status = 400; }
export function checkDraft(value: unknown): { name: string; prompt: string; duration: number; rewrite: boolean; ready: boolean } {
  const v = value as Partial<Motion> | null;
  if (!v || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80) throw new InputError('名称不能为空，最多 80 字');
  if (typeof v.prompt !== 'string' || [...v.prompt].length > 128) throw new InputError('描述最多 128 字');
  if (!Number.isInteger(v.duration) || v.duration! < 1 || v.duration! > 12) throw new InputError('时长须为 1–12 秒的整数');
  if (typeof v.rewrite !== 'boolean' || typeof v.ready !== 'boolean') throw new InputError('无效的动作设置');
  return { name: v.name.trim(), prompt: v.prompt.trim(), duration: v.duration!, rewrite: v.rewrite, ready: v.ready };
}
export function checkEdits(value: unknown): Edits {
  const e = value as Edits | null;
  if (!e || ![e.start, e.end, e.speed].every(Number.isFinite) || e.start < 0 || e.end < 0 || (e.end !== 0 && e.end <= e.start) || e.speed < .1 || e.speed > 3) throw new InputError('裁剪范围或速度无效');
  if (![e.loop, e.inPlace, e.ground].every(x => typeof x === 'boolean') || !e.offsets || typeof e.offsets !== 'object') throw new InputError('无效的编辑设置');
  for (const [bone, angles] of Object.entries(e.offsets)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(bone) || !Array.isArray(angles) || angles.length !== 3 || !angles.every(x => Number.isFinite(x) && Math.abs(x) <= 180)) throw new InputError('骨骼偏移无效');
  }
  return structuredClone(e);
}
export class Store {
  motions: Motion[];
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    this.motions = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')).motions : [];
  }
  get file() { return path.join(this.dir, 'library.json'); }
  save() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ schema: 1, motions: this.motions }, null, 2));
    fs.renameSync(temp, this.file);
  }
  motion(id: string, includeDeleted = false) {
    const m = this.motions.find(m => m.id === id && (includeDeleted || !m.deletedAt));
    if (!m) throw new InputError('动作不存在');
    return m;
  }
  version(id: string, vid: string) {
    const v = this.motion(id).versions.find(v => v.id === vid);
    if (!v) throw new InputError('版本不存在');
    return v;
  }
  touch(m: Motion) { m.updatedAt = new Date().toISOString(); this.save(); }
  create(data: unknown) {
    const m: Motion = { ...checkDraft(data), id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), versions: [] };
    this.motions.unshift(m); this.save(); return m;
  }
  update(id: string, data: unknown) { const m = this.motion(id); Object.assign(m, checkDraft(data)); this.touch(m); return m; }
  trash(id: string) {
    const m = this.motion(id);
    if (m.versions.some(v => ['submitting', 'WAIT', 'RUN'].includes(v.status))) throw new InputError('生成中的动作请等待任务结束再删除');
    m.deletedAt = new Date().toISOString(); this.touch(m);
  }
  restore(id: string) { const m = this.motion(id, true); delete m.deletedAt; this.touch(m); }
  mature(id: string, vid: string, ready: unknown) {
    const m = this.motion(id); const v = this.version(id, vid);
    if (typeof ready !== 'boolean' || v.status !== 'DONE' || !v.asset) throw new InputError('只能标记已完成的版本');
    m.ready = ready; if (ready) m.readyVersionId = vid; else delete m.readyVersionId;
    this.touch(m); return m;
  }
  addVersion(id: string, source: Version['source']) {
    const m = this.motion(id);
    const v: Version = { id: randomUUID(), label: `版本 ${m.versions.length + 1}`, createdAt: new Date().toISOString(), prompt: m.prompt, duration: m.duration, rewrite: m.rewrite, source, status: source === 'generated' ? 'submitting' : 'DONE', edits: defaultEdits(), notes: '' };
    m.versions.push(v); m.ready = false; delete m.readyVersionId; this.touch(m); return v;
  }
  revise(id: string, vid: string, data: { edits: unknown; notes: unknown; label: unknown }) {
    const old = this.version(id, vid);
    if (old.status !== 'DONE' || !old.asset) throw new InputError('只能调整已完成版本');
    if (typeof data.notes !== 'string' || data.notes.length > 4000 || typeof data.label !== 'string' || !data.label.trim() || data.label.length > 80) throw new InputError('版本名或备注无效');
    const m = this.motion(id);
    const v: Version = { ...structuredClone(old), id: randomUUID(), parentId: vid, label: data.label.trim(), notes: data.notes, edits: checkEdits(data.edits), createdAt: new Date().toISOString() };
    m.versions.push(v); m.ready = false; delete m.readyVersionId; this.touch(m); return v;
  }
  assetPath(asset: string) {
    if (!/^[a-f0-9-]{36}\.fbx$/.test(asset)) throw new InputError('无效的文件名');
    return path.join(this.dir, 'assets', asset);
  }
}
