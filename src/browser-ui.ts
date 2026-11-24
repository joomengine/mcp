const selector = {
  type: 'string',
  minLength: 1,
  maxLength: 1024,
  description: 'A control reference from browser_inspect or a CSS selector in the selected surface.'
};
const text = { type: 'string' };
const paging = { type: 'integer', minimum: 0 };
const surface = {
  scope: {
    type: 'string',
    enum: ['site', 'playground', 'code', 'database', 'ai'],
    description:
      'Defaults to site. playground is the owner shell. Open the relevant dock before selecting code, database or ai.'
  },
  framePath: {
    type: 'array',
    maxItems: 8,
    items: selector,
    description:
      'Descend through same-origin site or editor frames using frame selectors or references from browser_inspect.'
  }
};
const dialogResponses = {
  type: 'array',
  minItems: 1,
  maxItems: 8,
  description:
    'Optional expected native JavaScript dialogs for this action, in order. Supply exact dialog text and type. An unexpected prompt is dismissed and reported.',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['alert', 'confirm', 'prompt'] },
      message: text,
      accept: { type: 'boolean' },
      text
    },
    required: ['type', 'message', 'accept'],
    additionalProperties: false
  }
};
const spec = (name: string, description: string, properties: Record<string, object>, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: 'object' as const, properties, required, additionalProperties: false }
});

export const browserTools = [
  spec(
    'browser_navigate',
    'Open a site-relative Joomla URL and wait for the preview. Set reload to refresh the current route.',
    { path: text, reload: { type: 'boolean' } },
    ['path']
  ),
  spec(
    'browser_inspect',
    'Read the selected surface, visible controls and child frames. Paginate using offset and textOffset. References expire when their document changes.',
    {
      ...surface,
      offset: paging,
      textOffset: paging,
      includeValues: {
        type: 'boolean',
        description: 'Read ordinary editable field values (up to 2,000 characters each).'
      },
      waitForSelector: text,
      waitForText: text,
      timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 }
    }
  ),
  spec(
    'browser_click',
    'Activate a visible control in the selected surface, including toolbar, menu, drawer or form actions.',
    { ...surface, selector, dialogResponses },
    ['selector']
  ),
  spec(
    'browser_fill',
    'Replace text in a writable input, textarea or rich-text editor and emit input/change.',
    { ...surface, selector, value: text },
    ['selector', 'value']
  ),
  spec(
    'browser_select',
    'Choose an option by value. Use an array for a multiple-select field.',
    { ...surface, selector, value: { oneOf: [text, { type: 'array', items: text, uniqueItems: true }] } },
    ['selector', 'value']
  ),
  spec(
    'browser_check',
    'Set a visible checkbox or radio button to its intended state.',
    { ...surface, selector, checked: { type: 'boolean' } },
    ['selector', 'checked']
  ),
  spec(
    'browser_options',
    'Search or page through a selection field’s complete options.',
    { ...surface, selector, filter: text, offset: paging, limit: { type: 'integer', minimum: 1, maximum: 250 } },
    ['selector']
  ),
  spec(
    'browser_scroll',
    'Scroll by CSS pixels at a point on the visible site, editor, database or AI panel. Coordinates use browser_screenshot.',
    {
      ...surface,
      x: paging,
      y: paging,
      deltaX: { type: 'integer', minimum: -20000, maximum: 20000 },
      deltaY: { type: 'integer', minimum: -20000, maximum: 20000 }
    },
    ['x', 'y', 'deltaY']
  ),
  spec(
    'browser_upload',
    'Fill a file input with retained workspace artifacts, e.g. an installer, media or Adminer SQL import. Submit the form separately.',
    { ...surface, selector, artifactIds: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } } },
    ['selector', 'artifactIds']
  ),
  spec(
    'browser_screenshot',
    'Capture the visible portion of a selected surface as a PNG. Returns the image and a workspace artifact for delivery.',
    surface
  ),
  spec(
    'browser_pointer',
    'Click at CSS-pixel coordinates relative to the visible surface from browser_screenshot. Supports the visual editor and the isolated AI panel.',
    { ...surface, x: paging, y: paging, dialogResponses },
    ['x', 'y']
  ),
  spec(
    'browser_keyboard',
    'Type text or press a key in the focused control of the selected surface. For isolated AI, click within the panel first.',
    {
      ...surface,
      dialogResponses,
      text: { type: 'string', minLength: 1, maxLength: 8192 },
      key: {
        type: 'string',
        enum: [
          'Enter',
          'Tab',
          'Escape',
          'Backspace',
          'Delete',
          'ArrowDown',
          'ArrowUp',
          'ArrowLeft',
          'ArrowRight',
          'Home',
          'End',
          'Space'
        ]
      }
    }
  )
];

