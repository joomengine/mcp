import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { attachWorkspace } from '../dist/attach.js';

const mode = process.env.ATTACH_BROWSER || 'chromium';
const hosted = process.env.ATTACH_HOSTED === '1';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

// The fixture uses the real Playground owner/companion implementation over two BroadcastChannel endpoints.
// Hosted runs use the full deployment and its persistent filesystem.
async function fixture(t) {
  const modules = new Map(await Promise.all(['runtime-views.mjs', 'mcp.mjs'].map(async module => [
    '/src/' + module, await readFile(path.join(process.env.PLAYGROUND_SOURCE, 'src', module)),
  ])));
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
      getMcpConnection: async () => ({installed:true, token:'fixture-only'}),
      async request(_path, init) {
        if (new Headers(init.headers).get('X-Joomla-Token') !== 'fixture-only') return new Response(null,{status:401});
        if (init.method === 'DELETE') return new Response(null, {status:204});
        const rpc = JSON.parse(init.body);
        if (!rpc.id) return new Response(null,{status:202});
        const result = rpc.method === 'initialize' ? {protocolVersion:'2025-11-25'} : {tools:[{name:'fixture-site'}]};
        return Response.json({jsonrpc:'2.0', id:rpc.id, result},{headers:{'Mcp-Session-Id':'fixture-session'}});
      },
    };
    createRuntimeViewHost({getRuntime: () => runtime, baseURL: location.origin + '/'});
  </script>`;
  const server = createServer((req, res) => {
    const module = modules.get(req.url);
    res.setHeader('Content-Type', module ? 'text/javascript' : 'text/html');
    res.end(module ?? owner);
  });
  const port = await listen(server);
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  return 'http://127.0.0.1:' + port + '/';
}

async function exerciseAttachedComponent(endpoint) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { exerciseJcb } = await import('./jcb-scenario.mjs');
  const { armRestoreConfirmation } = await import('./confirm-restore.mjs');
  const { DebugConnection } = await import('../dist/attach-wire.js');
  const client = new Client({name:'attached-jcb-acceptance',version:'1'});
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
    env: {...process.env, JOOMENGINE_BROWSER_ENDPOINT:endpoint}, stderr:'inherit',
  }));
  try {
    const attached = await client.callTool({name:'workspace_attach',arguments:{}});
    assert(!attached.isError, 'Expected to attach to the same client-owned workspace.');
    await exerciseJcb(client, {beforeRestore: async () => {
      const tabs = await (await fetch(endpoint + '/json/list')).json();
      const owner = tabs.find(tab => {
        const url = new URL(tab.url);
        return tab.type === 'page' && url.origin === 'https://playground.joomengine.org'
          && url.pathname === '/' && !url.searchParams.has('view');
      });
      assert.ok(owner, 'The same isolated owner must receive the site-replacement prompt.');
      const observer = await DebugConnection.open(new URL(owner.webSocketDebuggerUrl));
      try {
        const result = await observer.request('Runtime.evaluate', {
          expression: '(' + armRestoreConfirmation.toString() + ')()', returnByValue:true
        });
        assert.ok(!result.exceptionDetails, result.exceptionDetails?.text);
      } finally { observer.close(); }
    }});
  } finally { await client.close(); }
}

test('attach to the selected running owner, preserve site and process across disconnect', {timeout: 50 * 60_000}, async t => {
  if (!['chromium', 'firefox'].includes(mode)) throw new Error('Unknown ATTACH_BROWSER.');
  const executable = process.env.ATTACH_EXECUTABLE || mode;
  const base = hosted ? 'https://playground.joomengine.org/' : await fixture(t);
  const initialUrl = hosted ? base + '?deploy=jcb-mcp&immediate=1' : base;
  const profile = await mkdtemp(path.join(tmpdir(), 'joomengine-attach-'));
  const portProbe = createServer();
  const port = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const endpoint = mode === 'firefox' ? 'ws://127.0.0.1:' + port + '/session' : 'http://127.0.0.1:' + port;
  const args = mode === 'firefox' ? ['--headless','--no-remote','--profile',profile,'--remote-debugging-port',String(port),initialUrl] :
    ['--headless','--disable-gpu','--no-first-run','--disable-dev-shm-usage','--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + port,'--user-data-dir=' + profile, ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),initialUrl];
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
  const native = await active.call('native_tools', {});
  assert.ok(native.tools.length, 'The in-page native MCP session must preserve its authentication headers.');
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
  if (hosted && mode === 'chromium') await exerciseAttachedComponent(endpoint);
});
