// Execute the released stdio interface against a clean, agent-owned Joomla runtime.
import assert from 'node:assert/strict';
import { exerciseJcb } from './jcb-scenario.mjs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'jcb-release-acceptance', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), stderr: 'inherit'
});

try {
  await client.connect(transport);
  const guide = await client.readResource({ uri: 'joomengine://skills/testing/playground/README.md' });
  assert.match(guide.contents[0].text, /JCB/);
  const workspace = await client.callTool({ name: 'workspace_open', arguments: { deployId: 'jcb-mcp' } }, undefined, { timeout: 16 * 60_000 });
  assert.notEqual(workspace.isError, true, workspace.content[0]?.text);
  await exerciseJcb(client);
  await client.callTool({ name: 'workspace_close', arguments: {} });
} finally {
  await client.close();
}
