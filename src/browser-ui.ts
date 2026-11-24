const selector = { type: 'string', minLength: 1, maxLength: 1024, description: 'A control reference from browser_inspect, or a CSS selector in the active Joomla page.' };
const text = { type: 'string' };
const paging = { type: 'integer', minimum: 0 };
const spec = (name: string, description: string, properties: Record<string, object>, required: string[] = []) => ({
  name, description, inputSchema: { type: 'object' as const, properties, required, additionalProperties: false }
});

export const browserTools = [
  spec('browser_navigate', 'Open a site-relative Joomla URL in this workspace and wait for the actual page.', { path: text }, ['path']),
  spec('browser_inspect', 'Read the visible Joomla page and its form controls. Use offset and textOffset for subsequent pages. Control references apply to the current document.', { offset: paging, textOffset: paging, waitForSelector: text, waitForText: text, timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 } }),
  spec('browser_click', 'Activate a visible Joomla control, including toolbar actions and form submission. Inspect the resulting page before another action.', { selector }, ['selector']),
  spec('browser_fill', 'Replace text in a visible Joomla input, textarea or editable area and emit its input and change events.', { selector, value: text }, ['selector', 'value']),
  spec('browser_select', 'Select a visible Joomla select option by value and emit its selection events.', { selector, value: text }, ['selector', 'value']),
];

