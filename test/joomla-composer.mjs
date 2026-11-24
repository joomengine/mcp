import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectComposerProvider } from '../dist/joomla.js';

// Exercise the actual Composer launcher over stdio and HTTPS without a permanent site credential.
const launcher = await realpath(process.argv[2]);
const directory = await mkdtemp(join(tmpdir(), 'joomengine-composer-'));
const key = join(directory, 'key.pem');
const cert = join(directory, 'cert.pem');
const siteAlias = 'integration';
const token = randomUUID();
const sessionId = randomUUID();
const seen = [];
let provider;
let server;
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=JoomEngine MCP local integration', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', key, '-out', cert
  ], { stdio: 'ignore' });
  server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
    try {
      assert.equal(req.url, '/site/api/index.php/v1/joomengine-mcp');
      assert.equal(req.headers['x-joomla-token'], token);
      if (req.method === 'DELETE') {
        assert.equal(req.headers['mcp-session-id'], sessionId);
        seen.push('DELETE');
        res.writeHead(204).end();
        return;
      }
      assert.equal(req.method, 'POST');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { method, id, params } = JSON.parse(Buffer.concat(chunks).toString());
      seen.push(method);
      if (method !== 'initialize') assert.equal(req.headers['mcp-session-id'], sessionId);
      if (method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      let result;
      if (method === 'initialize') {
        res.setHeader('Mcp-Session-Id', sessionId);
        result = { protocolVersion: params.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'native-site-fixture', version: '1' } };
      } else if (method === 'tools/list') {
        result = { tools: [{ name: 'fixture_read', inputSchema: { type: 'object' } }] };
      } else if (method === 'tools/call' && params.name === 'fixture_read') {
        result = { content: [{ type: 'text', text: 'native site response' }] };
      } else if (method === 'resources/list') {
        assert.equal(params.cursor, 'page-two');
        result = { resources: [{ uri: 'fixture://metadata', name: 'Metadata' }] };
      } else if (method === 'resources/templates/list') {
        result = { resourceTemplates: [{ uriTemplate: 'fixture://item/{id}', name: 'Item' }] };
      } else if (method === 'resources/read') {
        result = { contents: [{ uri: params.uri, mimeType: 'application/octet-stream', blob: 'AAE=' }] };
      } else if (method === 'prompts/list') {
        result = { prompts: [{ name: 'review-site', arguments: [{ name: 'component' }] }] };
      } else if (method === 'prompts/get') {
        result = { messages: [{ role: 'user', content: { type: 'text', text: params.arguments.component } }] };
      } else {
        throw new Error('Unexpected method ' + method);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      // Assert against opaque values without printing ephemeral credentials on CI.
      console.error('Composer HTTPS fixture rejected ' + req.method + ' ' + req.url);
      res.writeHead(400).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.JOOMENGINE_MCP_CONFIG_DIR = join(directory, 'sites');
  const base = 'https://127.0.0.1:' + server.address().port + '/site';
  execFileSync(launcher, ['configure', siteAlias, base], { env: { ...process.env, JOOMENGINE_MCP_TOKEN: token } });
  // Scope this self-signed CA to the single test process. Keep cURL peer/hostname verification enabled.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const wrapper = join(directory, 'trusted-client');
  await writeFile(wrapper, '#!/bin/sh\nexec php -d ' + quote('curl.cainfo=' + cert) + ' ' + quote(launcher) + ' "$@"\n', { mode: 0o700 });
  process.env.JOOMENGINE_MCP_COMPOSER_BIN = wrapper;

  provider = await connectComposerProvider(siteAlias);
  assert.equal((await provider.listTools()).tools[0].name, 'fixture_read');
  const result = await provider.callTool('fixture_read', {});
  assert.equal(result.content[0].text, 'native site response');
  const described = (name, args = {}) => provider.describe('provider_' + name, args);
  assert.equal((await described('info')).serverInfo.name, 'native-site-fixture');
  assert.equal((await described('resources', { cursor: 'page-two' })).resources[0].uri, 'fixture://metadata');
  assert.equal((await described('resource_templates')).resourceTemplates[0].uriTemplate, 'fixture://item/{id}');
  assert.equal((await described('resource', { uri: 'fixture://item/7' })).contents[0].blob, 'AAE=');
  assert.equal((await described('prompts')).prompts[0].name, 'review-site');
  assert.equal((await described('prompt', { name: 'review-site', arguments: { component: 'com_demo' } })).messages[0].content.text, 'com_demo');
  await provider.close();
  provider = undefined;
  assert.deepEqual(seen, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'resources/list',
    'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get', 'DELETE']);
  console.log('Composer bridge passed named-site discovery, invocation and session cleanup.');
} finally {
  await provider?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
