import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { connectOwner } from '../dist/attach-owner.js';

test('only fresh sites created by the cloud connection may provision a missing Joomla token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'playground-owner-'));
  const base = pathToFileURL(root + '/');
  const initialLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/app.mjs'), `
      let current = { workspace: { id: 'initial' } };
      export function getOwnerWorkspace() {
        return {
          state: () => ({ workspaceId: current.workspace.id }),
          getRuntime: () => current,
          perform(action) { current = { workspace: { id: action } }; }
        };
      }
    `);
    Object.defineProperty(globalThis, 'location', { configurable: true, value: base });
    const client = await connectOwner(base.href);
    const existing = await connectOwner(base.href, 'existing');
    const fresh = await connectOwner(base.href, 'fresh');
    assert.equal(client.agentCurrent().agentOwned, false);
    assert.equal(existing.agentCurrent().agentOwned, false);
    assert.equal(fresh.agentCurrent().agentOwned, true);
    await existing.agentCurrent().agentOwner.perform('open', {});
    assert.equal(existing.agentCurrent().agentOwned, true);
    assert.equal(client.agentCurrent().agentOwned, false);
    assert.equal(fresh.agentCurrent().agentOwned, false);
    await existing.agentCurrent().agentOwner.perform('resume', {});
    assert.equal(existing.agentCurrent().agentOwned, false);
  } finally {
    if (initialLocation) Object.defineProperty(globalThis, 'location', initialLocation);
    else delete globalThis.location;
    await rm(root, { recursive: true, force: true });
  }
});
