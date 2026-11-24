import { chromium, type JSHandle, type Page } from 'playwright';
import { browserHandlerSource } from './browser-router.js';
import { playgroundBase } from './browser-catalog.js';
export { getDeploymentCatalog } from './browser-catalog.js';

export interface Workspace {
  call(operation: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface CloudOptions {
  baseURL?: string;
  deployId?: string;
  configuration?: Record<string, unknown>;
  executablePath?: string;
  headless?: boolean;
}

// Use compiled functions without exposing a runtime or a JS-evaluation capability to the MCP client.
export async function workspaceFromHandle(page: Page, owner: JSHandle, release: () => Promise<void>): Promise<Workspace> {
  const handlers = new Map<string, Promise<JSHandle>>();
  let closed: Promise<void> | undefined;
  return {
    async call(operation, args) {
      if (closed) throw new Error('This browser workspace is closed.');
      const source = browserHandlerSource(operation);
      let handle = handlers.get(source);
      if (!handle) {
        handle = page.evaluateHandle('(' + source + ')');
        handlers.set(source, handle);
      }
      return page.evaluate(async ({ owner, invoke, operation, args }: any) =>
        invoke.call(owner.agentCurrent?.() ?? owner, operation, args),
      { owner, invoke: await handle, operation, args });
    },
    close() {
      return closed ??= (async () => {
        try { await release(); }
        finally { await Promise.allSettled([owner.dispose(), ...[...handlers.values()].map(async handle => (await handle).dispose())]); }
      })();
    },
  };
}

function deadline<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref();
  })]).finally(() => clearTimeout(timer));
}

