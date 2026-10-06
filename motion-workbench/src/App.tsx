import { useEffect, useRef, useState } from 'react';
import type { Edits, Library, Motion, Version } from '../shared';
import { defaultEdits } from '../shared';
import { Preview, type PreviewHandle } from './Preview';

const API = '/api/workbench';
async function api<T>(url = '', method = 'GET', data?: unknown): Promise<T> {
  const r = await fetch(`${API}${url}`, { method, headers: data instanceof File ? {} : { 'Content-Type': 'application/json' }, body: data instanceof File ? data : data === undefined ? undefined : JSON.stringify(data) });
  const value = await r.json(); if (!r.ok) throw new Error(value.error ?? '操作失败'); return value;
}
function download(data: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const statusText: Record<string, string> = { submitting: '提交中', WAIT: '排队中', RUN: '生成中', DONE: '可预览', FAIL: '失败' };
const emptyDraft = { name: '', prompt: '', duration: 5, rewrite: true, ready: false };
export default function App() {
  const [library, setLibrary] = useState<Library>({ motions: [], configured: false });
  const [selected, setSelected] = useState(''); const [vid, setVid] = useState('');
  const [draft, setDraft] = useState(emptyDraft); const [edits, setEdits] = useState<Edits>(defaultEdits());
  const [notes, setNotes] = useState(''); const [label, setLabel] = useState('');
  const [query, setQuery] = useState(''); const [trash, setTrash] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [playing, setPlaying] = useState(false); const [time, setTime] = useState(0); const [duration, setDuration] = useState(0); const [editedDuration, setEditedDuration] = useState(0);
  const [target, setTarget] = useState('source'); const [skeleton, setSkeleton] = useState(true); const [bone, setBone] = useState('L_Shoulder');
  const [customModel, setCustomModel] = useState('');
  const file = useRef<HTMLInputElement>(null); const model = useRef<HTMLInputElement>(null); const preview = useRef<PreviewHandle | null>(null);
  const motion = library.motions.find(m => m.id === selected);
  const version = motion?.versions.find(v => v.id === vid);
  const editDirty = !!version && (JSON.stringify(edits) !== JSON.stringify(version.edits) || notes !== version.notes || label !== version.label);
  const draftDirty = !!motion && ['name', 'prompt', 'duration', 'rewrite', 'ready'].some(k => draft[k as keyof typeof draft] !== motion[k as keyof Motion]);
  const active = library.motions.some(m => m.versions.some(v => ['submitting', 'WAIT', 'RUN'].includes(v.status)));
  async function refresh() { const data = await api<Library>(); setLibrary(data); return data; }
  useEffect(() => {
    void api<Library>().then(setLibrary).catch(e => setError(e.message));
    const interval = setInterval(() => { void refresh().catch(e => setError(e.message)); }, 3000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => { if (editDirty || draftDirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [editDirty, draftDirty]);
  useEffect(() => () => { if (customModel) URL.revokeObjectURL(customModel); }, [customModel]);
  function loadVersion(v?: Version) {
    setVid(v?.id ?? ''); setEdits(v ? structuredClone(v.edits) : defaultEdits()); setNotes(v?.notes ?? ''); setLabel(v?.label ?? ''); setTime(0); setPlaying(false); setDuration(0); setEditedDuration(0);
  }
  function choose(m: Motion) {
    if ((editDirty || draftDirty) && !confirm('有尚未保存的修改，放弃后切换？')) return;
    setSelected(m.id); setDraft({ name: m.name, prompt: m.prompt, duration: m.duration, rewrite: m.rewrite, ready: m.ready }); loadVersion(m.versions.at(-1)); setError('');
  }
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); } }
  async function saveDraft() { if (!motion) throw new Error('请先添加动作'); return api<Motion>(`/${motion.id}`, 'PUT', draft); }
  async function create() {
    if ((editDirty || draftDirty) && !confirm('有尚未保存的修改，放弃后添加新动作？')) return;
    await run(async () => { const m = await api<Motion>('', 'POST', { ...emptyDraft, name: '新动作' }); await refresh(); setSelected(m.id); setDraft({ ...emptyDraft, name: m.name }); loadVersion(); setTrash(false); });
  }
  async function revise() {
    await run(async () => {
      const v = await api<Version>(`/${selected}/revisions/${vid}`, 'POST', { edits, notes, label: editDirty && label === version?.label ? `${label} · 调整` : label });
      await refresh(); setDraft(d => ({ ...d, ready: false })); loadVersion(v); setNotice('已另存为新版本，原版本保留');
    });
  }
  const filtered = library.motions.filter(m => !!m.deletedAt === trash && m.name.toLowerCase().includes(query.toLowerCase()));
  const ready = !!version?.asset && version.status === 'DONE';
  const url = ready ? `${API}/${selected}/asset/${vid}` : undefined;
  const adjust = (next: Partial<Edits>) => { setEdits(e => ({ ...e, ...next })); setTime(0); };
  const offsets = edits.offsets[bone] ?? [0, 0, 0];
  const safeName = (motion?.name ?? 'motion').replace(/[\\/:*?"<>|]/g, '_');
  return <div className="app">
    <header><div className="brand"><span className="logo">m.</span><div><strong>动作工作台</strong><small>HY-Motion 1.0 · 本地实验室</small></div></div><div className="header-right"><span className={`connection ${library.configured ? 'ok' : ''}`}>{library.configured ? '密钥已配置' : '未配置密钥'}</span><span className="local-label">独立保存 · 手动导出</span></div></header>
    <div className="workspace">
      <aside className="library"><div className="section-heading"><h2>{trash ? '回收站' : '动作库'} <span>{filtered.length}</span></h2><button className="icon-button" title="添加动作" onClick={create} disabled={busy}>＋</button></div>
        <input className="search" placeholder="搜索动作…" value={query} onChange={e => setQuery(e.target.value)} aria-label="搜索动作"/>
        <div className="motion-list">{filtered.map(m => <button className={`motion-card ${m.id === selected ? 'selected' : ''}`} key={m.id} onClick={() => choose(m)}><div><strong>{m.name}</strong><span className={`tag ${m.ready ? 'mature' : ''}`}>{m.ready ? '已成熟' : '草稿'}</span></div><p>{m.prompt || '从一句动作描述开始'}</p><small>{m.versions.length} 个版本 <span>· {m.duration}s</span></small></button>)}
          {!filtered.length && <div className="list-empty">{trash ? '回收站是空的' : '把动作想法留在这里'}<span>{trash ? '删除的动作可随时恢复' : '点击 ＋ 添加第一个动作'}</span></div>}
        </div><button className="trash-toggle" onClick={() => { if ((editDirty || draftDirty) && !confirm('放弃未保存修改并切换？')) return; setTrash(!trash); setSelected(''); loadVersion(); }}>{trash ? '← 返回动作库' : '回收站'} <span>{library.motions.filter(m => m.deletedAt).length || ''}</span></button>
      </aside>
      <main>
        <div className="preview-toolbar"><div><strong>{motion?.name ?? '动作预览'}</strong><span>{version ? ` / ${version.label}` : ' / 尚未选择版本'}</span></div><div className="preview-options"><select aria-label="预览角色" value={target} onChange={e => { setTarget(e.target.value); setTime(0); }}><option value="source">原始动作</option><option value={`${API}/model`}>示例 VRM 角色</option>{customModel && <option value={customModel}>自选 VRM 角色</option>}</select><button onClick={() => model.current?.click()}>载入角色</button><label><input type="checkbox" checked={skeleton} onChange={e => setSkeleton(e.target.checked)}/>骨架</label></div></div>
        <Preview url={motion?.deletedAt ? undefined : url} target={target} edits={edits} time={time} playing={playing} skeleton={skeleton} onTime={setTime} onDuration={(raw, edited) => { setDuration(raw); setEditedDuration(edited); }} handle={preview}/>
        <div className="transport"><button className="play-button" aria-label={playing ? '暂停' : '播放'} disabled={!ready} onClick={() => { if (time >= editedDuration) setTime(0); setPlaying(!playing); }}>{playing ? 'Ⅱ' : '▶'}</button><button disabled={!ready} title="回到开头" onClick={() => setTime(0)}>↶</button><input aria-label="播放进度" type="range" min="0" max={editedDuration || 1} step="0.01" value={Math.min(time, editedDuration)} disabled={!ready} onChange={e => { setPlaying(false); setTime(+e.target.value); }}/><span className="time">{time.toFixed(2)} / {editedDuration.toFixed(2)}s</span><label><input type="checkbox" checked={edits.loop} onChange={e => adjust({ loop: e.target.checked })}/>循环</label></div>
        <section className="versions"><div className="section-heading"><h2>版本记录</h2><span>{editDirty ? '有未保存的调整' : '每次生成与保存，都留下一个版本'}</span></div><div className="version-list">{motion?.versions.slice().reverse().map((v, i) => <button key={v.id} className={`version ${v.id === vid ? 'selected' : ''}`} onClick={() => { if (editDirty && !confirm('放弃未保存调整并切换版本？')) return; loadVersion(v); }}><div className="version-index">{String((motion?.versions.length ?? 0) - i).padStart(2, '0')}</div><div><strong>{v.label}</strong><small>{v.parentId ? '编辑调整' : v.source === 'imported' ? 'FBX 导入' : 'HY-Motion 生成'} · {new Date(v.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></div><span className={`version-status ${v.status === 'FAIL' ? 'failed' : ''}`}>{motion.readyVersionId === v.id && motion.ready ? '已成熟' : statusText[v.status]}</span></button>)}{!motion?.versions.length && <p className="empty-versions">生成或导入后，版本会出现在这里。</p>}</div></section>
      </main>
      <aside className="inspector">
        {!motion ? <div className="inspector-empty"><strong>从一个简单的动作开始</strong><p>写描述，生成候选；剪掉多余片段，调整姿态，再保存新版本。</p><button className="primary" onClick={create} disabled={busy}>＋ 添加动作</button><button className="text-button full" style={{ marginTop: 12 }} disabled={busy} onClick={() => run(async () => { const m = await api<Motion>('/demo', 'POST'); await refresh(); choose(m); setTrash(false); setNotice('已载入免费演示骨架，可直接试用编辑与导出'); })}>载入免费演示动作</button></div> : motion.deletedAt ? <div className="inspector-empty"><strong>{motion.name}</strong><p>动作及所有版本都保留在回收站中。</p><button className="primary" disabled={busy} onClick={() => run(async () => { await api(`/${selected}/restore`, 'POST'); await refresh(); setTrash(false); setSelected(''); loadVersion(); })}>恢复动作</button></div> : <>
          <section><div className="section-heading"><h2>动作描述</h2><button className="text-button" disabled={busy || !draftDirty} onClick={() => run(async () => { await saveDraft(); await refresh(); setNotice('动作描述已保存'); })}>{draftDirty ? '保存' : '已保存'}</button></div>
            <label className="field">名称<input value={draft.name} maxLength={80} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label>
            <label className="field">描述<textarea rows={4} placeholder="例如：站在原地，放松肩膀，右手轻轻挥手，然后自然垂下。" value={draft.prompt} onChange={e => setDraft({ ...draft, prompt: e.target.value })}/><small className={([...draft.prompt].length > 128 ? 'invalid' : '')}>{[...draft.prompt].length} / 128 字</small></label>
            <div className="inline-fields"><label>时长 <input type="number" min={1} max={12} step={1} value={draft.duration} onChange={e => setDraft({ ...draft, duration: +e.target.value })}/> 秒</label><label><input type="checkbox" checked={draft.rewrite} onChange={e => setDraft({ ...draft, rewrite: e.target.checked })}/>描述扩写</label></div>
            <button className="primary generate" disabled={busy || active || !library.configured || !draft.prompt.trim() || [...draft.prompt].length > 128} onClick={() => run(async () => { await saveDraft(); const v = await api<Version>(`/${selected}/generate`, 'POST'); await refresh(); setDraft(d => ({ ...d, ready: false })); loadVersion(v); setNotice('任务已提交，可继续浏览其他动作'); })}>{active ? '生成任务进行中…' : '生成新版本 ↗'}</button><p className="hint">点击生成会消耗腾讯云积分。修改描述后可再次生成。</p>
            <button className="secondary full" disabled={busy} onClick={() => file.current?.click()}>导入已有 FBX</button>
          </section>
          {version && <section><div className="section-heading"><h2>版本调整</h2><span>原文件保留</span></div>
            {version.status !== 'DONE' ? <div className={`job-info ${version.status === 'FAIL' ? 'invalid' : ''}`}><strong>{statusText[version.status]}</strong><p>{version.error || '任务会自动跟踪，刷新页面也不会重复提交。'}</p>{version.jobId && <small>任务：{version.jobId}</small>}{version.status === 'FAIL' && version.jobId && <button className="secondary full" disabled={busy || active} onClick={() => run(async () => { await api(`/${selected}/retry/${vid}`, 'POST'); await refresh(); })}>重新查询结果（不重新生成）</button>}</div> : <>
              <label className="field">版本名称<input value={label} maxLength={80} onChange={e => setLabel(e.target.value)}/></label>
              <div className="inline-fields trim"><label>开始 / s<input type="number" min={0} max={duration} step={.05} value={edits.start} onChange={e => adjust({ start: +e.target.value })}/></label><label>结束 / s<input type="number" min={0} max={duration} step={.05} placeholder={duration.toFixed(2)} value={edits.end || ''} onChange={e => adjust({ end: +e.target.value })}/></label></div><p className="hint">结束留空即原片结尾，原片 {duration.toFixed(2)} 秒。</p>
              <label className="slider-label">播放速度 <strong>{edits.speed.toFixed(2)}×</strong><input type="range" min={.1} max={3} step={.05} value={edits.speed} onChange={e => adjust({ speed: +e.target.value })}/></label>
              <div className="check-row"><label><input type="checkbox" checked={edits.inPlace} onChange={e => adjust({ inPlace: e.target.checked })}/>锁定水平位移</label><label><input type="checkbox" checked={edits.ground} onChange={e => adjust({ ground: e.target.checked })}/>校正地面</label></div>
              <details><summary>骨骼姿态微调 <span>°</span></summary><select aria-label="骨骼" className="bone-select" value={bone} onChange={e => setBone(e.target.value)}>{Object.entries({ L_Shoulder: '左上臂', R_Shoulder: '右上臂', L_Elbow: '左前臂', R_Elbow: '右前臂', L_Wrist: '左手腕', R_Wrist: '右手腕', Spine1: '腰部', Spine3: '胸部', Neck: '颈部', Head: '头部', L_Hip: '左大腿', R_Hip: '右大腿', L_Knee: '左小腿', R_Knee: '右小腿' }).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select>{['X', 'Y', 'Z'].map((axis, i) => <label className="axis" key={axis}>{axis}<input type="range" min={-90} max={90} step={1} value={offsets[i]} onChange={e => { const next = [...offsets] as [number, number, number]; next[i] = +e.target.value; adjust({ offsets: { ...edits.offsets, [bone]: next } }); }}/><span>{offsets[i]}°</span></label>)}<button className="text-button" onClick={() => { const next = { ...edits.offsets }; delete next[bone]; adjust({ offsets: next }); }}>重置此骨骼</button><p className="hint">原始骨骼使用局部轴；VRM 使用规范化骨骼轴。切换角色检查穿模。</p></details>
              <label className="field">迭代备注<textarea rows={2} maxLength={4000} placeholder="记录这版改了什么、还有哪里要调整…" value={notes} onChange={e => setNotes(e.target.value)}/></label>
              <button className="primary full" disabled={busy || !editDirty || !label.trim() || edits.start >= duration || (edits.end !== 0 && (edits.end <= edits.start || edits.end > duration))} onClick={revise}>保存为新版本</button>
              <button className="text-button full" disabled={!editDirty} onClick={() => loadVersion(version)}>还原当前版本</button>
              <details className="source-detail"><summary>生成描述与参数</summary><p>{version.prompt || '本地导入'}</p><small>{version.duration}s · {version.rewrite ? '开启扩写' : '关闭扩写'}{version.jobId ? ` · ${version.jobId}` : ''}</small></details>
            </>}
          </section>}
          {ready && <section><div className="section-heading"><h2>完成与导出</h2></div><label className="mature-toggle"><input type="checkbox" checked={!!motion.ready && motion.readyVersionId === vid} disabled={busy || editDirty} onChange={e => { const mature = e.target.checked; void run(async () => { await saveDraft(); await api(`/${selected}/mature/${vid}`, 'POST', { ready: mature }); await refresh(); setDraft(d => ({ ...d, ready: mature })); }); }}/>标记动作为成熟</label><div className="export-row"><button disabled={busy || editDirty || target !== 'source'} onClick={() => run(async () => { if (!preview.current) throw new Error('预览尚未加载'); const bytes = await preview.current.exportGlb(); download(bytes, 'model/gltf-binary', `${safeName}-${vid.slice(0, 8)}.glb`); setNotice('已导出烘焙后的 GLB，包含裁剪、速度与姿态调整'); })}>导出调整后的 GLB</button><button disabled={editDirty} onClick={() => download(JSON.stringify({ schema: 1, motion: { id: selected, name: motion.name }, version, sourceFile: `${version.id}.fbx`, coordinates: 'source-local', fps: 30, exportedAt: new Date().toISOString() }, null, 2), 'application/json', `${safeName}-${vid.slice(0, 8)}.json`)}>编辑记录 JSON</button></div><a className="file-link" href={url} download={`${version.id}.fbx`}>下载原始 FBX ↓</a><p className="hint">先保存调整，再导出 GLB 与编辑记录。GLB 从原始动作预览导出；导入正式项目由你决定。</p></section>}
          <button className="delete-button" disabled={busy} onClick={() => { if (confirm(`将「${motion.name}」及所有版本移到回收站？`)) void run(async () => { await api(`/${selected}`, 'DELETE'); await refresh(); setSelected(''); loadVersion(); setNotice('已移到回收站，可恢复'); }); }}>删除动作</button>
        </>}
      </aside>
    </div>
    {(error || notice) && <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}<button aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }}>×</button></div>}
    <input hidden type="file" accept=".fbx" ref={file} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(async () => { await saveDraft(); const v = await api<Version>(`/${selected}/import`, 'POST', f); await refresh(); setDraft(d => ({ ...d, ready: false })); loadVersion(v); setNotice('FBX 已导入'); }); }}/>
    <input hidden type="file" accept=".vrm" ref={model} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { const next = URL.createObjectURL(f); setCustomModel(next); setTarget(next); setTime(0); } }}/>
  </div>;
}