// Serialized into the selected owner. A same-origin document from an unrelated tab or external iframe is never traversed.
export async function browserUiDispatch(runtime: any, operation: string, args: Record<string, any>) {
  const shell = document;
  const root = new URL(runtime.baseUrl || location.href);
  if (!root.pathname.endsWith('/')) root.pathname += '/';
  const isSite = (url: URL) => url.origin === root.origin && url.pathname.startsWith(root.pathname);
  const scope = args.scope || 'site';
  const frames: HTMLIFrameElement[] = [];
  const stateKey = Symbol.for('joomengine.mcp.ui.controls');
  type State = {
    nodes: Map<string, HTMLElement>;
    ids: WeakMap<HTMLElement, string>;
    prefix: string;
    next: number;
  };
  type Page = Document & { [stateKey]?: State };
  function state(doc: Page): State {
    return (doc[stateKey] ??= {
      nodes: new Map(),
      ids: new WeakMap(),
      prefix: crypto.randomUUID().slice(0, 8),
      next: 1
    });
  }
  function lookup(doc: Page, requested: string): HTMLElement | null | undefined {
    return requested.startsWith('@') ? state(doc).nodes.get(requested) : doc.querySelector<HTMLElement>(requested);
  }
  function visible(node: HTMLElement) {
    const style = node.ownerDocument.defaultView!.getComputedStyle(node);
    return node.getClientRects().length > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }
  function preview(): HTMLIFrameElement | null {
    return runtime.agentFrame ?? shell.querySelector('iframe#site-frame');
  }
  function checked(frame: HTMLIFrameElement, allowed: (url: URL) => boolean, blank = false): Document {
    const doc = frame.contentDocument;
    if (!doc || !(allowed(new URL(doc.URL)) || (blank && ['about:blank', 'about:srcdoc'].includes(doc.URL)))) {
      throw new Error(
        'This frame is outside the selected workspace. Return to its current site or use a visible panel.'
      );
    }
    return doc;
  }

  if (operation === 'browser_navigate') {
    const frame = preview();
    if (!frame) throw new Error('Open the Joomla preview first.');
    const path = String(args.path);
    if (path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path))
      throw new Error('Supply a path within this Joomla site.');
    const url = new URL(path.replace(/^\/+/, ''), root);
    if (!isSite(url)) throw new Error('The requested path leaves the selected Joomla site.');
    const current = frame.contentDocument?.URL;
    if (args.reload || current !== url.href) {
      if (!args.reload && current && current.split('#')[0] === url.href.split('#')[0])
        frame.contentWindow!.location.hash = url.hash;
      else
        await new Promise<void>((resolve, reject) => {
          const loaded = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            frame.removeEventListener('load', loaded);
            reject(new Error('Preview navigation is still pending.'));
          }, 120_000);
          frame.addEventListener('load', loaded, { once: true });
          frame.src = url.href;
        });
    }
    const doc = checked(frame, isSite);
    return { path: doc.URL.slice(root.href.length), title: doc.title };
  }
  function locate() {
    frames.length = 0;
    let doc: Page = shell;
    let frame: HTMLIFrameElement | null | undefined;
    if (scope === 'site') frame = preview();
    else if (scope === 'code') frame = shell.querySelector('iframe.jec-workbench-frame');
    else if (scope === 'database')
      frame = [...shell.querySelectorAll('iframe')].find((f) => {
        try {
          const url = new URL(f.src);
          return isSite(url) && url.pathname === new URL('__adminer/', root).pathname;
        } catch {
          return false;
        }
      });
    else if (scope === 'ai') frame = shell.querySelector('iframe.jec-ai-frame');
    if (scope !== 'playground') {
      if (!frame || !visible(frame))
        throw new Error('The selected surface is not visible. Open it in the Playground shell.');
      frames.push(frame);
      if (scope === 'ai') return null;
      doc = checked(
        frame,
        scope === 'code'
          ? (url) => url.origin === location.origin && url.pathname.endsWith('/assets/code/editor.html')
          : isSite
      );
    }
    for (const part of args.framePath ?? []) {
      const nested = lookup(doc, part) as HTMLIFrameElement | null;
      if (!nested || nested.tagName !== 'IFRAME' || !visible(nested))
        throw new Error('A selected child frame is missing or hidden.');
      // The shell has dedicated named scopes for its trust boundaries.
      if (doc === shell) throw new Error('Use the named site, code, database or ai scope for a Playground panel.');
      doc = checked(
        nested,
        (url) =>
          scope === 'code'
            ? url.origin === location.origin && url.pathname.includes('/assets/code/')
            : isSite(url),
        true
      );
      frames.push(nested);
    }
    return doc;
  }

  if (operation === 'browser_inspect' && (args.waitForSelector || args.waitForText)) {
    const end = Date.now() + Number(args.timeoutMs ?? 30000);
    while (true) {
      let doc: Page | null = null;
      try {
        doc = locate();
      } catch (error) {
        if (Date.now() >= end) throw error;
      }
      if (
        doc &&
        (!args.waitForText || doc.body?.innerText.includes(args.waitForText)) &&
        (!args.waitForSelector || doc.querySelector(args.waitForSelector))
      )
        break;
      if (Date.now() >= end) throw new Error('The requested text or selector did not appear.');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const doc = locate();
  if (operation === 'browser_region') {
    let left = 0,
      top = 0,
      right = innerWidth,
      bottom = innerHeight,
      dx = 0,
      dy = 0;
    for (const frame of frames) {
      const rect = frame.getBoundingClientRect();
      dx += rect.left + frame.clientLeft;
      dy += rect.top + frame.clientTop;
      left = Math.max(left, dx);
      top = Math.max(top, dy);
      right = Math.min(right, dx + frame.clientWidth);
      bottom = Math.min(bottom, dy + frame.clientHeight);
    }
    const x = Math.ceil(left),
      y = Math.ceil(top),
      width = Math.floor(right) - x,
      height = Math.floor(bottom) - y;
    if (width < 1 || height < 1) throw new Error('The selected surface is outside the visible viewport.');
    if (
      args.focus &&
      (frames.some((frame) => frame.ownerDocument.activeElement !== frame) ||
        doc?.activeElement?.localName === 'iframe')
    )
      throw new Error('Focus a control inside the selected surface first.');
    if (args.x !== undefined) {
      let hitX = x + args.x,
        hitY = y + args.y;
      if (args.x < 0 || args.y < 0 || args.x >= width || args.y >= height)
        throw new Error('The selected point is outside the visible surface.');
      for (const frame of frames) {
        if (frame.ownerDocument.elementFromPoint(hitX, hitY) !== frame)
          throw new Error('A different panel covers this point.');
        const rect = frame.getBoundingClientRect();
        hitX -= rect.left + frame.clientLeft;
        hitY -= rect.top + frame.clientTop;
      }
      if (doc?.elementFromPoint(hitX, hitY)?.localName === 'iframe')
        throw new Error('Select the child frame or named panel before sending native input.');
    }
    return { x, y, width, height, scrollX: window.scrollX, scrollY: window.scrollY };
  }
  if (!doc) {
    if (operation === 'browser_inspect')
      return {
        scope,
        isolated: true,
        controls: [],
        text: 'This isolated AI panel supports browser_screenshot, browser_pointer and browser_keyboard.'
      };
    throw new Error('Use screenshot, pointer and keyboard on the isolated AI panel.');
  }
  if (operation === 'browser_inspect') {
    const controls = state(doc),
      offset = Number(args.offset ?? 0),
      textOffset = Number(args.textOffset ?? 0);
    const nodes = [
      ...doc.querySelectorAll<HTMLElement>(
        'a[href],button,input:not([type=hidden]),select,textarea,iframe,summary,[role=button],[role=tab],[role=menuitem],[contenteditable]:not([contenteditable=false])'
      )
    ].filter(visible);
    const content = doc.body?.innerText || '',
      maxText = 6000;
    const entries = nodes.slice(offset, offset + 80).map((node) => {
      let ref = controls.ids.get(node);
      if (!ref) {
        ref = '@' + controls.prefix + '-' + controls.next++;
        controls.ids.set(node, ref);
        controls.nodes.set(ref, node);
      }
      const control = node as HTMLInputElement;
      const name =
        node.getAttribute('aria-label') ||
        (control.labels ? [...control.labels].map((l) => l.innerText).join(' ') : '') ||
        node.innerText ||
        node.title ||
        node.getAttribute('placeholder') ||
        node.getAttribute('name') ||
        '';
      const type = node.getAttribute('type') || undefined;
      const showValue =
        args.includeValues &&
        node.matches('textarea,input:not([type=password]):not([type=file])') &&
        !/password|secret|token|credential|api.?key|auth/i.test(
          [node.id, control.name, control.autocomplete, type].join(' ')
        );
      return {
        ref,
        tag: node.localName,
        type,
        id: node.id || undefined,
        name: node.getAttribute('name') || undefined,
        label: name.trim().slice(0, 180),
        ...(showValue ? { value: control.value.slice(0, 2000), valueLength: control.value.length } : {}),
        disabled: node.matches(':disabled,[aria-disabled=true]'),
        ...(['checkbox', 'radio'].includes(type ?? '') ? { checked: control.checked } : {}),
        ...(node.localName === 'select'
          ? {
              optionCount: (node as HTMLSelectElement).options.length,
              options: [...(node as HTMLSelectElement).options].slice(0, 80).map((o) => ({
                value: o.value,
                label: o.text,
                selected: o.selected
              }))
            }
          : {})
      };
    });
    return {
      scope,
      path: isSite(new URL(doc.URL)) ? doc.URL.slice(root.href.length) : new URL(doc.URL).pathname,
      title: doc.title,
      text: content.slice(textOffset, textOffset + maxText),
      nextTextOffset: content.length > textOffset + maxText ? textOffset + maxText : null,
      controls: entries,
      nextOffset: nodes.length > offset + entries.length ? offset + entries.length : null
    };
  }
  const node = lookup(doc, String(args.selector));
  if (!node?.isConnected || !visible(node) || node.matches(':disabled,[aria-disabled=true]'))
    throw new Error('This control is absent, hidden or disabled. Inspect the current page.');
  const view = doc.defaultView!;
  const changed = () => {
    node.dispatchEvent(new view.Event('input', { bubbles: true }));
    node.dispatchEvent(new view.Event('change', { bubbles: true }));
  };
  switch (operation) {
    case 'browser_click': {
      const a = node.closest('a[href]') as HTMLAnchorElement | null;
      const form = (node as HTMLButtonElement).form;
      const submit = node.matches('button:not([type]),button[type=submit],input[type=submit],input[type=image]');
      const dest =
        a?.getAttribute('href') || (submit && form ? node.getAttribute('formaction') || form.action : '');
      const target = a?.target || (submit && form ? node.getAttribute('formtarget') || form.target : '');
      if (dest) {
        const url = new URL(dest, doc.baseURI);
        if (
          !(scope === 'site' || scope === 'database' ? isSite(url) : url.origin === location.origin) ||
          (target && target !== '_self')
        )
          throw new Error('This control targets a different site or window.');
      }
      if (node.matches('input[type=file]'))
        throw new Error('Use browser_upload with workspace artifact IDs for file inputs.');
      node.focus();
      node.click();
      break;
    }
    case 'browser_fill': {
      const control = node as HTMLInputElement;
      if (
        node.matches(
          'textarea,input:not([type]),input:is([type=text],[type=search],[type=number],[type=email],[type=url],[type=tel],[type=password],[type=date],[type=time],[type=datetime-local],[type=color],[type=month],[type=week],[type=range])'
        )
      ) {
        if (control.readOnly) throw new Error('The selected control is read-only.');
        control.value = String(args.value);
      } else if (node.isContentEditable) node.textContent = String(args.value);
      else throw new Error('Choose a writable text field or editable area.');
      changed();
      break;
    }
    case 'browser_options': {
      if (node.localName !== 'select') throw new Error('Choose a selection field.');
      const select = node as HTMLSelectElement,
        query = String(args.filter ?? '').toLowerCase();
      const options = [...select.options].filter(
        (o) => !query || o.value.toLowerCase().includes(query) || o.text.toLowerCase().includes(query)
      );
      const offset = Number(args.offset ?? 0),
        end = Math.min(options.length, offset + Number(args.limit ?? 80));
      return {
        total: options.length,
        nextOffset: end < options.length ? end : null,
        options: options
          .slice(offset, end)
          .map((o) => ({ label: o.text, value: o.value, selected: o.selected, disabled: o.matches(':disabled') }))
      };
    }
    case 'browser_select': {
      const select = node as HTMLSelectElement;
      const values = Array.isArray(args.value) ? args.value : [args.value];
      if (
        node.localName !== 'select' ||
        (!select.multiple && values.length !== 1) ||
        values.some((v) => ![...select.options].some((o) => o.value === v && !o.matches(':disabled')))
      )
        throw new Error('The control has no selectable option with that value.');
      for (const option of select.options) option.selected = values.includes(option.value);
      changed();
      break;
    }
    case 'browser_check': {
      const control = node as HTMLInputElement;
      if (!node.matches('input[type=checkbox],input[type=radio]') || (control.type === 'radio' && !args.checked))
        throw new Error('Choose a checkbox state or select a radio button.');
      if (control.checked !== args.checked) node.click();
      if (control.checked !== args.checked) throw new Error('The page rejected this selection.');
      break;
    }
    case 'browser_upload': {
      const input = node as HTMLInputElement,
        ids = args.artifactIds;
      if (!input.matches('input[type=file]') || !ids.length || (ids.length > 1 && !input.multiple))
        throw new Error('Choose a file input that supports the requested number of files.');
      const transfer = new view.DataTransfer();
      for (const id of ids) {
        const file = runtime[Symbol.for('joomengine.mcp.artifacts')]?.get(id);
        if (!file || file.uploading) throw new Error('A selected artifact is unavailable in this workspace.');
        transfer.items.add(new view.File([file.bytes], file.filename, { type: file.mimeType }));
      }
      input.files = transfer.files;
      changed();
      break;
    }
    default:
      throw new Error('Unknown browser operation.');
  }
  return { applied: true };
}
