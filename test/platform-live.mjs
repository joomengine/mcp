// Exercise the public stdio tools on a disposable hosted Joomla site. No mocked browser, filesystem or database.
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory = await mkdtemp(join(tmpdir(), 'playground-platform-'));
const client = new Client({ name: 'platform-integration', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
  env: { ...process.env, JOOMENGINE_ARTIFACT_DIR: directory },
  stderr: 'inherit',
});
const request = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 16 * 60_000 });
async function call(name, args = {}) {
  const reply = await request(name, args);
  const content = reply.content.map(item => item.text).join('');
  assert.notEqual(reply.isError, true, name + ': ' + content.slice(0, 800));
  return JSON.parse(content);
}
async function waitFor(check, label, timeout = 90_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await delay(300);
  }
  throw new Error('Timed out waiting for ' + label);
}

const phpPath = '/mcp-platform-probe.php';
const versionOne = "<?php\nheader('Content-Type: text/plain');\necho 'first version';\n";
const versionTwo = [
  '<?php',
  "header('Content-Type: text/plain');",
  'function platformProbe() {',
  "    $visible = 'breakpoint value';",
  '    $result = strtoupper($visible);',
  '    return $result;',
  '}',
  "if (isset($_GET['mail'])) {",
  "    $sent = mail('tester@example.invalid', 'JoomEngine platform acceptance', 'Captured by the Playground mail API', 'From: qa@example.invalid');",
  "    echo $sent ? 'accepted' : 'rejected';",
  '} else {',
  '    echo platformProbe();',
  '}',
  '',
].join('\n');
const sql = (statement, parameters = []) => call('database_query', { sql: statement, parameters });
const debug = (action, options = {}) => call('debug_control', { action, ...options });

try {
  await client.connect(transport);
  console.log('Starting the hosted blank Joomla deployment');
  await call('workspace_open', { deployId: 'blank' });

  console.log('Verifying revision-aware editor changes and Joomla HTTP readback');
  await call('file_write', { path: phpPath, expectedRevision: null, content: versionOne });
  const original = await call('file_read', { path: phpPath });
  assert.equal(original.content, versionOne);
  await call('file_write', { path: phpPath, expectedRevision: original.revision, content: versionTwo });
  const stale = await request('file_write', { path: phpPath, expectedRevision: original.revision, content: versionOne });
  assert.equal(stale.isError, true, 'An out-of-date editor revision overwrote the new file');
  const final = await call('file_read', { path: phpPath });
  assert.equal(final.content, versionTwo);
  assert.notEqual(final.revision, original.revision);
  assert.equal((await call('site_request', { path: phpPath })).body, 'BREAKPOINT VALUE');

  console.log('Creating and updating a row with prepared SQL against MariaDB');
  await sql('CREATE TABLE mcp_platform_probe (id INT NOT NULL PRIMARY KEY, message VARCHAR(100) NOT NULL)');
  await sql('INSERT INTO mcp_platform_probe (id, message) VALUES (?, ?)', [1, 'before']);
  await sql('UPDATE mcp_platform_probe SET message = ? WHERE id = ?', ['in the backup', 1]);
  const readRow = async () => (await sql('SELECT message FROM mcp_platform_probe WHERE id = ?', [1])).rows[0].message;
  assert.equal(await readRow(), 'in the backup');

  console.log('Pausing a real PHP request and inspecting its call stack and local variable');
  const line = versionTwo.split('\n').findIndex(code => code.includes('$result = strtoupper')) + 1;
  await debug('setBreakpoints', { path: phpPath, breakpoints: [{ line }] });
  await debug('start', { path: phpPath });
  await waitFor(async () => {
    const observation = await debug('state');
    if (observation.request?.error) throw new Error(observation.request.error);
    if (observation.request?.pending === false) throw new Error('The debug request completed without pausing: HTTP ' + observation.request.status);
    return observation.state === 'paused';
  }, 'the PHP breakpoint');
  const frames = await debug('stackTrace');
  assert(frames.length >= 1);
  const frame = frames.find(frame => frame.source.path.endsWith(phpPath) && frame.line === line);
  assert(frame, 'The stack omitted the expected source location');
  const scopes = await debug('scopes', { frameId: frame.id });
  const locals = scopes.find(scope => scope.name === 'Locals');
  assert(locals?.variablesReference, 'phpdbg did not return a local variables reference');
  const variables = await debug('variables', { reference: locals.variablesReference });
  assert(variables.some(variable => variable.name.replace(/^\$/, '') === 'visible' && String(variable.value).includes('breakpoint value')));
  const evaluated = await debug('evaluate', { frameId: frame.id, expression: '$visible' });
  assert.match(String(evaluated.result), /breakpoint value/);
  await debug('continue');
  const finished = await waitFor(async () => {
    const status = await debug('state');
    return status.request?.pending === false && status.request;
  }, 'the completed PHP response');
  assert.equal(finished.error, undefined);
  assert.equal(finished.status, 200);
  await debug('setBreakpoints', { path: phpPath, breakpoints: [] });

  console.log('Sending PHP mail through the site and examining captured MIME bytes');
  const sent = await call('site_request', { path: phpPath + '?mail=1' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body, 'accepted');
  const message = await waitFor(async () => {
    const result = await call('mail_list');
    return result.items.find(item => item.subject === 'JoomEngine platform acceptance' && item.parseStatus === 'ready');
  }, 'the parsed inbox message');
  const details = await call('mail_get', { id: message.id });
  assert.match(details.content, /Captured by the Playground mail API/);
  const eml = await call('mail_get', { id: message.id, format: 'raw' });
  const emlChunk = await call('artifact_read', { id: eml.id });
  const raw = Buffer.from(emlChunk.base64, 'base64').toString('utf8');
  assert.match(raw, /Subject: JoomEngine platform acceptance/i);
  assert.match(raw, /tester@example\.invalid/i);

  console.log('Saving a named backup and moving it into a fresh browser workspace');
  const backup = await call('backup_save', { name: 'MCP platform acceptance' });
  assert((await call('backup_list')).items.some(item => item.id === backup.id && item.size === backup.size));
  const archive = await call('backup_export', { id: backup.id });
  const saved = await call('artifact_save', { id: archive.id, filename: 'platform-proof.zip' });
  assert.equal(saved.sha256, archive.sha256);
  assert.equal((await stat(join(directory, saved.filename))).size, backup.size);
  await call('workspace_close');
  await call('workspace_open', { deployId: 'blank' });
  const uploaded = await call('artifact_load', { filename: saved.filename, kind: 'site' });
  assert.equal(uploaded.sha256, saved.sha256);
  const restored = await call('site_restore', { id: uploaded.id });
  assert.equal(restored.restored, true);
  const restoredFile = await call('file_read', { path: phpPath });
  assert.equal(restoredFile.revision, final.revision);
  assert.equal(restoredFile.content, versionTwo);
  assert.equal((await call('site_request', { path: phpPath })).body, 'BREAKPOINT VALUE');
  assert.equal(await readRow(), 'in the backup');
  console.log('Verified editor conflicts, MariaDB writes, live PHP inspection, captured mail and a restored file/database pair.');
} finally {
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
