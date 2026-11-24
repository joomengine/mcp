/** A single connection to a loopback debugger. Commands stay internal to this module's caller. */
export class DebugConnection {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(reason: Error): void }>();

  private readonly listeners = new Map<string, Set<(params: any) => void>>();

  on(name: string, handler: (params: any) => void) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(handler);
    this.listeners.set(name, listeners);
    return () => {
      listeners.delete(handler);
      if (!listeners.size) this.listeners.delete(name);
    };
  }

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data);
      if (message.method && message.id === undefined) {
        for (const handler of this.listeners.get(message.method) ?? []) handler(message.params);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.message || message.error.message || String(message.error)));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) request.reject(new Error('The browser connection closed.'));
      this.pending.clear();
    });
  }

  static async open(url: URL): Promise<DebugConnection> {
    const socket = new WebSocket(url.href);
    const connection = new DebugConnection(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Timed out connecting to the selected browser.'));
      }, 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Cannot connect to the local browser debugging endpoint.'));
      }, { once: true });
    });
    return connection;
  }

  request(method: string, params: object = {}, timeoutMs = 610_000): Promise<any> {
    const id = ++this.sequence;
    const commandError = new Error();
    Error.captureStackTrace(commandError, this.request);
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) return reject(new Error('The browser connection is closed.'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for browser command ${method}. Check the workspace before retrying a write.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: reason => {
          clearTimeout(timer);
          commandError.message = method + ': ' + reason.message;
          reject(commandError);
        },
      });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close(): void { this.socket.close(); }
}
