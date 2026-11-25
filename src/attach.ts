import type { Workspace } from './browser.js';
import { browserHandlerSource } from './browser-router.js';
import { connectOwner } from './attach-owner.js';
import { debuggerDialogs, withBrowserDialogs, actionDialogs } from './browser-dialogs.js';
import { BrowserDiagnostics } from './browser-diagnostics.js';
import { browserInput, usesNativeInput } from './browser-input.js';
import { cdpTabs, debuggerAddress, discoverTabs, selectedFirefoxTab, selectedTab } from './attach-discovery.js';
import { DebugConnection } from './attach-wire.js';
import { holdTransition, readTransition, startsDatabase } from './firefox-transition.js';
import { setTimeout as delay } from 'node:timers/promises';

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

function expiredOwner(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /realm (?:is null|with id .* not found)|could not find object with given id|cannot find (?:execution )?context with specified id|execution context was destroyed|no such handle/i.test(error.message);
}

async function releaseOwner(dispose: () => Promise<unknown>) {
  try { await dispose(); }
  catch (error) { if (!expiredOwner(error)) throw error; }
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
    const diagnostics = new BrowserDiagnostics(request, wire.on.bind(wire));
    const dialogs = debuggerDialogs(request, wire.on.bind(wire));
    return {
      list: () => discoverTabs(endpoint, base),
      invoke: (operation, args, fn) => operation === 'browser_diagnostics' ? diagnostics.snapshot(invoke,args)
        : withBrowserDialogs(actionDialogs(operation, args), dialogs, () => usesNativeInput(operation)
        ? browserInput(operation, args, invoke, request) : call(fn, [operation, args])),
      async detach() {
        try { await releaseOwner(() => call('function () { this.dispose(); }', [])); }
        finally { wire.close(); }
      },
    };
  } catch (error) { wire.close(); throw error; }
}