// This function runs inside the owning browser. Keep its helpers in its own serialization scope.
export async function browserUiDispatch(runtime: { baseUrl: string; agentFrame?: HTMLIFrameElement }, operation: string, args: Record<string, unknown>) {
  const frame = runtime.agentFrame ?? document.querySelector<HTMLIFrameElement>('iframe#site-frame');
  if (!frame) throw new Error('Open the Joomla site preview in the owning workspace first.');
  const root = new URL(runtime.baseUrl);
  if (!root.pathname.endsWith('/')) root.pathname += '/';
  function isSite(url: URL) {
    return url.origin === root.origin && url.pathname.startsWith(root.pathname);
  }
  function checkedDoc() {
    const doc = frame!.contentDocument;
    if (!doc || !isSite(new URL(doc.URL))) throw new Error('The preview is outside the selected Joomla site. Use browser_navigate to open the site again.');
    return doc;
  }
  if (operation === 'browser_navigate') {
    const path = String(args.path);
    if (path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)) throw new Error('Supply a path within this Joomla site.');
    const url = new URL(path.replace(/^\/+/, ''), root);
    if (!isSite(url)) throw new Error('The requested path leaves the selected Joomla site.');
    if (frame.contentDocument?.URL !== url.href) {
      const current = frame.contentDocument?.URL;
      if (current && current.split('#')[0] === url.href.split('#')[0]) {
        frame.contentWindow!.location.hash = url.hash;
      } else {
        await new Promise<void>((resolve, reject) => {
          const loaded = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { frame.removeEventListener('load', loaded); reject(new Error('Preview navigation is still pending. Inspect the workspace before retrying.')); }, 120_000);
          frame.addEventListener('load', loaded, { once: true });
          frame.src = url.href;
        });
      }
    }
    const doc = checkedDoc();
    return { path: doc.URL.slice(root.href.length), title: doc.title };
  }
  if (operation === 'browser_inspect' && (args.waitForSelector || args.waitForText)) {
    const deadline = Date.now() + Number(args.timeoutMs ?? 30000);
    while (true) {
      const doc = checkedDoc();
      const matchesText = !args.waitForText || doc.body?.innerText.includes(String(args.waitForText));
      const matchesElement = !args.waitForSelector || doc.querySelector(String(args.waitForSelector));
      if (matchesText && matchesElement) break;
      if (Date.now() >= deadline) throw new Error('The requested preview text or selector did not appear.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const doc = checkedDoc();
  const view = doc.defaultView!;
  const stateKey = Symbol.for('joomengine.mcp.ui.controls');
  const stateDoc = doc as Document & { [stateKey]?: { nodes: Map<string, HTMLElement>; ids: WeakMap<HTMLElement, string>; documentId: string; next: number } };
  const controls = stateDoc[stateKey] ??= { nodes: new Map(), ids: new WeakMap(), documentId: crypto.randomUUID().slice(0, 8), next: 1 };
  const visible = (node: HTMLElement) => node.getClientRects().length > 0 && view.getComputedStyle(node).visibility !== 'hidden';
  if (operation === 'browser_inspect') {
    const offset = Number(args.offset ?? 0), textOffset = Number(args.textOffset ?? 0);
    const nodes = [...doc.querySelectorAll<HTMLElement>('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=menuitem],[contenteditable=true]')].filter(visible);
    const content = doc.body?.innerText || '';
    const maxText = 6000;
    const entries = nodes.slice(offset, offset + 80).map(node => {
      let ref = controls.ids.get(node);
      if (!ref) { ref = '@' + controls.documentId + '-' + controls.next++; controls.ids.set(node, ref); controls.nodes.set(ref, node); }
      const control = node as HTMLInputElement;
      const name = node.getAttribute('aria-label') || (control.labels ? [...control.labels].map(l => l.innerText).join(' ') : '')
        || node.innerText || node.getAttribute('title') || node.getAttribute('placeholder') || node.getAttribute('name') || '';
      return { ref, tag: node.localName, type: node.getAttribute('type') || undefined, label: name.trim().slice(0, 180),
        disabled: node.matches(':disabled,[aria-disabled=true]'),
        ...(node.localName === 'select' ? { options: [...(node as HTMLSelectElement).options].slice(0, 80).map(o => ({ value: o.value, label: o.text })) } : {}) };
    });
    return { path: doc.URL.slice(root.href.length), title: doc.title, text: content.slice(textOffset, textOffset + maxText),
      nextTextOffset: content.length > textOffset + maxText ? textOffset + maxText : null,
      controls: entries, nextOffset: nodes.length > offset + entries.length ? offset + entries.length : null };
  }
  const requested = String(args.selector);
  const node = requested.startsWith('@') ? controls.nodes.get(requested) : doc.querySelector<HTMLElement>(requested);
  if (!node?.isConnected || !visible(node) || node.matches(':disabled,[aria-disabled=true]')) throw new Error('This control is absent, hidden or disabled. Inspect the current page.');
  if (operation === 'browser_click') {
    const anchor = node.closest('a[href]') as HTMLAnchorElement | null;
    const target = (node as HTMLButtonElement).form;
    const submit = node.matches('button:not([type]),button[type=submit],input[type=submit],input[type=image]');
    const destination = anchor?.getAttribute('href') || (submit && target ? node.getAttribute('formaction') || target.action : '');
    const destinationTarget = anchor?.target || (submit && target ? node.getAttribute('formtarget') || target.target : '');
    if (destination && (!isSite(new URL(destination, doc.baseURI)) || (destinationTarget && destinationTarget !== '_self'))) {
      throw new Error('This control targets a different site or window.');
    }
    node.click();
  } else if (operation === 'browser_fill') {
    const value = String(args.value);
    if (node.matches('textarea,input:not([type]),input:is([type=text],[type=search],[type=number],[type=email],[type=url],[type=tel],[type=password],[type=date],[type=time],[type=datetime-local],[type=color])')) {
      if ((node as HTMLInputElement).readOnly) throw new Error('The selected control is read-only.');
      (node as HTMLInputElement).value = value;
    } else if (node.isContentEditable) node.textContent = value;
    else throw new Error('Choose a writable text field or editable area.');
    node.dispatchEvent(new view.Event('input', { bubbles: true }));
    node.dispatchEvent(new view.Event('change', { bubbles: true }));
  } else if (operation === 'browser_select') {
    const select = node as HTMLSelectElement;
    if (!select.matches('select') || ![...select.options].some(o => !o.disabled && o.value === args.value)) throw new Error('The control has no selectable option with that value.');
    select.value = String(args.value);
    node.dispatchEvent(new view.Event('input', { bubbles: true }));
    node.dispatchEvent(new view.Event('change', { bubbles: true }));
  } else throw new Error('Unknown browser operation.');
  return { applied: true };
}
