import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transferArtifact } from '../dist/artifacts.js';
import { dispatch } from '../dist/runtime.js';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'joomengine-artifacts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function workspace() {
  const handle = {};
  return { handle, call: (name, args) => dispatch(handle, name, args) };
}

test('transfer large and empty artifacts in both directions with end-to-end SHA-256', async t => {
  const dir = await directory(t);
  const site = workspace();
  for (const bytes of [randomBytes(629146), Buffer.alloc(0)]) {
    const original = bytes.length + '.zip';
    const output = 'restored-' + original;
    await writeFile(join(dir, original), bytes);
    const receipt = await transferArtifact(site, dir, 'artifact_load', { filename: original, kind: 'site' });
    assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(receipt.size, bytes.length);
    assert.deepEqual(await transferArtifact(site, dir, 'artifact_save', { id: receipt.id, filename: output }),
      { filename: output, size: bytes.length, sha256: receipt.sha256 });
    assert.deepEqual(await readFile(join(dir, output)), bytes);
    await assert.rejects(transferArtifact(site, dir, 'artifact_save', { id: receipt.id, filename: output }), { code: 'EEXIST' });
    assert.ok((await readdir(dir)).every(name => !name.startsWith('.joomengine-')));
  }
});

test('failed integrity checks never publish partial host files', async t => {
  const dir = await directory(t);
  await writeFile(join(dir, 'site.zip'), 'site');
  const site = workspace();
  const receipt = await transferArtifact(site, dir, 'artifact_load', { filename: 'site.zip', kind: 'site' });
  const corrupt = {
    call: async (name, args) => {
      const result = await site.call(name, args);
      if (name === 'artifact_read') result.base64 = Buffer.from('xxxx').toString('base64');
      return result;
    }
  };
  await assert.rejects(transferArtifact(corrupt, dir, 'artifact_save', { id: receipt.id, filename: 'bad.zip' }), /SHA-256/);
  assert.deepEqual(await readdir(dir), ['site.zip']);
});

test('partial uploads remain inaccessible and are released after a failed host transfer', async t => {
  const dir = await directory(t);
  await writeFile(join(dir, 'part.zip'), randomBytes(16384));
  const site = workspace();
  let id;
  const failed = {
    call: async (name, args) => {
      if (name === 'artifact_upload_chunk') throw new Error('Connection interrupted');
      const result = await site.call(name, args);
      if (name === 'artifact_upload_begin') {
        id = result.id;
        await assert.rejects(site.call('artifact_read', { id }), /unavailable/);
        await assert.rejects(site.call('site_restore', { id }), /unavailable/);
      }
      return result;
    }
  };
  await assert.rejects(transferArtifact(failed, dir, 'artifact_load', { filename: 'part.zip', kind: 'site' }), /interrupted/);
  assert.ok(id);
  assert.deepEqual(await site.call('artifact_release', { id }), { released: false });
});

test('artifact access is limited to regular files directly inside the operator directory', async t => {
  const dir = await directory(t);
  await writeFile(join(dir, 'original.zip'), 'original');
  const site = workspace();
  for (const filename of ['../sample.zip', '/elsewhere', 'sub/path.zip', 'bad\\path', '..']) {
    await assert.rejects(transferArtifact(site, dir, 'artifact_load', { filename, kind: 'site' }), /plain filename/);
  }
  if (process.platform !== 'win32') {
    await symlink(join(dir, 'original.zip'), join(dir, 'via-link.zip'));
    await assert.rejects(transferArtifact(site, dir, 'artifact_load', { filename: 'via-link.zip', kind: 'site' }), /regular file/);
  }
});
