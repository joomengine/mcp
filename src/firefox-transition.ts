// Firefox observes nested Web Workers while its BiDi session is active. The initiating
// document owns the operation and its artifacts when the debugger temporarily releases it.
export function holdTransition(
  this: { dispose(): void },
  token: string,
  documentId: string,
  run: () => Promise<unknown>
) {
  if (Reflect.get(document, Symbol.for('joomengine.mcp.owner-tab-id')) !== documentId) {
    throw new Error('The intended Playground owner document changed before its operation started.');
  }
  const owner = this;
  let result: string | undefined;
  function remove() {
    document.removeEventListener(token, recover);
    window.removeEventListener('pagehide', abandon);
    clearTimeout(start);
    clearTimeout(expiry);
  }
  function recover(event: Event) {
    const query = (event as CustomEvent).detail;
    query.matched = true;
    if (!result) return;
    // The caller receives this handle in the same document. Remove the listener
    // only after BiDi has actually retained its replacement owner handle.
    query.receipt = { owner, result, release: remove };
  }
  function abandon() {
    remove();
    owner.dispose();
  }
  document.addEventListener(token, recover);
  window.addEventListener('pagehide', abandon, { once: true });
  const expiry = setTimeout(abandon, 11 * 60_000);
  const start = setTimeout(async () => {
    try { result = JSON.stringify({ value: await run() }); }
    catch (error) { result = JSON.stringify({ error: error instanceof Error ? error.message : String(error) }); }
  }, 250);
}

export function readTransition(token: string) {
  const detail: { matched?: boolean; receipt?: unknown } = {};
  document.dispatchEvent(new CustomEvent(token, { detail }));
  if (!detail.matched) throw new Error('The selected owner no longer holds the pending transition. Verify its result before retrying a write.');
  return detail.receipt;
}

export const startsDatabase = (operation: string) => [
  'workspace_start', 'workspace_resume', 'workspace_recover', 'workspace_restart',
  'workspace_reset', 'deployment_launch', 'deployment_clone', 'site_restore'
].includes(operation);
