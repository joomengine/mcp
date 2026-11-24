import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { zipSync } from 'fflate';
import { gitAdvertisement, gitEndpoint } from './skills-endpoints.mjs';

test('each initialized session receives one resource and prompt change per observed Skills revision', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'skills-notify-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  process.env.JOOMENGINE_SKILLS_CACHE = cache;
  process.env.JOOMENGINE_SKILLS_OFFLINE = '0';
  let revision = 'a'.repeat(40);
  let lastArchive;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === gitEndpoint) return new Response(gitAdvertisement(revision));
    assert.equal(url, 'https://codeload.github.com/joomengine/skills/zip/' + revision);
    const path = 'workflows/' + revision[0] + '.md';
    const files = { 'SKILL.md': 'Root', 'AGENTS.md': 'Agents', LICENSE: 'License',
      'registries/skills.json': JSON.stringify({ skills: [{ name: 'root', path: 'SKILL.md' }] }),
      'registries/modules.json': '{"modules":[]}',
      'registries/playground-mcp.json': JSON.stringify({ version: 1, capabilities: [
        { id: 'skills', title: 'Skills', tools: ['skills_*'], guides: ['SKILL.md'] },
      ] }),
      [path]: '# Workflow ' + revision[0] };
    lastArchive = path;
    return new Response(zipSync(Object.fromEntries(Object.entries(files).map(
      ([name, body]) => ['skills-' + revision + '/' + name, Buffer.from(body)]))));
  });
  // The server shares its distribution across all transports in this process.
  const { createPlaygroundServer } = await import('../dist/server.js');
  async function connect() {
    const app = createPlaygroundServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'catalogue-test', version: '1' });
    const changes = [];
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { changes.push('resources'); });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => { changes.push('prompts'); });
    await app.server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(() => client.close());
    assert.equal(client.getServerCapabilities().resources.listChanged, true);
    assert.equal(client.getServerCapabilities().prompts.listChanged, true);
    return { app, client, changes };
  }
  const first = await connect();
  const second = await connect();
  const refresh = async client => {
    const result = await client.callTool({ name: 'skills_status', arguments: { refresh: true } });
    assert.equal(JSON.parse(result.content[0].text).revision, revision);
  };

  await refresh(first.client);
  assert.equal(lastArchive, 'workflows/a.md');
  await second.client.listPrompts();
  assert.deepEqual(first.changes, []);
  assert.deepEqual(second.changes, []);

  revision = 'b'.repeat(40);
  await Promise.all([refresh(first.client), refresh(second.client)]);
  await refresh(first.client);
  const expected = ['resources', 'prompts'];
  assert.deepEqual(first.changes, expected);
  assert.deepEqual(second.changes, expected);
  assert((await first.client.listResources()).resources.some(resource => resource.name === 'workflows/b.md'));
  assert((await second.client.listPrompts()).prompts.some(prompt => prompt.name === 'workflow_workflows_b'));

  // Keep the transport open after dispose to detect a leaked session listener.
  await first.app.dispose();
  revision = 'c'.repeat(40);
  await refresh(second.client);
  assert.deepEqual(first.changes, expected);
  assert.deepEqual(second.changes, [...expected, ...expected]);
});
