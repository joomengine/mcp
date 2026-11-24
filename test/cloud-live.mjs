// Run against the published Playground or the trusted URL configured for this CLI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const deployments = process.argv.length > 2 ? process.argv.slice(2) : ['blank', 'jcb-mcp'];
const client = new Client({ name: 'cloud-browser-acceptance', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
  stderr: 'inherit',
});

async function call(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 16 * 60_000 });
  const text = reply.content.map(item => item.type === 'text' ? item.text : '').join('');
  assert.notEqual(reply.isError, true, name + ' failed: ' + text);
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(t => t.name);
  for (const name of ['workspace_open', 'browser_navigate', 'joomla_call', 'native_call']) assert(tools.includes(name));
  const catalogue = await call('deployment_catalog');
  assert(catalogue.joomla.some(r => r.version === catalogue.defaults.joomlaVersion));
  assert(catalogue.recipes.some(r => r.id === 'blank'));
  assert(catalogue.recipes.some(r => r.id === 'jcb-mcp'));
  for (const deployId of deployments) {
    assert(['blank', 'jcb-mcp'].includes(deployId));
    console.log('Provisioning ' + deployId);
    const site = await call('workspace_open', { deployId });
    assert.equal(site.healthy, true);
    assert.equal(site.deployId, deployId);
    assert.match(site.joomlaVersion, /^6\./);
    if (deployId === 'blank') {
      const result = await call('joomla_call', { name: 'joomla_action_read',
        arguments: { action: 'content.categories.list', transport: 'api', input: { limit: 1 } } });
      assert.match(JSON.stringify(result), /[Uu]ncategorised/);
    } else {
      const { tools } = await call('native_tools');
      assert(tools.some(tool => tool.name === 'joomla_action_read'));
      const result = await call('native_call', { name: 'joomla_action_read',
        arguments: { action: 'content.categories.list', transport: 'api', input: { limit: 1 } } });
      assert.match(JSON.stringify(result), /[Uu]ncategorised/);
      const catalogue = await call('jcb_list_components');
      assert(Array.isArray(catalogue.components));
    }
    const path = '/agent-proof.html';
    await call('file_write', { path, expectedRevision: null, content:
      '<!doctype html><title>Agent UI proof</title><label>Name<input id="name"></label><label>Project<select id="p"><option>One</option><option>Two</option></select></label>' +
      '<button id="check" onclick="document.querySelector(\'output\').textContent=document.querySelector(\'#name\').value+document.querySelector(\'#p\').value">Check</button><output></output>' });
    const db = await call('database_query', { sql: 'SELECT ? AS proof', parameters: ['ok'] });
    assert.equal(db.rows[0].proof, 'ok');
    const mailbox = await call('mail_list');
    assert(Array.isArray(mailbox.items));
    const served = await call('site_request', { path });
    assert.equal(served.status, 200);
    const saved = await call('file_export', { path });
    const received = await call('artifact_read', { id: saved.id });
    const bytes = Buffer.from(received.base64, 'base64');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), saved.sha256);
    await call('browser_navigate', { path });
    const state = await call('browser_inspect');
    assert.equal(state.title, 'Agent UI proof');
    await call('browser_fill', { selector: state.controls.find(c => c.label === 'Name').ref, value: 'Verified' });
    await call('browser_select', { selector: '#p', value: 'Two' });
    await call('browser_click', { selector: '#check' });
    assert.match((await call('browser_inspect')).text, /VerifiedTwo/);
    await call('workspace_close');
    console.log('Passed ' + deployId + ' workspace, browser controls and live Joomla read.');
  }
} finally { await client.close(); }
