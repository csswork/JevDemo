import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';
import { Store, InputError } from './store.ts';
import { submitMotion, describeMotion, type TencentCreds } from './tencent3d.ts';
import type { Version } from '../shared.ts';
import { expandPrompt } from './expandPrompt.ts';

async function body(req: IncomingMessage, limit = 1024 * 1024) {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new InputError('文件过大');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value));
};
export function workbenchApi(project: string): Plugin {
  return { name: 'motion-workbench-api', configureServer(server) {
    const store = new Store(path.join(project, 'data', 'motion-workbench'));
    const env = loadEnv('development', project, ['TENCENTCLOUD_', 'DEEPSEEK_']);
    const creds: TencentCreds = { secretId: env.TENCENTCLOUD_SECRET_ID ?? '', secretKey: env.TENCENTCLOUD_SECRET_KEY ?? '', region: env.TENCENTCLOUD_REGION };
    const configured = !!(creds.secretId && creds.secretKey);
    const aiConfigured = !!env.DEEPSEEK_API_KEY;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    // A submission interrupted before JobId was persisted must never be retried automatically (it may have been charged).
    for (const m of store.motions) for (const v of m.versions) if (v.status === 'submitting') {
      v.status = 'FAIL'; v.error = '提交被中断，未获得任务编号。请先在腾讯云核查任务；不会自动重新扣费。';
    }
    store.save();
    const active = () => store.motions.flatMap(m => m.versions).find(v => ['submitting', 'WAIT', 'RUN'].includes(v.status));
    async function poll() {
      if (stopped || busy) return;
      const v = active();
      if (!v?.jobId) return;
      busy = true;
      try {
        if (Date.now() - Date.parse(v.createdAt) > 23 * 3600 * 1000) throw new Error('任务已超过 23 小时，请在腾讯云核查结果');
        const result = await describeMotion(creds, v.jobId);
        if (result.status === 'FAIL') throw new Error(result.error ?? '云端生成失败');
        if (result.status === 'DONE') {
          const file = result.files.find(f => f.type.toUpperCase() === 'FBX');
          if (!file) throw new Error('生成完成但没有 FBX 文件');
          const r = await fetch(file.url, { signal: AbortSignal.timeout(120000) });
          if (!r.ok || !r.body) throw new Error(`下载失败 ${r.status}`);
          // Buffer with a bounded size before atomically persisting the source.
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0])) {
            size += chunk.length;
            if (size > 100 * 1024 * 1024) throw new Error('生成文件超过 100MB');
            chunks.push(chunk);
          }
          v.asset = `${v.id}.fbx`; fs.writeFileSync(store.assetPath(v.asset), Buffer.concat(chunks));
          v.status = 'DONE'; delete v.error;
        } else { v.status = result.status; delete v.error; }
        store.save();
      } catch (e) {
        // Keep JobId for manual recovery. Polling never submits a new job.
        v.status = 'FAIL'; v.error = e instanceof Error ? e.message : '任务出错'; store.save();
      } finally { busy = false; }
    }
    const tick = async () => { await poll(); if (!stopped) timer = setTimeout(tick, 5000); };
    void tick();
    server.httpServer?.once('close', () => { stopped = true; if (timer) clearTimeout(timer); });
    server.middlewares.use('/api/workbench', (req, res) => {
      void (async () => {
        const host = req.headers.host ?? '';
        if (!/^127\.0\.0\.1:5680$|^localhost:5680$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') { json(res, { error: '只允许本机工作台访问' }, 403); return; }
        res.setHeader('Cache-Control', 'no-store');
        const parts = new URL(req.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean);
        const [id, action, vid] = parts;
        if (!id && req.method === 'GET') { json(res, { motions: store.motions, configured, aiConfigured }); return; }
        if (id === 'expand' && req.method === 'POST') {
          json(res, await expandPrompt({ apiKey: env.DEEPSEEK_API_KEY ?? '', baseUrl: env.DEEPSEEK_BASE_URL, model: env.DEEPSEEK_MODEL }, JSON.parse((await body(req)).toString()))); return;
        }
        if (!id && req.method === 'POST') { json(res, store.create(JSON.parse((await body(req)).toString())), 201); return; }
        if (id === 'demo' && req.method === 'POST') {
          const bytes = fs.readFileSync(path.join(project, 'motion-workbench/fixtures/smoke.fbx'));
          const m = store.create({ name: '示例 · 挥手骨架', prompt: '站在原地，右前臂轻轻挥动。', duration: 4, rewrite: true, ready: false });
          const v = store.addVersion(m.id, 'imported'); v.asset = `${v.id}.fbx`; v.label = '自制演示骨架'; v.notes = '免费测试素材，用于熟悉裁剪、骨骼调整和版本迭代；没有调用生成服务。';
          fs.writeFileSync(store.assetPath(v.asset), bytes); store.save(); json(res, m, 201); return;
        }
        if (id === 'model' && req.method === 'GET') {
          const models: Record<string, string> = { mannequin: 'motion-workbench/models/mannequin.vrm', xiaxia: 'public/models/AvatarSample_A.vrm', sample: 'public/models/AvatarSample_B.vrm' };
          const file = models[action || 'sample']; if (!file) throw new InputError('预览模型不存在');
          res.setHeader('Content-Type', 'model/gltf-binary');
          fs.createReadStream(path.join(project, file)).on('error', () => res.destroy()).pipe(res); return;
        }
        if (req.method === 'DELETE' && !action) { store.trash(id); json(res, { ok: true }); return; }
        if (req.method === 'PUT' && !action) { json(res, store.update(id, JSON.parse((await body(req)).toString()))); return; }
        if (req.method === 'POST' && action === 'restore') { store.restore(id); json(res, { ok: true }); return; }
        if (req.method === 'POST' && action === 'mature') {
          const data = JSON.parse((await body(req)).toString()); json(res, store.mature(id, vid, data.ready)); return;
        }
        if (req.method === 'GET' && action === 'asset') {
          const v = store.version(id, vid); if (!v.asset) throw new InputError('暂无文件');
          res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', `attachment; filename="${v.id}.fbx"`);
          fs.createReadStream(store.assetPath(v.asset)).on('error', () => { res.destroy(); }).pipe(res); return;
        }
        if (req.method === 'POST' && action === 'revisions') {
          json(res, store.revise(id, vid, JSON.parse((await body(req)).toString())), 201); return;
        }
        if (req.method === 'POST' && action === 'import') {
          store.motion(id);
          const bytes = await body(req, 100 * 1024 * 1024);
          const header = bytes.subarray(0, 80).toString();
          if (!header.startsWith('Kaydara FBX Binary') && !header.includes('FBX')) throw new InputError('请选择 FBX 动作文件');
          const v = store.addVersion(id, 'imported'); v.asset = `${v.id}.fbx`;
          fs.writeFileSync(store.assetPath(v.asset), bytes); store.save(); json(res, v, 201); return;
        }
        if (req.method === 'POST' && action === 'retry') {
          const v = store.version(id, vid);
          if (!configured) throw new InputError('腾讯云密钥未配置');
          if (active()) throw new InputError('已有任务正在生成');
          if (!v.jobId || v.status !== 'FAIL') throw new InputError('此版本没有可恢复的任务');
          v.status = 'WAIT'; delete v.error; store.save(); json(res, v); void poll(); return;
        }
        if (req.method === 'POST' && action === 'generate') {
          if (!configured) throw new InputError('项目 .env.local 中未配置腾讯云密钥');
          if (active()) throw new InputError('已有任务正在生成，请等待结束');
          const m = store.motion(id); if (!m.prompt.trim()) throw new InputError('请先填写动作描述');
          const v = store.addVersion(id, 'generated'); json(res, v, 202);
          void (async (v: Version) => {
            try { v.jobId = await submitMotion(creds, { prompt: v.prompt, duration: v.duration, rewrite: v.rewrite, mesh: true }); v.status = 'WAIT'; }
            catch (e) { v.status = 'FAIL'; v.error = e instanceof Error ? e.message : '提交失败'; }
            store.save();
          })(v); return;
        }
        json(res, { error: '接口不存在' }, 404);
      })().catch(e => json(res, { error: e instanceof SyntaxError ? '请求格式错误' : e instanceof Error ? e.message : '请求失败' }, e instanceof InputError || e instanceof SyntaxError ? 400 : 500));
    });
  } };
}
