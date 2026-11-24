import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { dispatch, runtimeTools } from '../dist/runtime.js';

const bytes = new TextEncoder().encode('a🌍b');
const runtime = () => ({
  configuration: { deployId: 'jcb-mcp', admin: { password: 'private-admin' }, jcbVersion: '6.2.1' },
  installation: { version: '6.2.0', siteName: 'Test site', administrator: { password: 'private-admin' } },
  workspace: { id: 'test', request: async (op, args) => {
    assert.equal(op, 'read');
    return { path: args.path, bytes, revision: 'file-version' };
  } },
  exportSite: async options => {
    assert.deepEqual(options, { format: 'bundle', includePlaygroundConfiguration: true });
    return { bytes, filename: 'site.zip', mimeType: 'application/zip', metadata: { admin: 'private-admin' } };
  }
});

test('the serialized dispatcher runs using only its supplied runtime and arguments', async () => {
  const invoke = Function('return (' + dispatch.toString() + ')')();
  const status = await invoke(runtime(), 'workspace_info', {});
  assert.equal(status.workspaceId, 'test');
  assert.equal(status.jcbVersion, '6.2.1');
  assert.doesNotMatch(JSON.stringify(status), /private-admin/);
  assert.equal(new Set(runtimeTools.map(tool => tool.name)).size, runtimeTools.length);
});

test('portable exports retain binary bytes in this session and verify chunk progression', async () => {
  const handle = runtime();
  const receipt = await dispatch(handle, 'site_export', {});
  assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(receipt.size, bytes.length);
  assert.doesNotMatch(JSON.stringify(receipt), /private-admin/);
  const first = await dispatch(handle, 'artifact_read', { id: receipt.id, length: 2 });
  const last = await dispatch(handle, 'artifact_read', { id: receipt.id, offset: first.nextOffset });
  assert.equal(last.nextOffset, null);
  assert.deepEqual(Buffer.concat([Buffer.from(first.base64, 'base64'), Buffer.from(last.base64, 'base64')]), Buffer.from(bytes));
  await assert.rejects(dispatch(runtime(), 'artifact_read', { id: receipt.id }), /unavailable/);
  handle.agentRestore = async input => ({ restored: input === bytes });
  assert.deepEqual(await dispatch(handle, 'site_restore', { id: receipt.id }), { restored: true });
  const file = await dispatch(handle, 'file_export', { path: '/tmp/example.zip' });
  await assert.rejects(dispatch(handle, 'site_restore', { id: file.id }), /complete site export/);
  await dispatch(handle, 'artifact_release', { id: receipt.id });
  await assert.rejects(dispatch(handle, 'artifact_read', { id: receipt.id }), /unavailable/);
});

test('UTF-8 read chunks preserve multibyte characters and exact binary ranges', async () => {
  const handle = runtime();
  const first = await dispatch(handle, 'file_read', { path: '/sample.txt', length: 2 });
  const last = await dispatch(handle, 'file_read', { path: '/sample.txt', offset: first.nextOffset });
  assert.equal(first.content + last.content, 'a🌍b');
  const exact = await dispatch(handle, 'file_read', { path: '/sample.txt', length: 2, encoding: 'base64' });
  assert.equal(exact.nextOffset, 2);
  await assert.rejects(dispatch(handle, 'file_read', { path: '/sample.txt', offset: 2 }), /inside a UTF-8/);
});

test('writes pass the editor revision and cannot accidentally replace a newly created file', async () => {
  const handle = runtime();
  handle.workspace.request = async (op, args) => ({ op, ...args });
  const create = await dispatch(handle, 'file_write', { path: '/a.txt', content: 'hello', expectedRevision: null });
  assert.equal(create.op, 'write');
  assert.equal(create.overwrite, false);
  assert.equal(create.expectedRevision, null);
  const update = await dispatch(handle, 'file_write', { path: '/a.txt', content: 'hi', expectedRevision: 'existing-hash' });
  assert.equal(update.overwrite, true);
  assert.equal(update.expectedRevision, 'existing-hash');
  await assert.rejects(dispatch(handle, 'file_write', { path: '/a.txt', content: 'blind write' }), /revision/);
});

