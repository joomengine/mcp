// Exercise the public stdio tools on a disposable hosted Joomla site. No mocked browser, filesystem or database.
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

  console.log('Applying a revision-checked change set, importing binary bytes, finding and undoing the edit');
  const scratch = '/tmp/mcp-file-operations';
  const binary = Uint8Array.from([0, 255, 9, 0, 127]);
  await writeFile(join(directory, 'editor.bin'), binary);
  const binaryArtifact = await call('artifact_load', { filename: 'editor.bin', kind: 'file' });
  await call('file_manage', { action: 'mkdir', path: scratch });
  await call('file_import', { path: scratch + '/editor.bin', id: binaryArtifact.id, expectedRevision: null });
  const before = await call('file_stat', { path: scratch + '/editor.bin', revision: true });
  assert.equal(before.revision, binaryArtifact.sha256);
  const batch = await call('file_batch', { changes: [
    { operation: 'write', path: scratch + '/editor.bin', expectedRevision: before.revision, content: 'A unique editor phrase.' },
    { operation: 'write', path: scratch + '/note.txt', expectedRevision: null, content: 'A second editor document.' },
  ] });
  assert(batch.ok && batch.recoveryId);
  assert((await call('file_history')).items.some(item => item.id === batch.recoveryId));
  const search = await call('file_search', { path: scratch, kind: 'text', query: 'editor', isWordMatch: true, include: ['**/*.txt'], maxResults: 1 });
  assert(search.results.some(item => item.path.endsWith('/note.txt')));
  if (search.cursor) assert((await call('file_search_cancel', { cursor: search.cursor })).cancelled);
  await call('file_manage', { action: 'recover', recoveryId: batch.recoveryId });
  assert.equal((await call('file_stat', { path: scratch + '/editor.bin', revision: true })).revision, before.revision);
  assert.equal(await call('file_stat', { path: scratch + '/note.txt' }), null);

  console.log('Creating and updating a row with prepared SQL against MariaDB');
  await sql('CREATE TABLE mcp_platform_probe (id INT NOT NULL PRIMARY KEY, message VARCHAR(100) NOT NULL)');
  await sql('INSERT INTO mcp_platform_probe (id, message) VALUES (?, ?)', [1, 'before']);
  await sql('UPDATE mcp_platform_probe SET message = ? WHERE id = ?', ['in the backup', 1]);
  const readRow = async () => (await sql('SELECT message FROM mcp_platform_probe WHERE id = ?', [1])).rows[0].message;
  assert.equal(await readRow(), 'in the backup');

  const binaryQuery = await call('database_query', { sql: 'SELECT ? AS payload, CAST(9007199254740993 AS SIGNED) AS id', parameters: [{ base64: 'AP8J' }], binaryColumns: ['payload'] });
  assert.deepEqual(binaryQuery.rows[0], { payload: { base64: 'AP8J' }, id: '9007199254740993' });

  console.log('Importing a SQL file through Adminer’s own form and reading back its data');
  const viewer = await call('database_open');
  assert.equal(viewer.path, '/__adminer/');
  await writeFile(join(directory, 'adminer.sql'), "INSERT INTO mcp_platform_probe (id, message) VALUES (2, 'Adminer import');");
  const script = await call('artifact_load', { filename: 'adminer.sql', kind: 'file' });
  await call('browser_navigate', { path: viewer.path + '?import=' });
  const fileSelector = '#form input[type=file]';
  await call('browser_inspect', { waitForSelector: fileSelector });
  await call('browser_upload', { selector: fileSelector, artifactIds: [script.id] });
  await call('browser_click', { selector: '#form input[type=submit][title="Ctrl+Enter"]' });
  await waitFor(async () => (await sql('SELECT message FROM mcp_platform_probe WHERE id = ?', [2])).rows[0]?.message === 'Adminer import', 'Adminer upload and commit');
  await call('workspace_cache_clear');

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
  const headers = await call('mail_get', { id: message.id, format: 'headers' });
  assert(headers.headers.some(header => header.key === 'subject' && header.value.includes('platform acceptance')));
  const eml = await call('mail_get', { id: message.id, format: 'raw' });
  const emlChunk = await call('artifact_read', { id: eml.id });
  const raw = Buffer.from(emlChunk.base64, 'base64').toString('utf8');
  assert.match(raw, /Subject: JoomEngine platform acceptance/i);
  assert.match(raw, /tester@example\.invalid/i);

  assert.equal((await call('mail_clear')).count, 0);
  assert.equal((await call('mail_list')).total, 0);

  console.log('Saving and updating a named backup, checking revision conflicts, and transferring it to a fresh workspace');
  const backup = await call('backup_save', { name: 'MCP platform acceptance' });
  assert((await call('backup_list')).items.some(item => item.id === backup.id && item.size === backup.size));
  const updated = await call('backup_update', { id: backup.id, expectedRevision: backup.revision, name: 'Updated platform fixture' });
  assert.equal(updated.id, backup.id);
  assert.equal(updated.revision, backup.revision + 1);
  assert.equal(updated.name, 'Updated platform fixture');
  assert.equal((await request('backup_delete', { id: backup.id, expectedRevision: backup.revision })).isError, true);
  const archive = await call('backup_export', { id: backup.id });
  const saved = await call('artifact_save', { id: archive.id, filename: 'platform-proof.zip' });
  assert.equal(saved.sha256, archive.sha256);
  assert.equal((await stat(join(directory, saved.filename))).size, updated.size);
  const copy = await call('backup_import', { id: archive.id, name: 'Imported platform fixture' });
  assert.notEqual(copy.id, backup.id);
  assert.equal(copy.size, updated.size);
  assert.equal((await call('backup_delete', { id: copy.id, expectedRevision: copy.revision })).deleted, true);
  assert.equal((await call('backup_list')).items.some(item => item.id === copy.id), false);
  const storage = await call('storage_list');
  assert(Array.isArray(storage.items));
  assert.equal((await request('storage_remove', { id: 'native:missing' })).isError, true);
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
