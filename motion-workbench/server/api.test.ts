import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import { workbenchApi } from './api.ts';
import type { Motion, Version } from '../shared.ts';

test('API isolates local access, serializes jobs, downloads results, and resumes persisted JobId without another submission', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-api-'));
  fs.writeFileSync(path.join(dir, '.env.local'), 'TENCENTCLOUD_SECRET_ID=test-id\nTENCENTCLOUD_SECRET_KEY=test-key\n');
  const originalFetch = globalThis.fetch; let submits = 0; let fail = false;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('ai3d.tencentcloudapi.com')) {
      const headers = init?.headers as Record<string, string>;
      assert.match(headers.Authorization, /^TC3-HMAC-SHA256 /);
      if (headers['X-TC-Action'] === 'SubmitHunyuanTo3DMotionJob') {
        submits++; const payload = JSON.parse(init!.body as string);
        assert.equal(payload.Model, 'HY-Motion-1.0'); assert.equal(payload.EnableMesh, true);
        return Response.json({ Response: { JobId: 'mock-job' } });
      }
      return Response.json({ Response: fail ? { Status: 'FAIL', ErrorCode: 'MockFailure', ErrorMessage: '模拟错误' } : { Status: 'DONE', ResultFile3Ds: [{ Type: 'FBX', Url: 'https://test.invalid/result.fbx' }] } });
    }
    assert.equal(String(input), 'https://test.invalid/result.fbx');
    return new Response('; FBX test source');
  };
  const servers: EventEmitter[] = [];
  function start() {
    let handler!: (req: IncomingMessage, res: ServerResponse) => void;
    const httpServer = new EventEmitter(); servers.push(httpServer);
    const plugin = workbenchApi(dir);
    (plugin.configureServer as (server: ViteDevServer) => void)({ middlewares: { use: (_route: string, fn: typeof handler) => { handler = fn; } }, httpServer } as unknown as ViteDevServer);
    async function request(url: string, method = 'GET', data?: unknown, origin?: string) {
      const request = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]) as IncomingMessage;
      Object.assign(request, { method, url, headers: { host: '127.0.0.1:5680', origin } });
      const chunks: Buffer[] = [];
      const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }) as ServerResponse;
      response.statusCode = 200; response.setHeader = () => response;
      const completed = new Promise<void>(resolve => response.once('finish', resolve));
      handler(request, response); await completed;
      return { status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) };
    }
    return { request, close: () => httpServer.emit('close') };
  }
  try {
    const server = start();
    assert.equal((await server.request('/', 'GET', undefined, 'https://evil.invalid')).status, 403);
    const m = (await server.request('/', 'POST', { name: '测试', prompt: '挥手', duration: 4, rewrite: true, ready: false })).value as Motion;
    const result = await server.request(`/${m.id}/generate`, 'POST'); assert.equal(result.status, 202);
    const version = result.value as Version;
    await new Promise(r => setTimeout(r, 10));
    assert.equal((await server.request(`/${m.id}/generate`, 'POST')).status, 400);
    assert.equal((await server.request(`/${m.id}`, 'DELETE')).status, 400);
    server.close();
    const resumed = start(); await new Promise(r => setTimeout(r, 20));
    const library = (await resumed.request('/')).value;
    const done = library.motions[0].versions[0] as Version;
    assert.equal(done.status, 'DONE'); assert.equal(done.jobId, 'mock-job'); assert.equal(submits, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'data/motion-workbench/assets', done.asset!), 'utf8'), '; FBX test source');
    const revised = await resumed.request(`/${m.id}/revisions/${version.id}`, 'POST', { label: '调整', notes: '微调', edits: { ...done.edits, speed: .5 } });
    assert.equal(revised.status, 201); assert.equal(revised.value.asset, done.asset);
    fail = true;
    const next = await resumed.request(`/${m.id}/generate`, 'POST'); await new Promise(r => setTimeout(r, 10)); resumed.close();
    const failing = start(); await new Promise(r => setTimeout(r, 20));
    const failure = (await failing.request('/')).value.motions[0].versions.at(-1) as Version;
    assert.equal(failure.status, 'FAIL'); assert.match(failure.error!, /模拟错误/);
    fail = false;
    assert.equal((await failing.request(`/${m.id}/retry/${next.value.id}`, 'POST')).status, 200);
    await new Promise(r => setTimeout(r, 20));
    assert.equal((await failing.request('/')).value.motions[0].versions.at(-1).status, 'DONE');
    assert.equal(submits, 2);
    assert.equal((await failing.request(`/${m.id}`, 'DELETE')).status, 200);
    assert.equal((await failing.request(`/${m.id}/restore`, 'POST')).status, 200);
    const missing = await failing.request(`/${m.id}/asset/not-a-version`); assert.equal(missing.status, 400);
    // Iterating from a reviewed version: invalid requests submit nothing; a valid one records lineage and carries edits.
    assert.equal((await failing.request(`/${m.id}/generate`, 'POST', { parentId: 'missing', feedback: '手抬高' })).status, 400);
    assert.equal((await failing.request(`/${m.id}/generate`, 'POST', { parentId: revised.value.id, feedback: ' ' })).status, 400);
    assert.match((await failing.request(`/${m.id}/iterate/${revised.value.id}`, 'POST', { feedback: '手抬高', duration: 4 })).value.error, /DEEPSEEK/);
    assert.equal(submits, 2);
    const iteration = await failing.request(`/${m.id}/generate`, 'POST', { parentId: revised.value.id, feedback: '手抬高', edits: revised.value.edits });
    assert.equal(iteration.status, 202); assert.equal(iteration.value.parentId, revised.value.id);
    assert.equal(iteration.value.feedback, '手抬高'); assert.equal(iteration.value.edits.speed, .5);
    await new Promise(r => setTimeout(r, 20)); assert.equal(submits, 3);
  } finally {
    servers.forEach(server => server.emit('close')); globalThis.fetch = originalFetch; fs.rmSync(dir, { recursive: true });
  }
});
