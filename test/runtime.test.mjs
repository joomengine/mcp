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
