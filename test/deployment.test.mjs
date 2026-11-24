import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import test from 'node:test';
import { getDeploymentSchema } from '../dist/browser-catalog.js';
import { deploymentDispatch, deploymentTools } from '../dist/deployment.js';

test('read the deployed schema and its current sections from a subdirectory', async () => {
  const schema = { $defs: { menu: { type: 'object', properties: { path: { type: 'string' } } } } };
  const server = createServer((req, res) => {
    assert.equal(req.url, '/rocket/deploys/document.schema.json');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(schema));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/rocket';
  try {
    assert.deepEqual((await getDeploymentSchema(base)).sections, ['menu']);
    assert.deepEqual((await getDeploymentSchema(base, 'menu')).schema, schema.$defs.menu);
    await assert.rejects(getDeploymentSchema(base, 'constructor'), /Unknown deployment schema/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('discover installed targets with cursor and resolve their live schemas', async () => {
  const runtime = { workspace: { id: 'selected' }, agentModuleBase: 'https://localhost/',
    async discoverConfiguration(target) {
      if (target.kind) return { schema: { properties: { display: { type: 'boolean' } } } };
      return { menus: [{ name: 'Main' }, { name: 'Side' }], configurationTargets: [], ok: true };
    } };
  assert.deepEqual(await deploymentDispatch(runtime, 'deployment_discover', {}), { sections: { menus: 2, configurationTargets: 0 } });
  assert.deepEqual(await deploymentDispatch(runtime, 'deployment_discover', { section: 'menus', limit: 1 }),
    { total: 2, items: [{ name: 'Main' }], nextOffset: 1 });
  assert.deepEqual(await deploymentDispatch(runtime, 'deployment_discover', { section: 'menus', offset: 1 }),
    { total: 2, items: [{ name: 'Side' }], nextOffset: null });
  assert((await deploymentDispatch(runtime, 'deployment_discover', { target: { kind: 'module' } })).schema);
  await assert.rejects(deploymentDispatch(runtime, 'deployment_launch', { replaceWorkspaceId: 'stale' }), /does not match/);
  assert(deploymentTools.every(tool => tool.inputSchema.additionalProperties === false));
});

test('active native owner routes both current-site changes and replacements through the shell', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-owner-'));
  try {
    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'src/app.mjs'), [
      "export const ownerDeployment = (workspaceId, operation, args) => ({ workspaceId, operation, args });",
      "export function getOwnerWorkspace() { return { perform: (operation, args) => ({ operation, args }) }; }"
    ].join('\n'));
    const runtime = { workspace: { id: 'selected' }, agentOwner: {}, agentModuleBase: pathToFileURL(directory + '/').href };
    const cfg = { siteName: 'Edited' };
    assert.deepEqual(await deploymentDispatch(runtime, 'deployment_configure', { configuration: cfg }), { workspaceId: 'selected', operation: 'apply', args: cfg });
    assert.equal((await deploymentDispatch(runtime, 'deployment_clone', { replaceWorkspaceId: 'selected' })).operation, 'clone');
    const opened = await deploymentDispatch(runtime, 'deployment_launch', { replaceWorkspaceId: 'selected', source: { deployId: 'blank' } });
    assert.deepEqual(opened, { operation: 'open', args: { deployId: 'blank', replaceWorkspaceId: 'selected' } });
    await assert.rejects(deploymentDispatch(runtime, 'deployment_launch', { source: { deployId: 'blank' } }), /does not match/);
    runtime.workspace.id = null;
    assert.equal((await deploymentDispatch(runtime, 'deployment_launch', { source: { deployId: 'blank' } })).operation, 'open');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
