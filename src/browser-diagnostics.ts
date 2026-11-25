type Request = (method: string, params: Record<string, unknown>) => Promise<any>;
type Subscribe = (method: string, handler: (event: any) => void) => () => void;
type Entry = { level: string; message: string; url: string };
type Invoke = (name: string, args: Record<string, any>) => Promise<any>;

/** A bounded, per-connection record of JavaScript errors and console warnings from the selected Joomla site. */
export class BrowserDiagnostics {
  private entries: Entry[] = [];
  private site = '';
  private tracking = false;
  private readonly frames = new Map<string, string>();
  private readonly realms = new Map<number, string>();
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly request: Request,
    private readonly subscribe: Subscribe,
    private firefox?: string
  ) {}

  private record(frame: string | undefined, level: string, text: string) {
    if (!frame || !['error', 'warning', 'warn'].includes(level)) return;
    const url = this.frames.get(frame);
    if (!url || !this.site || !url.startsWith(this.site)) return;
    this.entries.push({
      level: level === 'warn' ? 'warning' : level,
      message: String(text).slice(0, 2000),
      url: new URL(url).pathname.slice(new URL(this.site).pathname.length)
    });
    if (this.entries.length > 250) this.entries.shift();
  }

  private listen(method: string, handler: (event: any) => void) {
    this.listeners.push(this.subscribe(method, handler));
  }

  private async enable() {
    if (this.tracking) return;
    try {
      if (this.firefox) {
        const register = (context: any) => {
          this.frames.set(context.context, context.url);
          for (const child of context.children ?? []) register(child);
        };
        this.listen('browsingContext.contextCreated', register);
        this.listen('browsingContext.navigationStarted', register);
        this.listen('browsingContext.contextDestroyed', (event) => this.frames.delete(event.context));
        this.listen('log.entryAdded', (event) => this.record(event.source?.context, event.level, event.text));
        await this.request('session.subscribe', {
          events: [
            'browsingContext.contextCreated',
            'browsingContext.navigationStarted',
            'browsingContext.contextDestroyed',
            'log.entryAdded'
          ],
          contexts: [this.firefox]
        });
        const { contexts } = await this.request('browsingContext.getTree', { root: this.firefox });
        for (const context of contexts) register(context);
      } else {
        const register = (frame: any) => this.frames.set(frame.id, frame.url);
        this.listen('Page.frameNavigated', (event) => register(event.frame));
        this.listen('Page.frameDetached', (event) => this.frames.delete(event.frameId));
        this.listen('Runtime.executionContextCreated', (event) => {
          const frame = event.context.auxData?.frameId;
          if (frame) this.realms.set(event.context.id, frame);
        });
        this.listen('Runtime.executionContextDestroyed', (event) => this.realms.delete(event.executionContextId));
        this.listen('Runtime.executionContextsCleared', () => this.realms.clear());
        this.listen('Runtime.consoleAPICalled', (event) =>
          this.record(
            this.realms.get(event.executionContextId),
            event.type,
            (event.args ?? []).map((item: any) => item.value ?? item.description ?? item.type).join(' ')
          )
        );
        this.listen('Runtime.exceptionThrown', (event) => {
          const details = event.exceptionDetails;
          this.record(
            this.realms.get(details.executionContextId),
            'error',
            details.exception?.description ?? details.text
          );
        });
        await this.request('Page.enable', {});
        const registerTree = (tree: any) => {
          register(tree.frame);
          for (const child of tree.childFrames ?? []) registerTree(child);
        };
        registerTree((await this.request('Page.getFrameTree', {})).frameTree);
        await this.request('Runtime.enable', {});
      }
      this.tracking = true;
    } catch (error) {
      for (const remove of this.listeners.splice(0)) remove();
      throw error;
    }
  }

  async reconnectFirefox(context: string) {
    for (const remove of this.listeners.splice(0)) remove();
    this.frames.clear();
    this.firefox = context;
    if (this.tracking) {
      // Diagnostic events are unavailable while detached. Subscribe again for
      // the new context; snapshot() retries if this session is still settling.
      this.tracking = false;
      try { await this.enable(); } catch { /* Preserve the completed owner operation's result. */ }
    }
  }

  async snapshot(invoke: Invoke, args: Record<string, unknown>) {
    const { base, ...page } = await invoke('browser_diagnostics_view', args);
    if (this.site !== base || args.clear) this.entries.length = 0;
    this.site = base;
    await this.enable();
    return { ...page, errors: this.entries.slice(), errorCapacity: 250 };
  }
}
