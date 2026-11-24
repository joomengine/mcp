import type { Workspace } from './browser.js';
import { browserHandlerSource } from './browser-router.js';
import { connectOwner } from './attach-owner.js';
import { DebugConnection } from './attach-wire.js';

export interface AttachOptions {
  endpoint: string;
  playgroundUrl?: string;
  tabId?: string;
}

/** Only connect to an explicitly configured debugger on this machine. */
function localEndpoint(address: string): URL {
  const url = new URL(address);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password
      || url.search || url.hash || !url.port
      || !(url.protocol === 'http:' && url.pathname === '/' || url.protocol === 'ws:' && url.pathname === '/session')) {
    throw new Error('Use a loopback HTTP debugger address or a Firefox ws://127.0.0.1:PORT/session address.');
  }
  return url;
}

function selectedTab(tabs: Array<{ id: string; url: string }>, base: URL, id?: string) {
  const candidates = tabs.filter(tab => {
    try {
      const url = new URL(tab.url);
      return url.origin === base.origin && (url.pathname === base.pathname || url.pathname === base.pathname + 'index.html')
        && !url.searchParams.has('view') && (!id || id === tab.id);
    } catch { return false; }
  });
  if (!candidates.length) throw new Error('Open the running Playground owner window at ' + base.href + ' in the selected browser.');
  if (candidates.length > 1) throw new Error('Multiple Playground windows match. Select tabId from: ' + candidates.map(tab => tab.id).join(', '));
  return candidates[0]!;
}

function checkedCDP(result: any) {
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result;
}

function checkedBiDi(result: any) {
  if (result.type === 'exception') throw new Error(result.exceptionDetails?.text || 'Playground could not complete the operation.');
  return result.result;
}

interface RuntimeConnection {
  invoke(operation: string, args: Record<string, unknown>, fn: string): Promise<unknown>;
  detach(): Promise<void>;
}

// Using the page's debugger socket also supports Qt builds exposing only page targets.
async function connectCDP(endpoint: URL, base: URL, tabId?: string): Promise<RuntimeConnection> {
  const discovery = await fetch(new URL('json/list', endpoint), { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!discovery.ok) throw new Error(`Browser target discovery returned HTTP ${discovery.status}.`);
  const tabs = await discovery.json() as Array<{ id: string; type: string; url: string; webSocketDebuggerUrl: string }>;
  const tab = selectedTab(tabs.filter(tab => tab.type === 'page'), base, tabId);
  const address = new URL(tabs.find(item => item.id === tab.id)!.webSocketDebuggerUrl);
  if (address.protocol !== 'ws:' || address.host !== endpoint.host || address.username || address.password) {
    throw new Error('The selected browser returned a different debugger endpoint.');
  }
  const wire = await DebugConnection.open(address);
  try {
    const reply = await wire.request('Runtime.evaluate', {
      expression: '(' + connectOwner.toString() + ')(' + JSON.stringify(base.href) + ')',
      awaitPromise: true,
    });
    const objectId = checkedCDP(reply)?.objectId;
    if (!objectId) throw new Error('The selected window did not return a live Playground workspace.');
    const call = async (functionDeclaration: string, values: unknown[]) => checkedCDP(await wire.request('Runtime.callFunctionOn', {
      objectId, functionDeclaration, arguments: values.map(value => ({ value })),
      awaitPromise: true, returnByValue: true,
    }))?.value;
    return {
      invoke: (operation, args, fn) => call(fn, [operation, args]),
      async detach() {
        try { await call('function () { this.dispose(); }', []); }
        finally { wire.close(); }
      },
    };
  } catch (error) { wire.close(); throw error; }
}

async function connectFirefox(endpoint: URL, base: URL, tabId?: string): Promise<RuntimeConnection> {
  const wire = await DebugConnection.open(endpoint);
  let active = false;
  async function endSession() {
    try { if (active) await wire.request('session.end', {}, 5_000); }
    finally { wire.close(); }
  }
  try {
    await wire.request('session.new', { capabilities: {} }, 15_000);
    active = true;
    const { contexts } = await wire.request('browsingContext.getTree', { maxDepth: 0 });
    const tab = selectedTab(contexts.map((context: { context: string; url: string }) => ({ id: context.context, url: context.url })), base, tabId);
    const reply = await wire.request('script.callFunction', {
      functionDeclaration: connectOwner.toString(), arguments: [{ type: 'string', value: base.href }],
      target: { context: tab.id }, awaitPromise: true, resultOwnership: 'root',
    });
    const handle = checkedBiDi(reply)?.handle;
    if (!handle) throw new Error('Firefox could not retain the selected Playground workspace.');
    // The realm belongs to this document. An unrelated navigation invalidates our handle.
    const target = { realm: reply.realm };
    const call = async (functionDeclaration: string, values: string[]) => checkedBiDi(await wire.request('script.callFunction', {
      functionDeclaration, this: { handle }, arguments: values.map(value => ({ type: 'string', value })),
      target, awaitPromise: true,
    }));
    return {
      async invoke(operation, args, fn) {
        const reply = await call('async function(op, input) { return JSON.stringify(await (' + fn + ').call(this, op, JSON.parse(input))); }', [operation, JSON.stringify(args)]);
        return reply.type === 'undefined' ? undefined : JSON.parse(reply.value);
      },
      async detach() {
        try { await call('function () { this.dispose(); }', []); }
        finally { await endSession(); }
      },
    };
  } catch (error) { await endSession().catch(() => {}); throw error; }
}

export async function attachWorkspace(options: AttachOptions): Promise<Workspace> {
  const endpoint = localEndpoint(options.endpoint);
  const base = new URL(options.playgroundUrl || 'https://playground.joomengine.org/');
  if (base.username || base.password || base.hash || base.search || !base.pathname.endsWith('/')
      || !(base.protocol === 'https:' || base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('Use the trusted HTTPS Playground base URL, including its trailing slash. Local test servers may use HTTP.');
  }
  const connection = await (endpoint.protocol === 'http:' ? connectCDP : connectFirefox)(endpoint, base, options.tabId);
  let closed = false;
  return {
    async call(operation, args) {
      if (closed) throw new Error('This Playground connection was detached.');
      return connection.invoke(operation, args, browserHandlerSource(operation));
    },
    async close() {
      if (closed) return;
      closed = true;
      await connection.detach();
    },
  };
}
