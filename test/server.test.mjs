import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { listenHttp } from '../dist/http.js';

test('stdio client discovers the workflow and receives useful errors before choosing a workspace', async () => {
  const client = new Client({ name: 'stdio-acceptance', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js'] }));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const required of ['workspace_open', 'database_query', 'file_write', 'native_call', 'joomla_call', 'jcb_compile', 'site_restore']) {
      assert(names.includes(required), required);
    }
    assert.equal(names.includes('workspace_attach'), false);
    assert.equal(names.includes('joomla.api'), false);
    const response = await client.callTool({ name: 'skills_capabilities', arguments: {} });
    assert.equal(response.isError, undefined);
    const map = JSON.parse(response.content[0].text);
    assert.deepEqual(map.unmappedTools, []);
    assert.deepEqual(map.capabilities.flatMap(group => group.operations.map(tool => tool.name)).sort(), [...names].sort());
    assert.equal(map.capabilities.find(group => group.id === 'composer').available, false);
    const noSite = await client.callTool({ name: 'file_read', arguments: { path: '/index.php' } });
    assert.equal(noSite.isError, true);
    assert.match(noSite.content[0].text, /workspace/i);
    const bad = await client.callTool({ name: 'workspace_open', arguments: { executablePath: '/bad' } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /additional properties/);
    const guide = await client.readResource({ uri: 'joomengine://skills/SKILL.md' });
    assert.match(guide.contents[0].text, /JCB/);
    const viaTools = await client.callTool({ name: 'skills_read', arguments: { uri: 'joomengine://skills/SKILL.md' } });
    assert.equal(viaTools.content[0].text, guide.contents[0].text);
    const { prompts } = await client.listPrompts();
    const prompt = await client.getPrompt({ name: prompts[0].name });
    assert(prompt.messages.length);
  } finally { await client.close(); }
});

test('HTTP requires the operator token and exposes the same resources for an initialized session', async () => {
  const http = await listenHttp({}, 0, 'test-owner');
  const url = new URL('http://127.0.0.1:' + http.address.port + '/mcp');
  const client = new Client({ name: 'http-acceptance', version: '1' });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer test-owner' } } });
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Origin: 'https://other.example' } })).status, 403);
    await client.connect(transport);
    assert((await client.listResources()).resources.length);
    await transport.terminateSession();
  } finally { await client.close(); await http.close(); }
});

test('long operations return immediately, retain their result, and can be observed without replaying', async () => {
  const { WorkspaceOperations } = await import('../dist/operations.js');
  const jobs = new WorkspaceOperations();
  let complete;
  const job = jobs.start('test', () => new Promise(resolve => { complete = resolve; }));
  assert.equal(jobs.status(job.id).state, 'running');
  assert.throws(() => jobs.start('new-test', async () => null), /already running/);
  complete({ saved: true });
  await Promise.resolve();
  assert.deepEqual(jobs.status(job.id).result, { saved: true });
  const failed = jobs.start('bad', async () => { throw new Error('expected'); });
  await Promise.resolve();
  assert.equal(jobs.status(failed.id).error, 'expected');
  assert.equal(jobs.status().operations.length, 2);
});
