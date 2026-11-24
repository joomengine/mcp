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
import { attachWorkspace, listWorkspaceTabs } from '../dist/attach.js';
import { cdpTabs, debuggerAddress, selectedFirefoxTab, selectedTab } from '../dist/attach-discovery.js';
import { DebugConnection } from '../dist/attach-wire.js';
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
  const owner = `<title>Primary owner</title><button id="reload-owner" onclick="setTimeout(()=>location.reload(),30)">Reload owner</button><button style="position:fixed;top:0;left:0;z-index:5" id="open-idle" onclick="window.open('/?second=1','idle-owner')">Open idle owner</button><iframe id="site-frame" src="/__site/fixture/"></iframe>
    <script>
      window.addEventListener('message', event => {
        const frame = document.querySelector('.jec-ai-frame');
        if (!frame || event.source !== frame.contentWindow) return;
        if (event.data === 'ai-ready') frame.dataset.ready = 'true';
        if (event.data === 'ai-clicked') document.getElementById('ai-proof').textContent = 'Visual AI action received';
      });
    </script>
    <iframe class="jec-ai-frame" sandbox="allow-scripts" src="/fixture-ai"></iframe>
    <output id="ai-proof"></output><button id="upload-site-button">Upload</button><input type="file" id="upload-site-file"><script type="module">
    import { createRuntimeViewHost } from './src/runtime-views.mjs';
    import { t } from './src/i18n.mjs';
    if (performance.getEntriesByType('navigation')[0]?.type === 'reload') document.title = 'Reloaded primary owner';
    const files = new Map();
    let nativeSessions = 0;
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
        if (rpc.method === 'initialize') nativeSessions++;
        const session = 'fixture-session-' + nativeSessions;
        if (rpc.method !== 'initialize' && (new Headers(init.headers).get('Mcp-Session-Id') !== session || rpc.params?.name === 'expire-session')) {
          return new Response(null, {status:404});
        }
        const result = rpc.method === 'initialize' ? {protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:String(nativeSessions)}} : {tools:[{name:'fixture-site'}]};
        return Response.json({jsonrpc:'2.0', id:rpc.id, result},{headers:{'Mcp-Session-Id':session}});
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
    if (req.url === '/fixture-ai') return res.end(`<button style="position:fixed;inset:0">AI panel action</button>
      <script>
        document.querySelector('button').onclick = () => parent.postMessage('ai-clicked', '*');
        requestAnimationFrame(() => requestAnimationFrame(() => parent.postMessage('ai-ready', '*')));
      </script>`);
    if (req.url === '/?second=1') return res.end('<title>Secondary owner</title><input id=site-name value="Idle client site">');
    if (req.url === '/__site/fixture/broken.css') { res.statusCode=404; return res.end(); }
    if (req.url === '/__site/fixture/verify') return res.end('<link rel="stylesheet" href="broken.css"><script>console.warn("Scoped console warning"); setTimeout(()=>{throw Error("Scoped JS exception")},40)</script><h1>Diagnostic route</h1>');
    if (req.url === '/__site/fixture/') return res.end(`<label>Title<input name="title"></label><input type="checkbox" id="selected">
      <select multiple id="multiple"><option value="first">First</option><option value="second">Second</option></select>
      <input type="file" id="file" hidden accept=".zip" onchange="document.querySelector('p').textContent=this.files[0].name">
      <button id="prompt" onclick="if(confirm('Update this title?')) document.querySelector('p').textContent=prompt('Title','')">Change</button>
      <p></p><iframe title="Editor" id="editor" srcdoc="<body contenteditable=true>Hello</body>"></iframe>`);
    res.end(module ?? owner);
  });
  const port = await listen(server);
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  return 'http://127.0.0.1:' + port + '/';
}

// A failed transition can leave no live Joomla runtime. Read only the owner's sanitized
// error panel and storage measurements without reopening a site or replaying the operation.
async function readFailurePanel() {
  const panel = document.querySelector('#error-view:not([hidden])');
  const feedback = document.querySelector('#header-feedback:not([hidden])[data-error=true]');
  const {presentError} = await import(new URL('src/error-presentation.mjs', location.href).href);
  const secrets = [document.getElementById('admin-password')?.value];
  const summary = panel?.querySelector('#error-message')?.textContent || feedback?.textContent;
  const details = panel?.querySelector('#error-diagnostics')?.textContent;
  const storage = await navigator.storage.estimate();
  return JSON.stringify({
    summary: summary && presentError(summary, {secrets}).summary,
    details: details && presentError(Object.assign(new Error('Playground'), {technicalDetails: details}), {secrets}).details.slice(0, 3000),
    usageBytes: storage.usage, quotaBytes: storage.quota
  });
}

async function reportTransitionFailure(endpoint, base) {
  const address = new URL(endpoint);
  const owner = new URL(base);
  const firefox = address.protocol === 'ws:';
  const socket = firefox ? address : debuggerAddress(selectedTab(await cdpTabs(address), owner), address);
  const wire = await DebugConnection.open(socket);
  let session = false;
  try {
    const expression = '(' + readFailurePanel.toString() + ')()';
    if (firefox) {
      await wire.request('session.new', {capabilities: {}}, 10000);
      session = true;
      const tab = await selectedFirefoxTab(wire, owner);
      const result = await wire.request('script.evaluate', {expression, target: {context: tab.id}, awaitPromise: true}, 10000);
      if (result.type === 'success') console.error('Playground owner:', result.result.value);
    } else {
      const result = await wire.request('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, 10000);
      if (!result.exceptionDetails) console.error('Playground owner:', result.result.value);
    }
  } finally {
    try { if (session) await wire.request('session.end', {}, 5000); }
    finally { wire.close(); }
  }
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
    const {exerciseDeploymentLaunch} = await import('./deployment-scenario.mjs');
    await exerciseDeploymentLaunch(async (name,args) => {
      const response=await client.callTool({name,arguments:args},undefined,{timeout:16*60_000});
      assert(!response.isError, JSON.stringify(response.content));
      return response.structuredContent ?? JSON.parse(response.content.find(item=>item.type==='text').text);
    });
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
  let lastError, info;
  const deadline = Date.now() + (hosted ? 9 * 60_000 : 35_000);
  while (Date.now() < deadline) {
    if (startError) throw startError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Browser exited: ' + tail);
    try {
      active ??= await attachWorkspace({endpoint,playgroundUrl:base});
      info = await active.call('workspace_info', {});
      if (info.healthy) break;
    } catch (error) {
      lastError = error;
      await active?.close().catch(() => {});
      active = undefined;
    }
    await delay(hosted ? 2000 : 300);
  }
  if (!info?.healthy || !active) throw new Error('Failed to start the selected owner: ' + (lastError?.message ?? info?.phase) + '\n' + tail);
  assert.equal(info.healthy, true);
  if (!hosted) assert.equal(info.workspaceId, 'existing-owner');
  const native = await active.call('native_tools', {});
  assert.ok(native.tools.length, 'The in-page native MCP session must preserve its authentication headers.');
  if (!hosted) {
    const before = await active.call('native_info', {});
    await assert.rejects(active.call('native_call', {name:'expire-session'}), /HTTP 404/);
    const after = await active.call('native_info', {});
    assert.equal(Number(after.serverInfo.version), Number(before.serverInfo.version) + 1, 'An expired server session triggers a new handshake.');
  }
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
    const first = await active.listAttachedTabs();
    assert.equal(first.tabs.length,1);
    assert.equal(first.tabs[0].previewLoaded,true);


    const query = await active.call('browser_inspect',{scope});
    assert(query.controls.some(c => c.label === 'Title' && c.name === 'title'));
    assert(query.controls.some(c=>c.id==='file' && !c.visible && c.accept==='.zip'));
    await active.call('browser_click',{scope,selector:'input[name=title]'});
    await active.call('browser_keyboard',{scope,text:'Replace'});
    await active.call('browser_keyboard',{scope,key:'a',modifiers:['Control']});
    await active.call('browser_keyboard',{scope,text:'New title'});
    const values=await active.call('browser_inspect',{scope,includeValues:true});
    assert.equal(values.controls.find(c=>c.name==='title').value,'New title');
    await active.call('browser_check',{scope,selector:'#selected',checked:true});
    await active.call('browser_select',{scope,selector:'#multiple',value:['first','second']});
    const controls = (await active.call('browser_inspect',{scope})).controls;
    assert.equal(controls.find(c=>c.id==='selected').checked,true);
    assert.deepEqual(controls.find(c=>c.id==='multiple').options.map(o=>o.selected),[true,true]);
    await active.call('browser_fill',{scope,framePath:['#editor'],selector:'body',value:'Edited rich text'});
    assert.match((await active.call('browser_inspect',{scope,framePath:['#editor']})).text,/Edited rich text/);
    const chosen=await active.call('browser_options',{selector:'#multiple',filter:'Second',limit:1});
    assert.equal(chosen.options[0].value, 'second');
    await assert.rejects(active.call('browser_click',{selector:'#prompt'}),/Update this title/);
    const answer=await active.call('browser_click',{selector:'#prompt',dialogResponses:[
      {type:'confirm',message:'Update this title?',accept:true},{type:'prompt',message:'Title',accept:true,text:'Confirmed title'}
    ]});
    assert.equal(answer.dialogs.length,2);
    assert.match((await active.call('browser_inspect',{scope})).text,/Confirmed title/);
    const saved = await active.call('site_export', {});
    await active.call('browser_upload',{scope,selector:'#file',artifactIds:[saved.id]});
    assert.match((await active.call('browser_inspect',{scope})).text,/fixture.zip/);
    await active.call('browser_inspect',{scope:'playground',waitForSelector:'.jec-ai-frame[data-ready="true"]'});
    const shot = await active.call('browser_screenshot',{scope:'ai'});
    assert(shot.content[0].data.startsWith('iVBORw0KGgo'));
    assert.equal(shot.structuredContent.mimeType,'image/png');
    await active.call('browser_pointer',{scope:'ai',x:20,y:20});
    assert.match((await active.call('browser_inspect',{scope:'playground',waitForText:'Visual AI action received'})).text,/Visual AI action received/);
    await active.call('browser_scroll',{scope:'ai',x:8,y:8,deltaY:20});
    await active.call('browser_keyboard',{scope:'ai',key:'Tab'});
    await assert.rejects(active.call('browser_keyboard',{scope:'site',text:'Wrong surface'}),/Focus a control/);
    await active.call('artifact_release',{id:shot.structuredContent.id});
    await active.call('browser_diagnostics',{clear:true});
    await active.call('browser_navigate',{path:'verify'});
    let diagnostics;
    for(let attempt=0;attempt<30;attempt++) {
      diagnostics = await active.call('browser_diagnostics',{});
      if (diagnostics.errors.some(error=>error.message.includes('Scoped JS exception'))) break;
      await delay(100);
    }
    assert(diagnostics.resources.some(resource=>resource.source==='broken.css' && (resource.status===404 || resource.status===null)));
    assert(diagnostics.errors.some(error=>error.message.includes('Scoped console warning')));
    assert(diagnostics.errors.some(error=>error.level==='error' && error.message.includes('Scoped JS exception')));
    await active.call('browser_navigate',{path:''});

    await assert.rejects(active.call('site_restore', {id:saved.id, replaceWorkspaceId:'unrelated-owner'}), /does not match/);
    assert.equal((await active.call('workspace_info', {})).workspaceId, info.workspaceId);
    const restored = await active.call('site_restore', {id:saved.id, replaceWorkspaceId:info.workspaceId});
    assert.deepEqual(restored, {workspaceId:'restored-owner', restored:true});
    await active.call('browser_pointer',{scope:'playground',x:40,y:15});
    let choices;
    for (let i=0;i<50;i++) {
      choices=await active.listAttachedTabs();
      if (choices.tabs.some(tab=>tab.siteName === 'Idle client site')) break;
      await delay(100);
    }
    assert.deepEqual(choices.tabs.map(tab=>tab.title).sort(),['Primary owner','Secondary owner']);
    assert.equal(choices.tabs.find(tab=>tab.title === 'Secondary owner').previewLoaded,false);
    await active.close();
    active=undefined;
    assert.deepEqual((await listWorkspaceTabs({endpoint,playgroundUrl:base})).tabs.map(tab=>tab.tabId).sort(),choices.tabs.map(tab=>tab.tabId).sort());
    await assert.rejects(attachWorkspace({endpoint,playgroundUrl:base}),/workspace_list/);
    active=await attachWorkspace({endpoint,playgroundUrl:base,tabId:first.tabs[0].tabId});
    assert.equal((await active.call('workspace_info',{})).workspaceId,'restored-owner');
    await active.call('browser_click',{scope:'playground',selector:'#reload-owner'});
    // The idle window is in front, so Firefox may throttle the owner tab's reload timer.
    // Probe the current document independently of the retained runtime before attempting a stale write.
    let reloaded;
    const reloadDeadline = Date.now() + 15_000;
    while (!reloaded && Date.now() < reloadDeadline) {
      const list = await active.listAttachedTabs();
      reloaded = list.tabs.find(tab => tab.title === 'Reloaded primary owner' && tab.previewLoaded);
      if (!reloaded) await delay(100);
    }
    assert(reloaded, 'The original owner tab must finish loading a new document.');
    if (mode === 'firefox') assert.notEqual(reloaded.tabId, first.tabs[0].tabId);
    await assert.rejects(active.call('file_write',{path:'/wrong-owner',content:'never replay',expectedRevision:null}),/workspace_close, workspace_list, then workspace_attach/);
    await active.close();
    active=undefined;
    const renewed=(await listWorkspaceTabs({endpoint,playgroundUrl:base})).tabs.find(tab=>tab.title==='Reloaded primary owner');
    assert.equal(renewed?.tabId,reloaded.tabId);
    active=await attachWorkspace({endpoint,playgroundUrl:base,tabId:renewed.tabId});
    assert.equal((await active.call('workspace_info',{})).workspaceId,'existing-owner');
    await active.call('file_write',{path:'/wrong-owner',content:'first authorized write after reattachment',expectedRevision:null});


  }
  if (hosted) {
    const { exerciseDeployment } = await import('./deployment-scenario.mjs');
    const call = (name,args) => active.call(name,args);
    await exerciseWorkspaceSurfaces(call);
    await exerciseDeployment(call);
  }
  await active.close();
  active = undefined;
  if (hosted) {
    try { await exerciseAttachedComponent(endpoint); }
    catch (error) {
      await reportTransitionFailure(endpoint, base).catch(() => console.error('Playground owner diagnostics unavailable.'));
      throw error;
    }
  }
});
