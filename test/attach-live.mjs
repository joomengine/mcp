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
import { exerciseWorkspaceSurfaces } from './attach-ui-scenario.mjs';

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
  const modules = new Map(await Promise.all(['runtime-views.mjs', 'mcp.mjs', 'i18n.mjs', 'locales/en.mjs'].map(async module => [
    '/src/' + module, await readFile(path.join(process.env.PLAYGROUND_SOURCE, 'src', module)),
  ])));
  const owner = `<iframe id="site-frame" src="/__site/fixture/"></iframe>
    <iframe class="jec-ai-frame" sandbox="allow-scripts" srcdoc="<button style='position:fixed;inset:0' onclick='parent.postMessage(1,&quot;*&quot;)'>AI panel action</button>"></iframe>
    <output id="ai-proof"></output><button id="upload-site-button">Upload</button><input type="file" id="upload-site-file"><script type="module">
    import { createRuntimeViewHost } from './src/runtime-views.mjs';
    import { t } from './src/i18n.mjs';
    window.addEventListener('message',event=>{ if(event.source===document.querySelector('.jec-ai-frame').contentWindow && event.data===1) document.getElementById('ai-proof').textContent='Visual AI action received'; });
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
      exportSite: async () => ({filename:'fixture.zip',mimeType:'application/zip',bytes:new Uint8Array([80,75,3,4])}),
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
    const host = createRuntimeViewHost({getRuntime: () => runtime, baseURL: location.origin + '/'});
    document.getElementById('upload-site-file').onchange = () => {
      const dialog = document.createElement('dialog');
      dialog.dataset.liveReplacement = 'true';
      const heading = document.createElement('h2');
      heading.id = 'live-replacement-title'; heading.textContent = t('lifecycle.replaceConfirm');
      const accept = document.createElement('button');
      accept.dataset.replaceChoice = 'continue';
      accept.onclick = () => { dialog.remove(); runtime.workspace.id = 'restored-owner'; host.update(); };
      dialog.append(heading,accept); document.body.append(dialog); dialog.showModal();
    };
  </script>`;
  const server = createServer((req, res) => {
    const module = modules.get(req.url);
    res.setHeader('Content-Type', module ? 'text/javascript' : 'text/html');
    if (req.url === '/__site/fixture/') return res.end(`<label>Title<input name="title"></label><input type="checkbox" id="selected">
      <select multiple id="multiple"><option value="first">First</option><option value="second">Second</option></select>
      <input type="file" id="file" onchange="document.querySelector('p').textContent=this.files[0].name">
      <p></p><iframe title="Editor" id="editor" srcdoc="<body contenteditable=true>Hello</body>"></iframe>`);
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
  const client = new Client({name:'attached-jcb-acceptance',version:'1'});
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
    env: {...process.env, JOOMENGINE_BROWSER_ENDPOINT:endpoint}, stderr:'inherit',
  }));
  try {
    const attached = await client.callTool({name:'workspace_attach',arguments:{}});
    assert(!attached.isError, 'Expected to attach to the same client-owned workspace.');
    const info = attached.structuredContent ?? JSON.parse(attached.content[0].text);
    await exerciseJcb(client, { replaceWorkspaceId: info.workspaceId });
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
  if (!hosted) {
    const scope = 'site';
    const query = await active.call('browser_inspect',{scope});
    assert(query.controls.some(c => c.label === 'Title' && c.name === 'title'));
    await active.call('browser_check',{scope,selector:'#selected',checked:true});
    await active.call('browser_select',{scope,selector:'#multiple',value:['first','second']});
    const controls = (await active.call('browser_inspect',{scope})).controls;
    assert.equal(controls.find(c=>c.id==='selected').checked,true);
    assert.deepEqual(controls.find(c=>c.id==='multiple').options.map(o=>o.selected),[true,true]);
    await active.call('browser_fill',{scope,framePath:['#editor'],selector:'body',value:'Edited rich text'});
    assert.match((await active.call('browser_inspect',{scope,framePath:['#editor']})).text,/Edited rich text/);
    const saved = await active.call('site_export', {});
    await active.call('browser_upload',{scope,selector:'#file',artifactIds:[saved.id]});
    assert.match((await active.call('browser_inspect',{scope})).text,/fixture.zip/);
    const shot = await active.call('browser_screenshot',{scope:'ai'});
    assert(shot.content[0].data.startsWith('iVBORw0KGgo'));
    assert.equal(shot.structuredContent.mimeType,'image/png');
    await active.call('browser_pointer',{scope:'ai',x:20,y:20});
    assert.match((await active.call('browser_inspect',{scope:'playground',waitForText:'Visual AI action received'})).text,/Visual AI action received/);
    await active.call('browser_keyboard',{scope:'ai',key:'Tab'});
    await assert.rejects(active.call('browser_keyboard',{scope:'site',text:'Wrong surface'}),/Focus a control/);
    await active.call('artifact_release',{id:shot.structuredContent.id});
    await assert.rejects(active.call('site_restore', {id:saved.id, replaceWorkspaceId:'unrelated-owner'}), /does not match/);
    assert.equal((await active.call('workspace_info', {})).workspaceId, info.workspaceId);
    const restored = await active.call('site_restore', {id:saved.id, replaceWorkspaceId:info.workspaceId});
    assert.deepEqual(restored, {workspaceId:'restored-owner', restored:true});
  }
  if (hosted) {
    const { exerciseDeployment } = await import('./deployment-scenario.mjs');
    const call = (name,args) => active.call(name,args);
    await exerciseWorkspaceSurfaces(call);
    await exerciseDeployment(call);
  }
  await active.close();
  active = undefined;
  if (hosted) await exerciseAttachedComponent(endpoint);
});
