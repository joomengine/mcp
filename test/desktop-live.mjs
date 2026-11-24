import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugConnection } from '../dist/attach-wire.js';
import { exerciseWorkspaceSurfaces } from './attach-ui-scenario.mjs';
import { exerciseDeployment } from './deployment-scenario.mjs';
import { exerciseJcb } from './jcb-scenario.mjs';

const binary = process.argv[2];
if (!binary) throw new Error('Pass the path to the JoomEngine Desktop executable.');

// Follow the same fresh-profile welcome flow and real JCB dashboard checks as
// joomengine/joomengine's test/native-playground.js. The service worker can
// reload the page while establishing cross-origin isolation.
function dashboardState() {
  const get = id => document.getElementById(id);
  const failure = document.querySelector('#error-view:not([hidden]) #error-message')?.textContent?.trim();
  if (failure) return { error: failure.slice(0, 250) };
  if (!navigator.serviceWorker?.controller || !crossOriginIsolated ||
    document.documentElement.dataset.playgroundEnvironment !== 'ready') return { phase: 'initializing' };
  if (!sessionStorage.getItem('desktop-test-recipe')) {
    // The fixed desktop home first negotiates its own service-worker isolation
    // URL. Carry its marker into the recipe link after that handshake finishes.
    const recipe = new URL(location.href);
    recipe.searchParams.set('deploy', 'jcb-mcp');
    recipe.searchParams.set('immediate', '1');
    sessionStorage.setItem('desktop-test-recipe', '1');
    location.replace(recipe.href);
    return { phase: 'selecting JCB + MCP' };
  }
  const frame = get('site-frame');
  if (!frame && !document.hidden) {
    if (get('build-update')?.hidden === false) {
      if (!sessionStorage.getItem('desktop-test-update') && get('reload-build')?.matches(':enabled')) {
        sessionStorage.setItem('desktop-test-update', '1');
        get('reload-build').click();
      }
    } else if (!sessionStorage.getItem('desktop-test-launch') && get('welcome')?.hidden === false &&
      get('launch-countdown')?.hidden === true && get('embedded-launch')?.matches(':enabled') &&
      document.querySelector('#activity-log li:last-child')?.textContent.includes('Ready to launch.')) {
      sessionStorage.setItem('desktop-test-launch', '1');
      get('embedded-launch').click();
    }
  }
  const doc = frame?.contentDocument;
  const ready = frame && !frame.hidden && doc?.readyState === 'complete' &&
    ([...doc.querySelectorAll('h1,h2')].some(node => /component builder dashboard/i.test(node.textContent)) ||
      new URL(doc.URL).searchParams.get('option') === 'com_componentbuilder' &&
      doc.querySelectorAll('a[href*="option=com_componentbuilder"][href*="view="]').length >= 2);
  return { phase: ready ? 'ready' : 'launching JCB' };
}

async function waitForDesktop(endpoint, child) {
  let lastState = 'starting Qt';
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('The desktop process exited during startup.');
    let wire;
    let state;
    try {
      const discovery = await fetch(endpoint + '/json/list', { signal: AbortSignal.timeout(4000) });
      const tabs = await discovery.json();
      const tab = tabs.find(item => item.type === 'page' && new URL(item.url).origin === 'https://playground.joomengine.org'
        && new URL(item.url).pathname === '/');
      if (tab) {
        wire = await DebugConnection.open(new URL(tab.webSocketDebuggerUrl));
        const reply = await wire.request('Runtime.evaluate', { expression: '(' + dashboardState + ')()', returnByValue: true }, 8000);
        state = reply.result?.value;
      }
    } catch (error) {
      // A startup navigation can replace this target between discovery and evaluation.
      lastState = error.message;
    } finally { wire?.close(); }
    if (state?.error) throw new Error('Playground failed to start JCB: ' + state.error);
    if (state?.phase === 'ready') return;
    if (state?.phase && state.phase !== lastState) {
      lastState = state.phase;
      console.log('Desktop is ' + lastState);
    }
    await delay(1500);
  }
  throw new Error('Timed out waiting for the real desktop JCB dashboard: ' + lastState);
}

async function connectClient(endpoint) {
  const client = new Client({ name: 'desktop-acceptance', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
    env: { ...process.env, JOOMENGINE_BROWSER_ENDPOINT: endpoint }, stderr: 'inherit',
  }));
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const response = result.content.map(item => item.text).join('');
  assert(!result.isError, name + ' failed: ' + response);
  return JSON.parse(response);
}

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const endpoint = 'http://127.0.0.1:' + port;
const profile = await mkdtemp(path.join(tmpdir(), 'joomengine-desktop-mcp-'));
let child, client, macDataLink;
try {
  const env = { ...process.env };
  if (process.platform === 'win32') {
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port;
    env.WEBVIEW2_USER_DATA_FOLDER = path.join(profile, 'webview2');
  } else {
    env.QTWEBENGINE_REMOTE_DEBUGGING = '127.0.0.1:' + port;
    if (process.platform === 'darwin') {
      // The released macOS app uses its fixed Application Support folder.
      // symlink() refuses to replace an existing user's desktop profile.
      const data = path.join(homedir(), 'Library', 'Application Support', 'JoomEngine');
      await mkdir(path.dirname(data), { recursive: true });
      await symlink(profile, data);
      macDataLink = data;
    } else {
      env.XDG_DATA_HOME = path.join(profile, 'data');
      env.XDG_CONFIG_HOME = path.join(profile, 'config');
      env.XDG_CACHE_HOME = path.join(profile, 'cache');
    }
  }
  child = spawn(path.resolve(binary), [], { stdio: 'inherit', env });
  await once(child, 'spawn');
  await waitForDesktop(endpoint, child);
  client = await connectClient(endpoint);
  const workspace = await call(client, 'workspace_attach');
  assert(workspace.healthy && workspace.workspaceId);
  assert.equal(workspace.deployId, 'jcb-mcp');
  const invoke = (name,args) => call(client,name,args);
  await exerciseWorkspaceSurfaces(invoke);
  await exerciseDeployment(invoke);
  const marker = randomUUID();
  const file = '/tmp/mcp-desktop-' + marker + '.txt';
  await call(client, 'file_write', { path: file, content: marker, expectedRevision: null });
  await call(client, 'database_query', { sql: 'CREATE TABLE mcp_desktop_test (value VARCHAR(36) PRIMARY KEY)' });
  await call(client, 'database_query', { sql: 'INSERT INTO mcp_desktop_test (value) VALUES (?)', parameters: [marker] });
  await call(client, 'workspace_flush');
  await call(client, 'workspace_close');
  await client.close();
  client = await connectClient(endpoint);
  const resumed = await call(client, 'workspace_attach');
  assert.equal(resumed.workspaceId, workspace.workspaceId);
  assert.equal((await call(client, 'file_read', { path: file })).content, marker);
  const rows = await call(client, 'database_query', { sql: 'SELECT value FROM mcp_desktop_test WHERE value = ?', parameters: [marker] });
  assert.deepEqual(rows.rows, [{ value: marker }]);
  assert.equal(child.exitCode, null);
  console.log('A fresh MCP client reattached to the same JCB desktop site and verified the saved file and MariaDB row.');
  await exerciseJcb(client, { replaceWorkspaceId: resumed.workspaceId });
  await call(client, 'workspace_close');
} finally {
  try { await client?.close(); }
  finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await stopped; } finally { clearTimeout(timer); }
    }
    if (macDataLink) await unlink(macDataLink);
    await rm(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}
