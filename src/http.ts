import { createServer, type IncomingMessage } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createPlaygroundServer, type HostOptions } from './server.js';

async function readBody(request: IncomingMessage) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new RangeError('Request exceeds 2 MiB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** One operator per listener. Each connected client owns a separate MCP session and browser. */
export async function listenHttp(options: HostOptions, port: number, secret: string) {
  if (!secret) throw new Error('Set JOOMENGINE_MCP_TOKEN before starting the HTTP listener.');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = digest('Bearer ' + secret);
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport, dispose: () => Promise<void>, active: number, used: number }>();
  const listener = createServer(async (req, res) => {
    function reject(status: number, message: string) {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
    }
    if (req.url !== '/mcp') return reject(404, 'Unknown endpoint.');
    const localHost = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i;
    if (!localHost.test(req.headers.host ?? '') || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) return reject(403, 'Unrecognized origin or Host.');
    if (!timingSafeEqual(expected, digest(req.headers.authorization ?? ''))) return reject(401, 'A valid bearer token is required.');
    if (!['GET','POST','DELETE'].includes(req.method ?? '')) return reject(405, 'Method not allowed.');
    const id = req.headers['mcp-session-id'];
    let session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (id !== undefined && !session) return reject(404, 'Unknown MCP session.');
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      if (!session) {
        if (req.method !== 'POST' || !isInitializeRequest(body)) return reject(400, 'Initialize a session before making requests.');
        const app = createPlaygroundServer(options);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: key => { sessions.set(key, entry); },
          onsessionclosed: key => { sessions.delete(key); void app.dispose().catch(console.error); },
        });
        const entry = { transport, dispose: app.dispose, active: 0, used: Date.now() };
        session = entry;
        await app.server.connect(transport);
      }
      session.active++;
      try { await session.transport.handleRequest(req, res, body); }
      finally { session.active--; session.used = Date.now(); }
    } catch (error) {
      reject(error instanceof RangeError ? 413 : error instanceof SyntaxError ? 400 : 500, error instanceof SyntaxError ? 'Invalid JSON.' : 'Unable to handle MCP request.');
    }
  });
  const sweep = setInterval(() => {
    for (const [id, entry] of sessions) if (!entry.active && Date.now() - entry.used > 30 * 60_000) {
      sessions.delete(id); void entry.transport.close().then(entry.dispose).catch(console.error);
    }
  }, 60_000).unref();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
  return {
    address: listener.address(),
    async close() {
      clearInterval(sweep);
      const stopped = new Promise<void>(resolve => listener.close(() => resolve()));
      await Promise.allSettled([...sessions.values()].map(async entry => { await entry.transport.close(); await entry.dispose(); }));
      listener.closeAllConnections();
      await stopped;
    },
  };
}