test('batch writes load exact binary artifacts, preserve revisions, and carry partial recovery results', async () => {
  const handle = runtime();
  const data = await dispatch(handle, 'file_export', { path: '/sample.bin' });
  const results = { ok: false, results: [{ path: '/copy.bin' }], recoveryId: 'workspace-10',
    failed: { index: 1, operation: 'mkdir', path: '/missing/folder', code: 'ENOENT' } };
  handle.workspace.request = async (operation, options) => {
    assert.equal(operation, 'batch');
    assert.deepEqual(options.changes[0], { operation: 'write', path: '/copy.bin', bytes, expectedRevision: null, overwrite: false });
    return results;
  };
  const reply = await dispatch(handle, 'file_batch', { changes: [
    { operation: 'write', path: '/copy.bin', artifactId: data.id, expectedRevision: null },
    { operation: 'mkdir', path: '/missing/folder' },
  ] });
  assert.equal(reply.isError, true);
  assert.deepEqual(reply.structuredContent, results);
  await assert.rejects(dispatch(handle, 'file_import', { path: '/copy.bin', id: 'missing', expectedRevision: null }), /unavailable/);
  await assert.rejects(dispatch(handle, 'file_batch', { changes: [{ operation: 'write', content: 'x', path: '/x' }] }), /revision/);
});

test('mail headers, debug paging and Adminer URL stay tied to the selected workspace', async () => {
  const messages = [{ id: 'mail-1', raw: bytes, parsed: { headers: [{ key: 'message-id', value: '<id@example.test>' }] } }];
  const handle = { ...runtime(), baseUrl: 'https://playground.example/__site/123/',
    openDatabase: async () => ({ url: 'https://playground.example/__site/123/__adminer/' }),
    debugger: { variables: async (reference, options) => ({ reference, options }) },
    mail: { get: async () => messages[0], clear: async () => { messages.length = 0; return { count: 0 }; } } };
  assert.deepEqual(await dispatch(handle, 'mail_get', { id: 'mail-1', format: 'headers' }), { id: 'mail-1', headers: messages[0].parsed.headers });
  assert.deepEqual(await dispatch(handle, 'mail_clear', {}), { count: 0 });
  assert.deepEqual(await dispatch(handle, 'debug_control', { action: 'variables', reference: 4, start: 60, count: 30 }),
    { reference: 4, options: { start: 60, count: 30 } });
  assert.equal((await dispatch(handle, 'database_open', {})).path, '/__adminer/');
  handle.openDatabase = async () => ({ url: 'https://playground.example/__site/321/__adminer/' });
  await assert.rejects(dispatch(handle, 'database_open', {}), /Invalid database/);
});

test('direct client upload can resume after a lost acknowledgement and only verified bytes become usable', async () => {
  const site = runtime();
  await assert.rejects(dispatch(site, 'artifact_upload_begin', { size: 2, kind: 'file', filename: '../foo' }), /plain artifact filename/);
  const upload = await dispatch(site, 'artifact_upload_begin', { size: 3, kind: 'file', filename: 'x.bin' });
  await dispatch(site, 'artifact_upload_chunk', { id: upload.id, offset: 0, base64: 'AQI=' });
  assert.equal((await dispatch(site, 'artifact_upload_status', upload)).received, 2);
  await assert.rejects(dispatch(site, 'artifact_info', upload), /unavailable/);
  await dispatch(site, 'artifact_upload_chunk', { id: upload.id, offset: 2, base64: 'Aw==' });
  const sha256 = createHash('sha256').update(Buffer.from([1,2,3])).digest('hex');
  await assert.rejects(dispatch(site, 'artifact_upload_finish', { ...upload, sha256: '0'.repeat(64) }), /SHA-256/);
  const receipt = await dispatch(site, 'artifact_upload_finish', { ...upload, sha256 });
  assert.deepEqual(await dispatch(site, 'artifact_upload_finish', { ...upload, sha256 }), receipt);
  assert.equal((await dispatch(site, 'artifact_read', upload)).base64, 'AQID');
});
