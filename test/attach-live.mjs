import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { attachWorkspace } from '../dist/attach.js';

const mode = process.env.ATTACH_BROWSER || 'chromium';
const hosted = process.env.ATTACH_HOSTED === '1' || mode === 'desktop';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

// The fixture uses the real Playground owner/companion implementation over two BroadcastChannel endpoints.
// Hosted runs use the full deployment and its persistent filesystem.
async function fixture(t) {
  const views = await readFile(path.join(process.env.PLAYGROUND_SOURCE, 'src/runtime-views.mjs'));
  const owner = `<script type="module">
    import { createRuntimeViewHost } from './src/runtime-views.mjs';
    const files = new Map();
    const runtime = {
      workspace: { id: 'existing-owner', root: '/', subscribe: () => () => {},
        async request(op, { path, bytes, expectedRevision }) {
          if (op === 'write') {
            if ((files.get(path)?.revision ?? null) !== expectedRevision) throw new Error('revision changed');
            const revision = crypto.randomUUID();
            files.set(path, {bytes, path, revision}); return {path, revision};
          }
          if (op === 'read') return files.get(path);
          throw new Error('unexpected fixture request ' + op);
        } },
      debugger: { state: 'idle', subscribe: () => () => {} },
      healthy: true, baseUrl: location.origin + '/__site/fixture/', url: location.href,
      configuration: {siteName:'Browser-owned Joomla', storageKey:'attach-test', deployId:'jcb-mcp'}, installation:{},
      flush: async () => true,
    };
    createRuntimeViewHost({getRuntime: () => runtime, baseURL: location.origin + '/'});
  </script>`;
  const server = createServer((req, res) => {
    const module = req.url.startsWith('/src/runtime-views.mjs');
    res.setHeader('Content-Type', module ? 'text/javascript' : 'text/html');
    res.end(module ? views : owner);
  });
  const port = await listen(server);
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  return 'http://127.0.0.1:' + port + '/';
}

test('attach to the selected running owner, preserve site and process across disconnect', {timeout: 12 * 60_000}, async t => {
  if (!['chromium', 'firefox', 'desktop'].includes(mode)) throw new Error('Unknown ATTACH_BROWSER.');
  const executable = process.env.ATTACH_EXECUTABLE || (mode === 'desktop' ? 'joomengine' : mode);
  const base = hosted ? 'https://playground.joomengine.org/' : await fixture(t);
  const profile = await mkdtemp(path.join(tmpdir(), 'joomengine-attach-'));
  const portProbe = createServer();
  const port = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const endpoint = mode === 'firefox' ? 'ws://127.0.0.1:' + port + '/session' : 'http://127.0.0.1:' + port;
  const args = mode === 'desktop' ? [] :
    mode === 'firefox' ? ['--headless','--no-remote','--profile',profile,'--remote-debugging-port',String(port),base] :
    ['--headless','--disable-gpu','--no-first-run','--disable-dev-shm-usage','--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + port,'--user-data-dir=' + profile, ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),base];
  const env = { ...process.env };
  if (mode === 'desktop') {
    for (const [key, dir] of [['XDG_DATA_HOME','data'],['XDG_CACHE_HOME','cache'],['XDG_CONFIG_HOME','config']]) {
      env[key] = path.join(profile,dir);
      await mkdir(env[key], {recursive: true});
    }
    env.QTWEBENGINE_REMOTE_DEBUGGING = '127.0.0.1:' + port;
  }
  const child = spawn(executable, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  let startError;
  child.on('error', error => { startError = error; });
  child.stderr.on('data', chunk => { tail = (tail + chunk.toString()).slice(-1500); });
  const ended = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null && !startError) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 4_000);
      await ended;
      clearTimeout(timer);
    }
    await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  });

  let active;
  t.after(async () => { await active?.close().catch(() => {}); });
  let lastError;
  const deadline = Date.now() + (hosted ? 9 * 60_000 : 35_000);
  while (Date.now() < deadline) {
    if (startError) throw startError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Browser exited: ' + tail);
    try { active = await attachWorkspace({endpoint,playgroundUrl:base}); break; }
    catch (error) { lastError = error; await delay(hosted ? 2000 : 300); }
  }
  if (!active) throw new Error('Failed to attach to owner: ' + lastError?.message + '\n' + tail);
  const info = await active.call('workspace_info', {});
  assert.equal(info.healthy, true);
  if (!hosted) assert.equal(info.workspaceId, 'existing-owner');
  const target = '/tmp/mcp-attach-' + crypto.randomUUID() + '.txt';
  const content = 'one existing owner: ' + crypto.randomUUID();
  await active.call('file_write', {path:target, content, expectedRevision:null});
  await active.call('workspace_flush', {});
  await active.close();
  active = undefined;
  assert.equal(child.exitCode, null);
  active = await attachWorkspace({endpoint,playgroundUrl:base});
  assert.equal((await active.call('workspace_info', {})).workspaceId, info.workspaceId);
  assert.equal((await active.call('file_read', {path:target})).content, content);
  await active.close();
  active = undefined;
});
