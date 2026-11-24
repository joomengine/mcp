import type { Workspace } from './browser.js';
import { browserHandlerSource } from './browser-router.js';
import { connectOwner } from './attach-owner.js';
import { debuggerDialogs, withBrowserDialogs, actionDialogs } from './browser-dialogs.js';
import { browserInput, usesNativeInput } from './browser-input.js';
import { cdpTabs, debuggerAddress, discoverTabs, selectedFirefoxTab, selectedTab } from './attach-discovery.js';
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

function checkedCDP(result: any) {
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result;
}

function checkedBiDi(result: any) {
  if (result.type === 'exception') throw new Error(result.exceptionDetails?.text || 'Playground could not complete the operation.');
  return result.result;
}

interface RuntimeConnection {
  list(): Promise<unknown>;
  invoke(operation: string, args: Record<string, unknown>, fn: string): Promise<unknown>;
  detach(): Promise<void>;
}

// Using the page's debugger socket also supports Qt builds exposing only page targets.
async function connectCDP(endpoint: URL, base: URL, tabId?: string): Promise<RuntimeConnection> {
  const tab = selectedTab(await cdpTabs(endpoint), base, tabId);
  const wire = await DebugConnection.open(debuggerAddress(tab, endpoint));
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
    const invoke = (operation: string, args: Record<string, unknown>) => call(browserHandlerSource(operation), [operation, args]);
    const request = wire.request.bind(wire);
    const dialogs = debuggerDialogs(request, wire.on.bind(wire));
    return {
      list: () => discoverTabs(endpoint, base),
      invoke: (operation, args, fn) => withBrowserDialogs(actionDialogs(operation, args), dialogs, () => usesNativeInput(operation)
        ? browserInput(operation, args, invoke, request) : call(fn, [operation, args])),
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
    await wire.request('session.new', { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } } }, 15_000);
    active = true;
    const tab = await selectedFirefoxTab(wire, base, tabId);
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
    const invoke = async (operation: string, args: Record<string, unknown>, fn = browserHandlerSource(operation)) => {
      const reply = await call('async function(op, input) { return JSON.stringify(await (' + fn + ').call(this, op, JSON.parse(input))); }', [operation, JSON.stringify(args)]);
      return reply.type === 'undefined' ? undefined : JSON.parse(reply.value);
    };
    const request = wire.request.bind(wire);
    const dialogs = debuggerDialogs(request, wire.on.bind(wire), tab.id);
    return {
      list: () => discoverTabs(endpoint, base, wire),
      invoke: (operation, args, fn) => withBrowserDialogs(actionDialogs(operation, args), dialogs, () => usesNativeInput(operation)
        ? browserInput(operation, args, invoke, request, tab.id) : invoke(operation, args, fn)),
      async detach() {
        try { await call('function () { this.dispose(); }', []); }
        finally { await endSession(); }
      },
    };
  } catch (error) { await endSession().catch(() => {}); throw error; }
}

function addresses(options: AttachOptions) {
  const endpoint = localEndpoint(options.endpoint);
  const base = new URL(options.playgroundUrl || 'https://playground.joomengine.org/');
  if (base.username || base.password || base.hash || base.search || !base.pathname.endsWith('/')
      || !(base.protocol === 'https:' || base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('Use the trusted HTTPS Playground base URL, including its trailing slash. Local test servers may use HTTP.');
  }
  return { endpoint, base };
}

export async function listWorkspaceTabs(options: AttachOptions) {
  const { endpoint, base } = addresses(options);
  return discoverTabs(endpoint, base);
}

export async function attachWorkspace(options: AttachOptions): Promise<Workspace> {
  const { endpoint, base } = addresses(options);
  const connection = await (endpoint.protocol === 'http:' ? connectCDP : connectFirefox)(endpoint, base, options.tabId);
  let closed = false;
  return {
    listAttachedTabs: () => connection.list(),
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