async function connectFirefox(endpoint: URL, base: URL, tabId?: string): Promise<RuntimeConnection> {
  async function open() {
    const wire = await DebugConnection.open(endpoint);
    try {
      await wire.request('session.new', { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } } }, 15_000);
      return wire;
    } catch (error) { wire.close(); throw error; }
  }
  let wire: DebugConnection | undefined = await open();
  let detached = false;
  let transitioning = false;
  const stop = new AbortController();
  const current = () => {
    if (!wire || detached) throw new Error('The owner connection is unavailable. Call workspace_close, workspace_list, then workspace_attach and verify the result before retrying a write.');
    return wire;
  };
  async function endSession() {
    const previous = wire;
    wire = undefined;
    try { await previous?.request('session.end', {}, 5_000); }
    finally { previous?.close(); }
  }
  try {
    const tab = await selectedFirefoxTab(wire, base, tabId);
    const { documentId } = tab;
    let context = tab.id;
    const reply = await wire.request('script.callFunction', {
      functionDeclaration: connectOwner.toString(), arguments: [{ type: 'string', value: base.href }],
      target: { realm: tab.realm }, awaitPromise: true, resultOwnership: 'root',
    });
    let handle = checkedBiDi(reply)?.handle;
    if (!handle) throw new Error('Firefox could not retain the selected Playground workspace.');
    let realm = reply.realm;
    const call = async (functionDeclaration: string, values: string[]) => checkedBiDi(await current().request('script.callFunction', {
      functionDeclaration, this: { handle }, arguments: values.map(value => ({ type: 'string', value })),
      target: { realm }, awaitPromise: true,
    }));
    const invoke = async (operation: string, args: Record<string, unknown>, fn = browserHandlerSource(operation)) => {
      const reply = await call('async function(op, input) { return JSON.stringify(await (' + fn + ').call(this, op, JSON.parse(input))); }', [operation, JSON.stringify(args)]);
      return reply.type === 'undefined' ? undefined : JSON.parse(reply.value);
    };
    const request = (method: string, params: Record<string, unknown>) => current().request(method, params);
    const subscribe = (method: string, listener: (event: any) => void) => current().on(method, listener);
    const diagnostics = new BrowserDiagnostics(request, subscribe, context);

    async function transition(operation: string, args: Record<string, unknown>, fn: string) {
      transitioning = true;
      const token = crypto.randomUUID();
      let reclaimed = false;
      const start = 'function(token, id, op, input) { (' + holdTransition.toString() + ').call(this, token, id, () => (' + fn + ').call(this, op, JSON.parse(input))); }';
      try {
        // This is the only invocation of the operation. Later sessions can only reclaim its receipt.
        await call(start, [token, documentId, operation, JSON.stringify(args)]);
        const deadline = Date.now() + 610_000;
        for (;;) {
          await endSession();
          await delay(8_000, undefined, { signal: stop.signal });
          if (Date.now() >= deadline) throw new Error('The owner transition is still pending. Reattach and verify its result before retrying a write.');
          wire = await open();
          if (detached) throw new Error('The owner was detached during its transition.');
          const selected = await selectedFirefoxTab(wire, base, documentId);
          context = selected.id;
          const check = await wire.request('script.callFunction', {
            functionDeclaration: readTransition.toString(), arguments: [{ type: 'string', value: token }],
            target: { realm: selected.realm }, awaitPromise: false, resultOwnership: 'root', serializationOptions: { maxObjectDepth: 0 },
          });
          const receipt = checkedBiDi(check)?.handle;
          if (!receipt) continue;
          const read = (functionDeclaration: string, retain = false) => current().request('script.callFunction', {
            functionDeclaration, this: { handle: receipt }, target: { realm: check.realm },
            awaitPromise: false, resultOwnership: retain ? 'root' : 'none', serializationOptions: { maxObjectDepth: 0 },
          }).then(checkedBiDi);
          const result = JSON.parse((await read('function() { return this.result; }')).value);
          handle = (await read('function() { return this.owner; }', true)).handle;
          if (!handle) throw new Error('Firefox could not retain the original owner after its transition.');
          realm = check.realm;
          await read('function() { this.release(); }');
          await wire.request('script.disown', { handles: [receipt], target: { realm } }).catch(() => {});
          await diagnostics.reconnectFirefox(context);
          reclaimed = true;
          if ('error' in result) throw new Error(result.error);
          return result.value;
        }
      } catch (error) {
        if (reclaimed) throw error;
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error('The Firefox owner transition could not be confirmed. Call workspace_close, workspace_list, then workspace_attach with the intended tabId. Verify the result before retrying a write. ' + cause, { cause: error });
      } finally {
        transitioning = false;
        if (!reclaimed || detached) await endSession().catch(() => {});
      }
    }

    return {
      list: () => discoverTabs(endpoint, base, current()),
      invoke: (operation, args, fn) => {
        if (transitioning) throw new Error('The selected Playground has an operation in progress.');
        if (startsDatabase(operation)) return transition(operation, args, fn);
        const dialogs = debuggerDialogs(request, subscribe, context);
        return operation === 'browser_diagnostics' ? diagnostics.snapshot(invoke,args)
          : withBrowserDialogs(actionDialogs(operation, args), dialogs, () => usesNativeInput(operation)
          ? browserInput(operation, args, invoke, request, context) : invoke(operation, args, fn));
      },
      async detach() {
        try { if (wire && !transitioning) await releaseOwner(() => call('function () { this.dispose(); }', [])); }
        finally { detached = true; stop.abort(); await endSession(); }
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
      try { return await connection.invoke(operation, args, browserHandlerSource(operation)); }
      catch (error) {
        if (expiredOwner(error)) {
          throw new Error(operation + ': The selected owner document changed. Call workspace_close, workspace_list, then workspace_attach with the intended tabId. Verify workspace_info and the result before retrying a write.', { cause: error });
        }
        throw new Error(operation + ': ' + (error instanceof Error ? error.message : String(error)), { cause: error });
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await connection.detach();
    },
  };
}
