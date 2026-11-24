#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPlaygroundServer, type HostOptions } from './server.js';
import { listenHttp } from './http.js';

async function main() {
  const { values } = parseArgs({ options: { http: { type: 'boolean' }, port: { type: 'string', default: '8787' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log('joomengine-playground-mcp [--http --port 8787]\nDefault: MCP over stdio. HTTP: loopback /mcp, bearer from JOOMENGINE_MCP_TOKEN.\nSet JOOMENGINE_BROWSER_ENDPOINT to attach to a client browser or desktop workspace. See README for configuration.');
    return;
  }
  const options: HostOptions = {
    baseURL: process.env.JOOMENGINE_PLAYGROUND_URL,
    executablePath: process.env.JOOMENGINE_CHROMIUM_PATH,
    browserEndpoint: process.env.JOOMENGINE_BROWSER_ENDPOINT,
    artifactDirectory: process.env.JOOMENGINE_ARTIFACT_DIR,
    composerSite: process.env.JOOMENGINE_COMPOSER_SITE,
    profileDirectory: process.env.JOOMENGINE_PROFILE_DIR,
    headless: process.env.JOOMENGINE_HEADED !== '1',
  };
  let close: () => Promise<void>;
  if (values.http) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
    const http = await listenHttp(options, port, process.env.JOOMENGINE_MCP_TOKEN ?? '');
    console.error('Listening on http://127.0.0.1:' + port + '/mcp');
    close = http.close;
  } else {
    const app = createPlaygroundServer(options);
    await app.server.connect(new StdioServerTransport());
    close = async () => { await app.server.close(); await app.dispose(); };
    process.stdin.once('end', () => { void close().catch(console.error); });
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void close().catch(console.error); });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
