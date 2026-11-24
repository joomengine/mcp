// Exercise the same owner API used by a client browser, Desktop, and an agent-owned persistent Chromium profile.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory = await mkdtemp(join(tmpdir(), 'joomengine-profile-'));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function connect() {
  const client = new Client({ name: 'workspace-life-test', version: '1' });
  await client.connect(new StdioClientTransport({command: process.execPath, args: [cli],
    env: {...process.env, JOOMENGINE_PROFILE_DIR: directory}, stderr: 'inherit'}));
  return client;
}
let client;
async function call(name, args = {}) {
  const result = await client.callTool({name, arguments: args}, undefined, { timeout: 12 * 60_000 });
  assert(!result.isError, name + ': ' + result.content[0]?.text);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
try {
  client = await connect();
  const first = await call('workspace_open', {deployId:'blank', configuration:{siteName:'Saved workspace'}});
  assert.equal(first.phase, 'running');
  const sites = await call('workspace_sites');
  const record = sites.sites.find(s => s.storageKey === sites.storageKey);
  assert(record && record.protected);
  await call('file_write', {path:'/owner-marker.txt', content:'survives reopening', expectedRevision:null});
  await call('workspace_rename', {storageKey: record.storageKey, name:'My saved site'});
  assert((await call('workspace_sites')).sites.some(s => s.displayName === 'My saved site'));
  const refuse = await client.callTool({name:'workspace_reset', arguments:{workspaceId:'wrong-identity'}});
  assert(refuse.isError);
  const stopped = await call('workspace_stop', {workspaceId: first.workspaceId});
  assert.equal(stopped.phase, 'stopped');
  assert.equal((await call('workspace_sites')).phase, 'stopped');
  assert.equal((await call('workspace_start')).phase, 'running');
  const live = await call('workspace_info');
  await call('workspace_restart', {workspaceId: live.workspaceId});
  await call('file_write', {path:'/disconnect-marker.txt', content:'written immediately before disconnect', expectedRevision:null});
  await client.close();
  client = await connect();
  await call('workspace_open', {idle:true});
  assert.equal((await call('workspace_pause')).countdownActive, false);
  await call('workspace_resume', {storageKey:record.storageKey});
  assert.equal((await call('file_read',{path:'/owner-marker.txt'})).content,'survives reopening');
  assert.equal((await call('file_read',{path:'/disconnect-marker.txt'})).content,'written immediately before disconnect');
  // Exercise a recoverable configuration fault inside this test's disposable saved site.
  const configuration = await call('file_read', { path: '/configuration.php' });
  const enabled = configuration.content.replace(/(\bpublic\s+\$debug\s*=\s*)[^;]+;/, '$1true;');
  assert.match(enabled, /public\s+\$debug\s*=\s*true;/);
  const fault = "\nif (defined('_JEXEC') && (new JConfig())->debug) { http_response_code(503); exit('recovery fixture'); }\n";
  const damaged = enabled.replace(/\?>\s*$/, '') + fault;
  await call('file_write', { path: '/configuration.php', expectedRevision: configuration.revision, content: damaged });
  const failure = await call('site_request', { path: '/index.php' });
  assert.equal(failure.status, 503);
  const broken = await call('file_stat', { path: '/configuration.php', revision: true });
  const beforeRecovery = await call('workspace_info');
  await call('workspace_stop', { workspaceId: beforeRecovery.workspaceId });
  const recovery = await call('workspace_recover', { storageKey: record.storageKey });
  assert.equal(recovery.phase, 'recovery');
  assert.equal(recovery.recovery.configured, true);
  assert.equal(recovery.recovery.databaseAvailable, true);
  assert.equal((await call('workspace_sites')).storageKey, record.storageKey);
  const archive = await call('workspace_recovery_export');
  assert(archive.size > 1000);
  assert.equal((await call('artifact_read', { id: archive.id, length: 2 })).base64, 'UEs=');
  await call('artifact_release', { id: archive.id });
  const repaired = await call('workspace_repair');
  assert.equal(repaired.debug, false);
  assert.equal(repaired.errorReporting, 'default');
  assert(repaired.backup.endsWith('/configuration-' + broken.revision + '.php'));
  const running = await call('workspace_restart', { workspaceId: recovery.workspaceId });
  assert.equal(running.phase, 'running');
  assert.equal(Boolean((await call('workspace_info')).recovery), false);
  assert.equal((await call('file_read', { path: '/owner-marker.txt' })).content, 'survives reopening');
  const page = await call('site_request', { path: '/index.php' });
  assert(page.status >= 200 && page.status < 400);
  const latest = await call('workspace_info');
  const next = await call('deployment_launch', {replaceWorkspaceId:latest.workspaceId,
    source:{ deployId:'blank', configuration:{siteName:'Second workspace'} }});
  assert.notEqual((await call('workspace_info')).workspaceId,latest.workspaceId);
  assert((await call('workspace_sites')).sites.some(s=>s.storageKey===record.storageKey));
  assert((await call('workspace_delete',{storageKey:record.storageKey})).deleted);
  const active = await call('workspace_info');
  assert.equal((await call('workspace_reset',{workspaceId:active.workspaceId})).phase,'running');
  console.log('Verified saved state across independent MCP sessions, durable restart, scoped reset, switch and deletion.', next.workspaceId);
} finally {
  try { await client?.close(); } finally { await rm(directory, {recursive:true,force:true,maxRetries:6,retryDelay:250}); }
}
