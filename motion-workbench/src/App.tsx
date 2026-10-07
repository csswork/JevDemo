import { useEffect, useRef, useState } from 'react';
import type { Edits, Library, Motion, Version, PromptExpansion, PromptRevision } from '../shared';
import { defaultEdits } from '../shared';
import { BONE_GROUPS, BONE_LABELS } from './boneEditing';
import { Preview, type PreviewHandle, type PreviewShots } from './Preview';
import { compareVersions } from './compareVersions';

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
const emptyDraft = { name: '', prompt: '', details: '', duration: 5, rewrite: true, ready: false };
export default function App() {
  const [library, setLibrary] = useState<Library>({ motions: [], configured: false });
  const [selected, setSelected] = useState(''); const [vid, setVid] = useState('');
  const [draft, setDraft] = useState(emptyDraft); const [edits, setEdits] = useState<Edits>(defaultEdits());
  const [notes, setNotes] = useState(''); const [label, setLabel] = useState('');
  const [query, setQuery] = useState(''); const [trash, setTrash] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [playing, setPlaying] = useState(false); const [time, setTime] = useState(0); const [duration, setDuration] = useState(0); const [editedDuration, setEditedDuration] = useState(0);
  const [target, setTarget] = useState(`${API}/model/mannequin`); const [bone, setBone] = useState('L_Shoulder');
  const [previewMode, setPreviewMode] = useState<'none' | 'skeleton' | 'rotate' | 'drag'>('none');
  const skeleton = previewMode === 'skeleton';
  const boneEditing = previewMode === 'rotate' || previewMode === 'drag';
  function choosePreviewMode(mode: typeof previewMode) {
    setPreviewMode(mode);
    if (mode === 'rotate' || mode === 'drag') { setBoneMode(mode); setPlaying(false); }
  }
  const [boneMode, setBoneMode] = useState<'rotate' | 'drag'>('rotate');
  const [availableBones, setAvailableBones] = useState<string[]>([]);
  const [previewState, setPreviewState] = useState<{ key: string; status: 'loading' | 'ready' | 'error' }>({ key: '', status: 'ready' });
  const [aiWorking, setAiWorking] = useState(false);
  const [aiBackup, setAiBackup] = useState<{ prompt: string; details: string } | null>(null);
  const [customModel, setCustomModel] = useState('');
  // Next round: review feedback → AI rewrites the description → user confirms → regenerate, carrying edits over.
  const [feedback, setFeedback] = useState(''); const [inherit, setInherit] = useState(true);
  const [plan, setPlan] = useState<PromptRevision | null>(null);
  const [attachShots, setAttachShots] = useState(true); const [shots, setShots] = useState<PreviewShots | null>(null);
  const seen = useRef(new Map<string, Version['status']>());
  const file = useRef<HTMLInputElement>(null); const model = useRef<HTMLInputElement>(null); const preview = useRef<PreviewHandle | null>(null);
  const motion = library.motions.find(m => m.id === selected);
  const version = motion?.versions.find(v => v.id === vid);
  const parent = version?.parentId ? motion?.versions.find(v => v.id === version.parentId) : undefined;
  const editDirty = !!version && (JSON.stringify(edits) !== JSON.stringify(version.edits) || notes !== version.notes || label !== version.label);
  const draftDirty = !!motion && (['name', 'prompt', 'duration', 'rewrite', 'ready'].some(k => draft[k as keyof typeof draft] !== motion[k as keyof Motion]) || draft.details !== (motion.details ?? ''));
  const active = library.motions.some(m => m.versions.some(v => ['submitting', 'WAIT', 'RUN'].includes(v.status)));
  async function refresh() { const data = await api<Library>(); setLibrary(data); return data; }
  useEffect(() => {
    // Announce finished generations and open them when the user isn't in the middle of something.
    for (const m of library.motions) for (const v of m.versions) {
      const before = seen.current.get(v.id); seen.current.set(v.id, v.status);
      if (!before || !['submitting', 'WAIT', 'RUN'].includes(before) || before === v.status) continue;
      if (v.status === 'DONE') {
        setNotice(`「${m.name}」${v.label} 已生成${m.id === selected ? '，已打开供审阅' : ''}`);
        if (m.id === selected && v.id !== vid && !editDirty && !plan) loadVersion(v);
      } else if (v.status === 'FAIL') setError(`「${m.name}」${v.label} 生成失败：${v.error ?? '未知原因'}`);
    }
  }, [library]); // eslint-disable-line react-hooks/exhaustive-deps
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
    setPreviewMode(mode => mode === 'skeleton' ? mode : 'none'); setVid(v?.id ?? ''); setFeedback(''); setPlan(null); setShots(null); setEdits(v ? structuredClone(v.edits) : defaultEdits()); setNotes(v?.notes ?? ''); setLabel(v?.label ?? ''); setTime(0); setPlaying(false); if (v?.id !== vid) { setDuration(0); setEditedDuration(0); }
  }
  function choose(m: Motion) {
    if ((editDirty || draftDirty) && !confirm('有尚未保存的修改，放弃后切换？')) return;
    setSelected(m.id); setAiBackup(null); setDraft({ name: m.name, prompt: m.prompt, details: m.details ?? '', duration: m.duration, rewrite: m.rewrite, ready: m.ready }); loadVersion(m.versions.at(-1)); setError('');
  }
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); } }
  async function saveDraft() { if (!motion) throw new Error('请先添加动作'); return api<Motion>(`/${motion.id}`, 'PUT', draft); }
  async function create() {
    if ((editDirty || draftDirty) && !confirm('有尚未保存的修改，放弃后添加新动作？')) return;
    await run(async () => { const m = await api<Motion>('', 'POST', { ...emptyDraft, name: '新动作' }); await refresh(); setSelected(m.id); setDraft({ ...emptyDraft, name: m.name }); setAiBackup(null); loadVersion(); setTrash(false); });
  }
  async function revise() {
    await run(async () => {
      const v = await api<Version>(`/${selected}/revisions/${vid}`, 'POST', { edits, notes, label: editDirty && label === version?.label ? `${label} · 调整` : label });
      await refresh(); setDraft(d => ({ ...d, ready: false })); loadVersion(v); setNotice('已另存为新版本，原版本保留');
    });
  }
  async function planIteration() {
    await run(async () => {
      // Screenshots show the edits currently on screen, from the camera angle the user is reviewing with.
      const captured = attachShots && previewReady && preview.current ? preview.current.capture() : null;
      setShots(captured);
      const result = await api<PromptRevision>(`/${selected}/iterate/${vid}`, 'POST', { feedback, duration: draft.duration, images: captured ? [captured.current, captured.sheet] : undefined });
      setPlan({ ...result, details: `${result.details}\n\n关键姿态\n${result.keyframes.map(f => `${f.time.toFixed(2)}s · ${f.pose}`).join('\n')}` });
    });
  }
  async function confirmIteration() {
    if (!plan || !version) return;
    if (editDirty && !inherit && !confirm('当前版本有未保存的调整，且没有勾选沿用，提交后这些调整会丢弃。继续？')) return;
    await run(async () => {
      const next = { ...draft, prompt: plan.prompt, details: plan.details, ready: false };
      await api<Motion>(`/${selected}`, 'PUT', next);
      const v = await api<Version>(`/${selected}/generate`, 'POST', { parentId: version.id, feedback, edits: inherit ? edits : undefined });
      await refresh(); setDraft(next); setAiBackup(null); loadVersion(v);
      setNotice(`已提交 ${v.label}，生成完成后会自动打开`);
    });
  }
  const filtered = library.motions.filter(m => !!m.deletedAt === trash && m.name.toLowerCase().includes(query.toLowerCase()));
  const ready = !!version?.asset && version.status === 'DONE';
  const url = ready ? `${API}/${selected}/asset/${vid}` : undefined;
  const previewUrl = motion?.deletedAt ? undefined : url;
  const previewKey = JSON.stringify([previewUrl, target]);
  const previewLoading = !!previewUrl && (previewState.key !== previewKey || previewState.status === 'loading');
  const previewReady = !!previewUrl && previewState.key === previewKey && previewState.status === 'ready';
  const adjust = (next: Partial<Edits>) => { setEdits(e => ({ ...e, ...next })); setTime(0); };
  const positions = edits.positions?.[bone] ?? [0, 0, 0];
  const offsets = edits.offsets[bone] ?? [0, 0, 0];
  const safeName = (motion?.name ?? 'motion').replace(/[\\/:*?"<>|]/g, '_');
  return <div className="app">
    <header><div className="brand"><span className="logo">m.</span><div><strong>动作工作台</strong><small>HY-Motion 1.0 · 本地实验室</small></div></div><div className="header-right"><span className={`connection ${library.configured ? 'ok' : ''}`}>{library.configured ? '密钥已配置' : '未配置密钥'}</span><span className="local-label">独立保存 · 手动导出</span></div></header>
    <div className="sr-only" role="status" aria-live="polite">{previewLoading ? 'Loading，正在加载模型与动作，操作暂时不可用' : ''}</div>
    <fieldset className="workspace" disabled={previewLoading} inert={previewLoading} aria-busy={previewLoading}>
      <aside className="library"><div className="section-heading"><h2>{trash ? '回收站' : '动作库'} <span>{filtered.length}</span></h2><button className="icon-button" title="添加动作" onClick={create} disabled={busy}>＋</button></div>
        <input className="search" placeholder="搜索动作…" value={query} onChange={e => setQuery(e.target.value)} aria-label="搜索动作"/>
        <div className="motion-list">{filtered.map(m => <button className={`motion-card ${m.id === selected ? 'selected' : ''}`} key={m.id} disabled={busy} onClick={() => choose(m)}><div><strong>{m.name}</strong><span className={`tag ${m.ready ? 'mature' : ''}`}>{m.ready ? '已成熟' : '草稿'}</span></div><p>{m.prompt || '从一句动作描述开始'}</p><small>{m.versions.length} 个版本 <span>· {m.duration}s</span></small></button>)}
          {!filtered.length && <div className="list-empty">{trash ? '回收站是空的' : '把动作想法留在这里'}<span>{trash ? '删除的动作可随时恢复' : '点击 ＋ 添加第一个动作'}</span></div>}
        </div><button className="trash-toggle" disabled={busy} onClick={() => { if ((editDirty || draftDirty) && !confirm('放弃未保存修改并切换？')) return; setTrash(!trash); setSelected(''); loadVersion(); }}>{trash ? '← 返回动作库' : '回收站'} <span>{library.motions.filter(m => m.deletedAt).length || ''}</span></button>
      </aside>
      <main>
        <div className="preview-toolbar"><div><strong>{motion?.name ?? '动作预览'}</strong><span>{version ? ` / ${version.label}` : ' / 尚未选择版本'}</span></div><div className="preview-options"><select aria-label="预览角色" value={target} onChange={e => setTarget(e.target.value)}><option value={`${API}/model/mannequin`}>素体 · VRoid 女性</option><option value={`${API}/model/xiaxia`}>夏夏 · 项目角色</option><option value="source">原始动作</option><option value={`${API}/model/sample`}>示例 VRM 角色</option>{customModel && <option value={customModel}>自选 VRM 角色</option>}</select><button onClick={() => model.current?.click()}>载入角色</button>{([['skeleton', '显示骨架'], ['rotate', '圆环微调'], ['drag', '拖动微调']] as const).map(([mode, text]) => <label key={mode}><input type="checkbox" checked={previewMode === mode} disabled={!previewReady} onChange={e => choosePreviewMode(e.target.checked ? mode : 'none')}/>{text}</label>)}</div></div>
        <Preview url={previewUrl} target={target} edits={edits} time={time} playing={playing} skeleton={skeleton} boneEditing={boneEditing} bone={bone} boneMode={boneMode} onBones={setAvailableBones} onSelectBone={id => { setBone(id); setPlaying(false); }} onBoneEdits={patch => { setPlaying(false); setEdits(e => ({ ...e, offsets: { ...e.offsets, ...patch.offsets }, ...(patch.positions ? { positions: { ...e.positions, ...patch.positions } } : {}) })); }} onTime={setTime} onLoadState={status => { setPreviewState({ key: previewKey, status }); if (status === 'loading') setPlaying(false); }} onDuration={(raw, edited) => { setDuration(raw); setEditedDuration(edited); }} handle={preview}/>
        <div className="transport"><button className="play-button" aria-label={playing ? '暂停' : '播放'} disabled={!previewReady || boneEditing} onClick={() => { if (time >= editedDuration) setTime(0); setPlaying(!playing); }}>{playing ? 'Ⅱ' : '▶'}</button><button disabled={!previewReady} title="回到开头" onClick={() => setTime(0)}>↶</button><input aria-label="播放进度" type="range" min="0" max={editedDuration || 1} step="0.01" value={Math.min(time, editedDuration)} disabled={!previewReady} onChange={e => { setPlaying(false); setTime(+e.target.value); }}/><span className="time">{time.toFixed(2)} / {editedDuration.toFixed(2)}s</span><label><input type="checkbox" checked={edits.loop} onChange={e => adjust({ loop: e.target.checked })}/>循环</label></div>
        <section className="versions"><div className="section-heading"><h2>版本记录</h2><span>{editDirty ? '有未保存的调整' : '每次生成与保存，都留下一个版本'}</span></div><div className="version-list">{motion?.versions.slice().reverse().map((v, i) => <button key={v.id} disabled={busy} className={`version ${v.id === vid ? 'selected' : ''}`} onClick={() => { if (editDirty && !confirm('放弃未保存调整并切换版本？')) return; loadVersion(v); }}><div className="version-index">{String((motion?.versions.length ?? 0) - i).padStart(2, '0')}</div><div><strong>{v.label}</strong><small title={v.feedback}>{v.feedback ? `迭代生成 ← ${motion.versions.find(p => p.id === v.parentId)?.label ?? '已删除版本'}` : v.parentId ? '编辑调整' : v.source === 'imported' ? 'FBX 导入' : 'HY-Motion 生成'} · {new Date(v.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></div><span className={`version-status ${v.status === 'FAIL' ? 'failed' : ''}`}>{motion.readyVersionId === v.id && motion.ready ? '已成熟' : statusText[v.status]}</span></button>)}{!motion?.versions.length && <p className="empty-versions">生成或导入后，版本会出现在这里。</p>}</div></section>
      </main>
      <aside className="inspector">
        {!motion ? <div className="inspector-empty"><strong>从一个简单的动作开始</strong><p>写描述，生成候选；剪掉多余片段，调整姿态，再保存新版本。</p><button className="primary" onClick={create} disabled={busy}>＋ 添加动作</button><button className="text-button full" style={{ marginTop: 12 }} disabled={busy} onClick={() => run(async () => { const m = await api<Motion>('/demo', 'POST'); await refresh(); choose(m); setTrash(false); setNotice('已载入免费演示骨架，可直接试用编辑与导出'); })}>载入免费演示动作</button></div> : motion.deletedAt ? <div className="inspector-empty"><strong>{motion.name}</strong><p>动作及所有版本都保留在回收站中。</p><button className="primary" disabled={busy} onClick={() => run(async () => { await api(`/${selected}/restore`, 'POST'); await refresh(); setTrash(false); setSelected(''); loadVersion(); })}>恢复动作</button></div> : <>
          <section><div className="section-heading"><h2>动作描述</h2><button className="text-button" disabled={busy || !draftDirty} onClick={() => run(async () => { await saveDraft(); await refresh(); setNotice('动作描述已保存'); })}>{draftDirty ? '保存' : '已保存'}</button></div>
            <label className="field">名称<input value={draft.name} maxLength={80} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label>
            <div className="description-heading"><label htmlFor="motion-prompt">描述</label><button className="ai-button" title="使用 DeepSeek 补充动作细节与关键姿态，会产生 API 用量" disabled={busy || !library.aiConfigured || !draft.prompt.trim() || [...draft.prompt].length > 128} onClick={() => { setAiWorking(true); void run(async () => {
              const result = await api<PromptExpansion>('/expand', 'POST', { prompt: draft.prompt, duration: draft.duration, details: draft.details });
              setAiBackup({ prompt: draft.prompt, details: draft.details });
              const details = `${result.details}\n\n关键姿态\n${result.keyframes.map(f => `${f.time.toFixed(2)}s · ${f.pose}`).join('\n')}`;
              setDraft(d => ({ ...d, prompt: result.prompt, details }));
              setNotice('AI 已补充描述与关键姿态，可编辑、撤销或保存；尚未生成动作');
            }).finally(() => setAiWorking(false)); }}>{aiWorking ? '补充中…' : '✦ AI 补充'}</button></div>
            <label className="field"><textarea id="motion-prompt" aria-label="描述" rows={4} disabled={busy} placeholder="例如：站在原地，放松肩膀，右手轻轻挥手，然后自然垂下。" value={draft.prompt} onChange={e => setDraft({ ...draft, prompt: e.target.value })}/><small className={([...draft.prompt].length > 128 ? 'invalid' : '')}>{[...draft.prompt].length} / 128 字</small></label>
            {aiBackup && <button className="text-button" disabled={busy} onClick={() => { setDraft(d => ({ ...d, ...aiBackup })); setAiBackup(null); }}>撤销 AI 补充</button>}
            <details className="motion-details" open={!!draft.details}><summary>动作细节与关键姿态</summary><textarea aria-label="动作细节与关键姿态" rows={8} maxLength={8000} disabled={busy} value={draft.details} onChange={e => setDraft({ ...draft, details: e.target.value })} placeholder="记录准备、发力、最高姿态、缓动与收势…"/><p className="hint">生成描述限 128 字。这里保留完整时间节点与姿态细节供迭代参考，生成器接收上方精简描述。</p></details>
            <div className="inline-fields"><label>时长 <input type="number" min={1} max={12} step={1} disabled={busy} value={draft.duration} onChange={e => setDraft({ ...draft, duration: +e.target.value })}/> 秒</label><label><input type="checkbox" checked={draft.rewrite} onChange={e => setDraft({ ...draft, rewrite: e.target.checked })}/>描述扩写</label></div>
            <button className="primary generate" disabled={busy || active || !library.configured || !draft.prompt.trim() || [...draft.prompt].length > 128} onClick={() => run(async () => { await saveDraft(); const v = await api<Version>(`/${selected}/generate`, 'POST'); await refresh(); setDraft(d => ({ ...d, ready: false })); loadVersion(v); setNotice('任务已提交，可继续浏览其他动作'); })}>{active ? '生成任务进行中…' : '生成新版本 ↗'}</button><p className="hint">点击生成会消耗腾讯云积分。修改描述后可再次生成。</p>
            <button className="secondary full" disabled={busy} onClick={() => file.current?.click()}>导入已有 FBX</button>
          </section>
          {version && <section><div className="section-heading"><h2>版本调整</h2><span>原文件保留</span></div>
            {version.status !== 'DONE' ? <div className={`job-info ${version.status === 'FAIL' ? 'invalid' : ''}`}><strong>{statusText[version.status]}</strong><p>{version.error || '任务会自动跟踪，刷新页面也不会重复提交。'}</p>{version.jobId && <small>任务：{version.jobId}</small>}{version.status === 'FAIL' && version.jobId && <button className="secondary full" disabled={busy || active} onClick={() => run(async () => { await api(`/${selected}/retry/${vid}`, 'POST'); await refresh(); })}>重新查询结果（不重新生成）</button>}</div> : <>
              <label className="field">版本名称<input value={label} maxLength={80} onChange={e => setLabel(e.target.value)}/></label>
              <div className="inline-fields trim"><label>开始 / s<input type="number" min={0} max={duration} step={.05} value={edits.start} onChange={e => adjust({ start: +e.target.value })}/></label><label>结束 / s<input type="number" min={0} max={duration} step={.05} placeholder={duration.toFixed(2)} value={edits.end || ''} onChange={e => adjust({ end: +e.target.value })}/></label></div><p className="hint">结束留空即原片结尾，原片 {duration.toFixed(2)} 秒。</p>
              <label className="slider-label">播放速度 <strong>{edits.speed.toFixed(2)}×</strong><input type="range" min={.1} max={3} step={.05} value={edits.speed} onChange={e => adjust({ speed: +e.target.value })}/></label>
              <div className="check-row"><label><input type="checkbox" checked={edits.inPlace} onChange={e => adjust({ inPlace: e.target.checked })}/>锁定水平位移</label><label><input type="checkbox" checked={edits.ground} onChange={e => adjust({ ground: e.target.checked })}/>校正地面</label></div>
              <details open={boneEditing}><summary>骨骼姿态微调 <span>° / cm</span></summary>

                <select aria-label="骨骼" className="bone-select" value={bone} onChange={e => { setBone(e.target.value); setPlaying(false); }}>{Object.entries(BONE_GROUPS).map(([group, bones]) => <optgroup key={group} label={group}>{Object.entries(bones).map(([id, text]) => <option key={id} value={id} disabled={!availableBones.includes(id)}>{text}{availableBones.includes(id) ? '' : '（无此骨骼）'}</option>)}</optgroup>)}</select>
                <p className="hint">旋转偏移 · °{boneMode === 'drag' ? ' · 拖动会同时写入上游骨骼' : ''}</p>
                {['X', 'Y', 'Z'].map((axis, i) => <AxisInput key={axis} label={`${BONE_LABELS[bone]} ${axis} 旋转`} axis={axis} limit={180} value={offsets[i]} disabled={!availableBones.includes(bone)} onChange={value => { const next = [...offsets] as [number, number, number]; next[i] = value; setPlaying(false); setEdits(v => ({ ...v, offsets: { ...v.offsets, [bone]: next } })); }}/>)}
                {(bone === 'Pelvis' || edits.positions?.[bone]) && <>
                  <p className="hint">{bone === 'Pelvis' ? '重心位置 · cm' : '位置偏移 · cm（旧版本数据，会改变骨长）'}</p>
                  {['X', 'Y', 'Z'].map((axis, i) => <AxisInput key={axis} label={`${BONE_LABELS[bone]} ${axis} 位置`} axis={axis} limit={200} value={positions[i] * 100} disabled={!availableBones.includes(bone)} onChange={value => { const next = [...positions] as [number, number, number]; next[i] = value / 100; setPlaying(false); setEdits(v => ({ ...v, positions: { ...v.positions, [bone]: next } })); }}/>)}
                </>}
                <div className="bone-actions"><button className="text-button" onClick={() => { const next = { ...edits.offsets }; delete next[bone]; const pos = { ...edits.positions }; delete pos[bone]; setEdits(e => ({ ...e, offsets: next, positions: Object.keys(pos).length ? pos : undefined })); }}>重置此骨骼</button><button className="text-button" disabled={!Object.keys(edits.offsets).length && !edits.positions} onClick={() => setEdits(e => ({ ...e, offsets: {}, positions: undefined }))}>清除全部骨骼微调</button></div><p className="hint">圆环微调：点击关节，拖动圆环旋转单根骨骼。拖动微调：按住关节点拖到目标位置，上游骨骼链一起弯曲、骨长不变——拖手腕/脚踝时手臂/腿按原弯曲方向折叠，手掌、脚掌朝向保持；拖骨盆或胯时整个身体移动，双脚留在原地（可做下蹲；锁定水平位移时只有上下有效果）。调整作用于整段动作，保存为新版本保留。</p>
              </details>
              <label className="field">迭代备注<textarea rows={2} maxLength={4000} placeholder="记录这版改了什么、还有哪里要调整…" value={notes} onChange={e => setNotes(e.target.value)}/></label>
              <button className="primary full" disabled={busy || !editDirty || !label.trim() || edits.start >= duration || (edits.end !== 0 && (edits.end <= edits.start || edits.end > duration))} onClick={revise}>保存为新版本</button>
              <button className="text-button full" disabled={!editDirty} onClick={() => loadVersion(version)}>还原当前版本</button>
              <details className="source-detail"><summary>生成描述与参数</summary>{version.feedback && <p className="saved-details">本轮反馈：{version.feedback}</p>}<p>{version.prompt || '本地导入'}</p>{version.details && <p className="saved-details">{version.details}</p>}<small>{version.duration}s · {version.rewrite ? '开启扩写' : '关闭扩写'}{version.jobId ? ` · ${version.jobId}` : ''}</small></details>
            </>}
          </section>}
          {version && parent && (() => {
            const c = compareVersions(parent, version, version.status === 'DONE' ? edits : version.edits);
            const changed = c.rows.filter(r => r.changed); const same = c.rows.filter(r => !r.changed);
            return <section className="compare"><div className="section-heading"><h2>与上一版对比</h2><span>{parent.label} → {editDirty ? '当前（未保存）' : version.label}</span></div>
              {c.feedback && <div className="compare-block"><small>本轮反馈</small><p>{c.feedback}</p></div>}
              <div className="compare-block"><small>生成描述{c.prompt ? '' : ' · 未改变'}{c.detailsChanged ? ' · 动作细节也有修改' : ''}</small>
                {c.prompt ? <p className="prompt-diff">{c.prompt.map((seg, i) => seg.type === 'same' ? <span key={i}>{seg.text}</span> : seg.type === 'add' ? <ins key={i}>{seg.text}</ins> : <del key={i}>{seg.text}</del>)}</p> : <p className="muted">{version.prompt || '（本地导入）'}</p>}
              </div>
              <table className="compare-table"><tbody>
                {changed.map(r => <tr key={r.label} className="changed"><th>{r.label}</th><td>{r.before}</td><td>→ {r.after}</td></tr>)}
                {!changed.length && <tr><td className="muted" colSpan={3}>时长、裁剪、速度等参数都相同</td></tr>}
              </tbody></table>
              {!!same.length && !!changed.length && <p className="hint">相同：{same.map(r => `${r.label} ${r.after}`).join(' · ')}</p>}
              <div className="compare-block"><small>骨骼微调{c.bones.length ? ` · ${c.bones.length} 处变化` : ' · 没有变化'}</small>
                {c.bones.map(b => <button key={b.bone} className="bone-change" onClick={() => { setBone(b.bone); setPlaying(false); }} title="选中这根骨骼"><span className={`bone-kind ${b.kind === '移除' ? 'removed' : ''}`}>{b.kind}</span><strong>{b.label}</strong><span>{b.detail}</span></button>)}
              </div>
            </section>;
          })()}
          {ready && <section className="iterate"><div className="section-heading"><h2>下一轮迭代</h2><span>基于 {version.label}</span></div>
            {!plan ? <>
              <label className="field">这一版哪里需要改<textarea rows={3} maxLength={2000} disabled={busy} placeholder="例如：挥手太快，手只抬到胸口；希望抬过头顶，挥三下后慢慢放下。" value={feedback} onChange={e => setFeedback(e.target.value)}/></label>
              <label className="inherit"><input type="checkbox" checked={inherit} onChange={e => setInherit(e.target.checked)}/>新版本沿用当前的裁剪、速度和骨骼微调</label>
              <label className="inherit"><input type="checkbox" checked={attachShots} disabled={!previewReady} onChange={e => setAttachShots(e.target.checked)}/>附带截图给 AI：当前帧 + 整段 8 帧（按当前镜头角度）</label>
              <button className="primary full" disabled={busy || !feedback.trim() || !library.aiConfigured || !version.prompt} onClick={planIteration}>{busy ? '处理中…' : '✦ AI 按反馈改写描述'}</button>
              <button className="text-button full" disabled={busy || !feedback.trim()} onClick={() => setPlan({ prompt: version.prompt, details: version.details ?? '', keyframes: [], changes: '手动改写：在上一版描述上直接修改。' })}>不用 AI，手动改写描述</button>
              <p className="hint">{!library.aiConfigured ? '未配置 DEEPSEEK_API_KEY，可手动改写。' : !version.prompt ? '导入的版本没有生成描述，请手动改写。' : `AI 只改反馈涉及的部分，并参考之前几轮的反馈。${attachShots && previewReady ? '先把镜头转到能看清问题的角度、停在出问题的那一帧，截图更有用。' : ''}改写完成后会先给你确认，不会自动扣积分。`}</p>
            </> : <div className="plan">
              <p className="plan-changes">{plan.changes}</p>
              {shots && <details className="plan-shots"><summary>AI 看到的截图</summary><img src={shots.current} alt="当前帧截图"/><img src={shots.sheet} alt="整段动作 8 帧截图"/></details>}
              <small>上一版描述</small><p className="plan-old">{version.prompt || '（无）'}</p>
              <label className="field">新描述 · 可修改<textarea rows={4} disabled={busy} value={plan.prompt} onChange={e => setPlan({ ...plan, prompt: e.target.value })}/><small className={[...plan.prompt].length > 128 ? 'invalid' : ''}>{[...plan.prompt].length} / 128 字 · {draft.duration} 秒</small></label>
              <details className="motion-details"><summary>动作细节与关键姿态</summary><textarea rows={8} maxLength={8000} disabled={busy} value={plan.details} onChange={e => setPlan({ ...plan, details: e.target.value })}/></details>
              <button className="primary full" disabled={busy || active || !library.configured || !plan.prompt.trim() || [...plan.prompt].length > 128} onClick={confirmIteration}>{active ? '生成任务进行中…' : '确认生成下一版 ↗（消耗积分）'}</button>
              <button className="text-button full" disabled={busy} onClick={() => setPlan(null)}>返回修改反馈</button>
            </div>}
          </section>}
          {ready && <section><div className="section-heading"><h2>完成与导出</h2></div><label className="mature-toggle"><input type="checkbox" checked={!!motion.ready && motion.readyVersionId === vid} disabled={busy || editDirty} onChange={e => { const mature = e.target.checked; void run(async () => { await saveDraft(); await api(`/${selected}/mature/${vid}`, 'POST', { ready: mature }); await refresh(); setDraft(d => ({ ...d, ready: mature })); }); }}/>标记动作为成熟</label><div className="export-row"><button disabled={busy || !previewReady} onClick={() => run(async () => { if (!preview.current) throw new Error('预览尚未加载'); const bytes = await preview.current.exportGlb(); download(bytes, 'model/gltf-binary', `${safeName}-${vid.slice(0, 8)}.glb`); setNotice('已导出当前调整的动作骨架 GLB，包含裁剪、速度、手指与位置调整'); })}>导出调整后的 GLB</button><button disabled={editDirty} onClick={() => download(JSON.stringify({ schema: 1, motion: { id: selected, name: motion.name }, version, sourceFile: `${version.id}.fbx`, coordinates: 'source-local', fps: 30, exportedAt: new Date().toISOString() }, null, 2), 'application/json', `${safeName}-${vid.slice(0, 8)}.json`)}>编辑记录 JSON</button></div><a className="file-link" href={url} download={`${version.id}.fbx`}>下载原始 FBX ↓</a><p className="hint">GLB 导出当前调整后的动作骨架，可在任意角色预览下导出，不包含预览人物。保存为新版本后可导出对应编辑记录。</p></section>}
          <button className="delete-button" disabled={busy} onClick={() => { if (confirm(`将「${motion.name}」及所有版本移到回收站？`)) void run(async () => { await api(`/${selected}`, 'DELETE'); await refresh(); setSelected(''); loadVersion(); setNotice('已移到回收站，可恢复'); }); }}>删除动作</button>
        </>}
      </aside>
    </fieldset>
    {(error || notice) && <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}<button aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }}>×</button></div>}
    <input hidden type="file" accept=".fbx" ref={file} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(async () => { await saveDraft(); const v = await api<Version>(`/${selected}/import`, 'POST', f); await refresh(); setDraft(d => ({ ...d, ready: false })); loadVersion(v); setNotice('FBX 已导入'); }); }}/>
    <input hidden type="file" accept=".vrm" ref={model} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { const next = URL.createObjectURL(f); setCustomModel(next); setTarget(next); } }}/>
  </div>;
}

function AxisInput({ label, axis, limit, value, disabled, onChange }: { label: string; axis: string; limit: number; value: number; disabled: boolean; onChange: (value: number) => void }) {
  return <label className="axis">{axis}<input aria-label={label} type="range" min={-limit} max={limit} step={.1} disabled={disabled} value={value} onChange={e => onChange(+e.target.value)}/><input className="axis-number" aria-label={`${label}数值`} type="number" min={-limit} max={limit} step={.1} value={+value.toFixed(1)} disabled={disabled} onChange={e => onChange(Math.max(-limit, Math.min(limit, +e.target.value)))}/></label>;
}
