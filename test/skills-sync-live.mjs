// Compare the public stdio API to Git blob identities at the canonical revision it reports.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [cli, checkout] = process.argv.slice(2);
if (!cli || !checkout) throw new Error('Pass the MCP CLI path and a canonical joomengine/skills Git checkout.');
const cache = await mkdtemp(join(tmpdir(), 'verify-joomengine-skills-'));
const client = new Client({ name: 'real-skills-sync', version: '1' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli],
    env: { ...process.env, JOOMENGINE_SKILLS_CACHE: cache, JOOMENGINE_SKILLS_OFFLINE: '0',
      JOOMENGINE_ARTIFACT_DIR: cache, JOOMENGINE_BROWSER_ENDPOINT: 'http://127.0.0.1:9222', JOOMENGINE_COMPOSER_SITE: 'verification' }, stderr: 'inherit' }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
  const head = () => git('ls-remote', '--exit-code', 'origin', 'HEAD').trim().split(/\s+/)[0];
  let status;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = head();
    status = await call('skills_status', { refresh: true });
    assert.equal(status.refreshError, null);
    if (status.revision === before || status.revision === head()) break;
    if (attempt === 2) assert.fail('MCP returned stale Skills revision ' + status.revision + ' for upstream ' + before);
    await delay(7000);
  }
  assert.match(status.revision, /^[0-9a-f]{40}$/);
  assert.equal(status.revision, status.remoteRevision);
  // Fetch by the immutable SHA so an upstream push during this job cannot mix two revisions.
  git('fetch', '--quiet', '--depth=1', 'origin', status.revision);
  const expected = new Map(git('ls-tree', '-r', '-z', status.revision).split('\0').filter(Boolean).map(entry => {
    const separator = entry.indexOf('\t');
    return [entry.slice(separator + 1), entry.slice(0, separator).split(' ')[2]];
  }));
  const checked = new Set();
  let cursor;
  do {
    const page = await client.listResources(cursor ? { cursor } : {});
    for (const resource of page.resources.filter(entry => entry.uri.startsWith('joomengine://skills/'))) {
      const { contents: [item] } = await client.readResource({ uri: resource.uri });
      const bytes = typeof item.text === 'string' ? Buffer.from(item.text) : Buffer.from(item.blob, 'base64');
      const id = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      assert.equal(id, expected.get(resource.name), resource.name);
      assert(!checked.has(resource.name), resource.name);
      checked.add(resource.name);
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(checked.size, expected.size);
  const registry = JSON.parse((await client.readResource({ uri: 'joomengine://skills/registries/skills.json' })).contents[0].text);
  const { prompts } = await client.listPrompts();
  for (const skill of registry.skills) assert(prompts.some(entry => entry.name === 'skill_' + skill.name));
  const { tools } = await client.listTools();
  const routing = await call('skills_capabilities', {});
  assert.equal(routing.revision, status.revision);
  assert.deepEqual(routing.unmappedTools, []);
  const names = routing.capabilities.flatMap(capability => capability.operations.map(tool => tool.name));
  assert.deepEqual(names.sort(), tools.map(tool => tool.name).sort());
  for (const expectedHostTool of ['composer_tools', 'artifact_save', 'workspace_attach']) assert(names.includes(expectedHostTool));
  const guides = new Set(routing.capabilities.flatMap(group => group.guides));
  for (const uri of guides) assert(checked.has(decodeURIComponent(new URL(uri).pathname.slice(1))), uri);
  for (const skill of registry.skills) assert(guides.has('joomengine://skills/' + skill.path), skill.name);
  const agentGuide = await client.readResource({ uri: 'joomengine://skills/testing/playground/agent-connections.md' });
  for (const [, tool] of agentGuide.contents[0].text.matchAll(/`([a-z][a-z0-9]+(?:_[a-z0-9]+)+)`/g)) {
    assert(names.includes(tool), 'Canonical guide refers to an unavailable tool: ' + tool);
  }
  console.log('Mapped ' + names.length + ' actual MCP tools across ' + routing.capabilities.length + ' Skills topics.');
  console.log('Verified ' + checked.size + ' canonical resources and ' + prompts.length + ' prompts at ' + status.revision +
    ' (installed fallback ' + status.bundledRevision + ').');
} finally {
  await client.close();
  await rm(cache, { recursive: true, force: true });
}
