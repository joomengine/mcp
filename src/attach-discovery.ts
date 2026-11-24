import { DebugConnection } from './attach-wire.js';

interface Tab {
  id: string;
  url: string;
}
interface CDPTab extends Tab {
  type: string;
  webSocketDebuggerUrl: string;
}

export function isOwnerURL(raw: string, base: URL): boolean {
  try {
    const url = new URL(raw);
    return (
      url.origin === base.origin &&
      !url.username &&
      !url.password &&
      !url.searchParams.has('view') &&
      (url.pathname === base.pathname || url.pathname === base.pathname + 'index.html')
    );
  } catch {
    return false;
  }
}

export function selectedTab<T extends Tab>(tabs: T[], base: URL, id?: string): T {
  const candidates = tabs.filter((tab) => isOwnerURL(tab.url, base) && (!id || id === tab.id));
  if (!candidates.length)
    throw new Error('Open the Playground owner window at ' + base.href + ' in the selected browser.');
  if (candidates.length > 1)
    throw new Error('Multiple Playground windows match. Call workspace_list and select a tabId.');
  return candidates[0]!;
}

// Serialized solely on the designated owner. Firefox regenerates protocol context IDs per session.
function identifyOwner(baseHref: string) {
  const url = new URL(location.href),
    base = new URL(baseHref);
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.searchParams.has('view') ||
    (url.pathname !== base.pathname && url.pathname !== base.pathname + 'index.html')
  )
    return null;
  const value = (id: string) =>
    document.querySelector<HTMLInputElement>('#' + id)?.value?.slice(0, 300) || undefined;
  const frame = document.querySelector<HTMLIFrameElement>('#site-frame');
  const key = Symbol.for('joomengine.mcp.owner-tab-id');
  const page = document as Document & { [key]?: string };
  const documentId = (page[key] ??= crypto.randomUUID());
  return JSON.stringify({
    documentId,
    title: document.title.slice(0, 300),
    siteName: value('site-name'),
    storageKey: value('storage-key'),
    deployId: value('deploy'),
    previewLoaded: !!frame?.src.startsWith(new URL('__site/', base).href)
  });
}

export async function cdpTabs(endpoint: URL): Promise<CDPTab[]> {
  const discovery = await fetch(new URL('json/list', endpoint), {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  });
  if (!discovery.ok) throw new Error('Browser target discovery returned HTTP ' + discovery.status + '.');
  const tabs = (await discovery.json()) as CDPTab[];
  return tabs.filter((tab) => tab.type === 'page');
}

export function debuggerAddress(tab: CDPTab, endpoint: URL): URL {
  const address = new URL(tab.webSocketDebuggerUrl);
  if (address.protocol !== 'ws:' || address.host !== endpoint.host || address.username || address.password)
    throw new Error('The selected browser returned a different debugger endpoint.');
  return address;
}

export async function firefoxTabs(wire: DebugConnection): Promise<Tab[]> {
  const { contexts } = await wire.request('browsingContext.getTree', { maxDepth: 0 });
  return contexts.map((item: { context: string; url: string }) => ({ id: item.context, url: item.url }));
}

async function firefoxIdentity(wire: DebugConnection, tab: Tab, base: URL) {
  const reply = await wire.request(
    'script.callFunction',
    {
      target: { context: tab.id },
      awaitPromise: false,
      functionDeclaration: identifyOwner.toString(),
      arguments: [{ type: 'string', value: base.href }]
    },
    10_000
  );
  return reply.type === 'success' && reply.result.type === 'string' ? JSON.parse(reply.result.value) : null;
}

export async function selectedFirefoxTab(wire: DebugConnection, base: URL, id?: string) {
  const tabs = await firefoxTabs(wire);
  if (!id) return selectedTab(tabs, base);
  for (const tab of tabs.filter((t) => isOwnerURL(t.url, base))) {
    const info = await firefoxIdentity(wire, tab, base);
    if (info?.documentId === id) return tab;
  }
  throw new Error('That Playground owner tab is no longer open. Call workspace_list to select its current tabId.');
}

export async function discoverTabs(endpoint: URL, base: URL, activeFirefox?: DebugConnection) {
  let firefox = activeFirefox;
  let ownedSession = false;
  try {
    if (endpoint.protocol === 'ws:' && !firefox) {
      firefox = await DebugConnection.open(endpoint);
      await firefox.request('session.new', { capabilities: {} }, 15_000);
      ownedSession = true;
    }
    const tabs = firefox ? await firefoxTabs(firefox) : await cdpTabs(endpoint);
    const inspected = await Promise.all(
      tabs
        .filter((tab) => isOwnerURL(tab.url, base))
        .map(async (tab) => {
          let json: string | null | undefined;
          if (firefox) {
            const identity = await firefoxIdentity(firefox, tab, base);
            if (!identity) return null;
            const { documentId, ...metadata } = identity;
            return { tabId: documentId, ...metadata };
          } else {
            const wire = await DebugConnection.open(debuggerAddress(tab as CDPTab, endpoint));
            try {
              const reply = await wire.request(
                'Runtime.evaluate',
                {
                  expression: '(' + identifyOwner.toString() + ')(' + JSON.stringify(base.href) + ')',
                  returnByValue: true
                },
                10_000
              );
              json = reply.exceptionDetails ? null : reply.result.value;
            } finally {
              wire.close();
            }
          }
          if (!json) return null;
          const { documentId: _documentId, ...metadata } = JSON.parse(json);
          return { tabId: tab.id, ...metadata };
        })
    );
    return { tabs: inspected.filter(Boolean) };
  } finally {
    if (firefox && !activeFirefox) {
      try {
        if (ownedSession) await firefox.request('session.end', {}, 5_000);
      } finally {
        firefox.close();
      }
    }
  }
}