/** Boot through the deployed JavaScript API in a fresh, isolated browser profile. */
export async function openCloudWorkspace(options: CloudOptions = {}): Promise<Workspace> {
  const base = playgroundBase(options.baseURL);
  const browser = await chromium.launch({ executablePath: options.executablePath, headless: options.headless ?? true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Rocket handles the service-worker takeover and the controlled isolation reloads.
    // start=0 leaves its deployment idle while the agent provisions its own API handle.
    const setup = new URL(base);
    setup.searchParams.set('start', '0');
    await page.goto(setup.href, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => document.documentElement.dataset.playgroundEnvironment === 'ready',
      undefined, { timeout: 120_000 });
    const owner = await deadline(page.evaluateHandle(async ({ base, deployId, configuration }) => {
      const load = (path: string) => import(new URL(path, base).href);
      const [{ createPlayground }, { parseCatalog }, { loadDeployCatalog, resolveDeployConfiguration }] = await Promise.all([
        load('src/playground.mjs'), load('src/config.mjs'), load('src/deploys.mjs'),
      ]);
      const manifest = new URL('assets/manifest.json', base).href;
      const response = await fetch(manifest);
      if (!response.ok) throw new Error('The Playground manifest returned HTTP ' + response.status + '.');
      const pinned = parseCatalog(await response.json(), { baseURL: manifest });
      const deployCatalog = await loadDeployCatalog();
      const { loadVersionCatalog } = await load('src/version-catalog.mjs');
      const releases = await loadVersionCatalog().catch(() => null);
      const input: Record<string, any> = { ...configuration };
      let catalog = pinned;
      if (releases) {
        const [{ dynamicJoomlaChoices }, { selectCatalogPackage }, { resolveJoomlaVersion }] = await Promise.all([
          load('src/dynamic-selection.mjs'), load('src/dynamic-packages.mjs'), load('src/config.mjs'),
        ]);
        const selected = new Map();
        const exact = pinned.joomla.find((r: any) => r.version === input.joomlaVersion);
        if (exact) selected.set(exact.version, exact);
        const joomla = dynamicJoomlaChoices(pinned, releases.joomla, selected).filter((r: any) => r.php.length);
        const major = pinned.defaults.joomlaVersion.split('.')[0];
        const current = joomla.find((r: any) => r.channel === 'stable' && r.version.split('.')[0] === major);
        catalog = { ...pinned, joomla, defaults: { ...pinned.defaults, joomlaVersion: current?.version ?? pinned.defaults.joomlaVersion } };
        if (!input.joomlaPackage) {
          const requested = input.joomlaVersion ?? catalog.defaults.joomlaVersion;
          // Explicit historical pins are resolved by Playground's normal saved-site rules.
          try { input.joomlaVersion = resolveJoomlaVersion(requested, catalog); } catch { input.joomlaVersion = requested; }
          const entry = joomla.find((r: any) => r.version === input.joomlaVersion);
          if (entry && !pinned.joomla.some((r: any) => r.version === entry.version)) {
            input.joomlaPackage = selectCatalogPackage(entry, { php: entry.php });
          }
        }
      }
      const admin = { name: 'Playground Administrator', username: 'admin', email: 'admin@example.test', password: 'Jp!' + crypto.randomUUID() };
      if (input.jcbVersion && input.jcbVersion !== 'none' && !input.jcbPackage && releases) {
        const reviewed = await resolveDeployConfiguration({ deployId: 'jcb', admin }, { catalog: pinned, deployCatalog, baseURL: base });
        const { pinnedJcbPackages } = await load('src/jcb-selection.mjs');
        const pins = [...pinnedJcbPackages(reviewed.deploy).values()];
        const published = releases.jcb.find((r: any) => r.version === input.jcbVersion);
        if (published && !pins.some(r => r.version === input.jcbVersion)) {
          const { selectCatalogPackage } = await load('src/dynamic-packages.mjs');
          input.jcbPackage = selectCatalogPackage(published);
        }
      }
      const resolved = await resolveDeployConfiguration({
        ...input, deployId, admin, persistence: false, autoLogin: true, storageKey: 'agent-' + crypto.randomUUID(),
      }, { catalog, deployCatalog, baseURL: base });
      let current = await createPlayground(resolved.configuration);
      const frame = document.createElement('iframe');
      frame.title = 'Agent Joomla workspace';
      frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647;background:white';
      frame.referrerPolicy = 'same-origin';
      async function mountPreview(url: string) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { frame.removeEventListener('load', finish); reject(new Error('Timed out opening the Joomla preview.')); }, 120_000);
          frame.addEventListener('load', finish, { once: true });
          frame.src = url;
          if (!frame.isConnected) document.body.append(frame);
        });
      }
      await mountPreview(current.url);
      function wire(site: any, fresh: boolean) {
        site.agentFrame = frame;
        site.agentModuleBase = base;
        site.agentOwned = fresh;
        site.agentCurrent = () => current;
        site.agentRestore = async (bytes: Uint8Array) => {
          const { readSiteExport, configurationForSiteExport } = await load('src/site-import.mjs');
          const siteExport = await readSiteExport(bytes);
          const settings = configurationForSiteExport(siteExport, catalog, { baseURL: base, admin });
          // The browser profile is disposable. Keep the current runtime until the
          // imported one has successfully booted with the archive's own files/database.
          settings.persistence = false;
          const next = await createPlayground(settings, { siteExport });
          wire(next, false);
          const previous = current;
          const artifacts = Symbol.for('joomengine.mcp.artifacts');
          next[artifacts] = previous[artifacts];
          current = next;
          try { await mountPreview(current.url); }
          finally { await previous.close(); }
          return { restored: true, sha256: siteExport.sha256, siteName: settings.siteName, joomlaVersion: settings.joomlaVersion };
        };
      }
      wire(current, true);
      return current;
    }, { base: base.href, deployId: options.deployId ?? 'jcb-mcp', configuration: options.configuration ?? {} }),
    15 * 60_000, 'The isolated browser timed out provisioning the selected deployment.');
    return await workspaceFromHandle(page, owner, async () => {
      try {
        await deadline(owner.evaluate(async (site: any) => (site.agentCurrent?.() ?? site).close()), 30_000,
          'The Joomla runtime did not finish closing.');
      } finally { await browser.close(); }
    });
  } catch (error) {
    await browser.close();
    throw error;
  }
}
