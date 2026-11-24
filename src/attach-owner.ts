// Serialized into the selected owner page. All browser-side dependencies come from that Playground release.
export async function connectOwner(base: string, agentOwned = false) {
  const app = new URL(base);
  if (location.origin !== app.origin || ![app.pathname, app.pathname + 'index.html'].includes(location.pathname)) {
    throw new Error('The selected tab navigated away from Playground.');
  }
  // Each MCP connection keeps its artifacts, handles and site-specific grants private.
  // Older deployments expose only the companion API. A minimal test host may omit app.mjs.
  const shell = await import(new URL('src/app.mjs', app).href).catch(() => undefined);
  if (typeof shell?.getOwnerWorkspace === 'function') {
    const owner = shell.getOwnerWorkspace();
    const artifacts = new Map();
    const scopes = new WeakMap<object, Record<PropertyKey, any>>();
    const idle = Object.create(null);
    let disposed = false;
    const created = agentOwned ? owner.getRuntime() : undefined;
    return {
      agentCurrent() {
        if (disposed) throw new Error('The owner was detached.');
        const site = owner.getRuntime();
        const handle = site || idle;
        let scope = scopes.get(handle);
        if (!scope) {
          scope = {
            agentModuleBase: app.href, agentOwner: owner, agentOwned: !!site && created === site,
            [Symbol.for('joomengine.mcp.artifacts')]: artifacts,
            agentRestore: (archive: Uint8Array, replaceWorkspaceId?: string) => owner.perform('restore', {
              archive, replaceWorkspaceId: replaceWorkspaceId ?? (agentOwned ? site?.workspace?.id : undefined),
            })
          };
          scopes.set(handle, scope);
        }
        const overlay = scope;
        return new Proxy(overlay, {
          get(target, prop) {
            if (prop in target) return target[prop];
            if (!site) {
              if (prop === 'workspace') return { id: owner.state().workspaceId };
              if (prop === 'healthy' || prop === 'closed') return false;
              return undefined;
            }
            const value = Reflect.get(site, prop, site);
            return typeof value === 'function' ? value.bind(site) : value;
          }
        });
      },
      dispose() { disposed = true; artifacts.clear(); }
    };
  }
  const views = await import(new URL('src/runtime-views.mjs', app).href);
  const selection = views.readActiveRuntimeView({ baseURL: app.href });
  if (!selection) throw new Error('No running site was found in this browser profile. Start or resume the site in Playground.');
  const runtime = await views.attachRuntimeView({ token: selection.token, baseURL: app.href });
  if (!runtime.healthy || runtime.closed) {
    runtime.dispose();
    throw new Error('The selected site is stopped or unavailable. Resume it in the owner window.');
  }

  // Older Playground builds store a profile-wide discovery pointer. A second
  // owner may have updated it since this tab's preview was opened.
  const selectedFrame = document.querySelector<HTMLIFrameElement>('iframe#site-frame');
  const previewUrl = selectedFrame?.getAttribute('src');
  if (!previewUrl || !new URL(previewUrl, location.href).href.startsWith(runtime.baseUrl)) {
    runtime.dispose();
    throw new Error('The running preview does not match this tab’s selected owner. Re-select the intended owner window.');
  }

  // Fetch Headers are not a structured-clone type. The installed native MCP client passes
  // Headers, while the Playground companion sends each request through BroadcastChannel.
  const ownerRequest = runtime.request.bind(runtime);
  runtime.request = (path: string, init: RequestInit = {}) => ownerRequest(path, {
    ...init, ...(init.headers instanceof Headers ? { headers: [...init.headers.entries()] } : {}),
  });

  function control<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error('The owner window is missing the Playground control ' + id + '.');
    return node as T;
  }
  async function wait(check: () => boolean | Promise<boolean>, message: string, timeout: number) {
    const end = Date.now() + timeout;
    while (!await check()) {
      if (Date.now() >= end) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }

  // Apply through the owner's form so its UI, dirty-editor handling, checkpoints and persistence are updated together.
  runtime.applyConfiguration ??= async (options: Record<string, unknown>) => {
    const fields: Record<string, string> = {
      siteName: 'site-name', initialPath: 'initial-path', language: 'language', autoLogin: 'auto-login',
      multilingual: 'multilingual', languageTags: 'deploy-languages', extensions: 'extensions',
      startupCommands: 'startup-commands', menus: 'deploy-menus', content: 'deploy-content', overlays: 'deploy-overlays',
    };
    const edits = Object.entries(options).map(([key, value]) => {
      if (!Object.hasOwn(fields, key)) throw new Error('The Playground owner form cannot apply ' + key + ' to this live site.');
      const field = control<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(fields[key]!);
      if (field instanceof HTMLInputElement && field.type === 'checkbox') {
        if (typeof value !== 'boolean') throw new Error(key + ' requires true or false.');
        return { field, apply() { field.checked = value; } };
      }
      let formatted: string;
      if (key === 'languageTags') {
        if (!Array.isArray(value) || !value.every(tag => typeof tag === 'string')) throw new Error('languageTags requires an array of language tags.');
        formatted = value.join(',');
      } else if (field instanceof HTMLTextAreaElement) {
        formatted = JSON.stringify(value);
      } else {
        if (typeof value !== 'string') throw new Error(key + ' requires a string.');
        if (field instanceof HTMLSelectElement && ![...field.options].some(option => option.value === value)) {
          throw new Error('The selected deployment does not offer this ' + key + '.');
        }
        formatted = value;
      }
      return { field, apply() { field.value = formatted; } };
    });
    const dialog = control<HTMLDialogElement>('deploy-dialog');
    const edit = control<HTMLButtonElement>('edit-deployment');
    if (dialog.open || edit.disabled) throw new Error('Finish any open deployment edits in the owner window first.');
    const config = runtime.configuration;
    if (control<HTMLInputElement>('storage-key').value !== config.storageKey
        || control<HTMLSelectElement>('deploy').value !== config.deployId) {
      throw new Error('Select the current live deployment in the owner before applying changes.');
    }
    edit.click();
    await wait(() => dialog.open, 'The owner could not open deployment configuration.', 60_000);
    for (const { field, apply } of edits) {
      apply();
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const apply = control<HTMLButtonElement>('apply-deploy');
    if (apply.disabled) throw new Error('The owner cannot apply these changes to this live site.');
    apply.click();
    await wait(() => {
      const error = control('deploy-error');
      if (!error.hidden && error.textContent) throw new Error(error.textContent);
      return !dialog.open;
    }, 'The deployment edit is still pending in the owner window. Inspect its status before retrying.', 575_000);
    // The runtime-view host publishes a snapshot after a completed request.
    await runtime.flush();
  };

  runtime.agentRestore = async (archive: Uint8Array<ArrayBuffer>, replaceWorkspaceId?: string) => {
    const input = control<HTMLInputElement>('upload-site-file');
    if (control<HTMLButtonElement>('upload-site-button').disabled || document.querySelector('dialog[open]')) {
      throw new Error('Finish the active operation or dialog in the Playground owner before restoring.');
    }
    const previous = runtime.workspace.id;
    if (replaceWorkspaceId !== undefined && replaceWorkspaceId !== previous) {
      throw new Error('The workspace changed before it could be restored.');
    }
    const translated = await import(new URL('src/i18n.mjs', app).href);
    const files = new DataTransfer();
    files.items.add(new File([archive], 'playground-site.zip', { type: 'application/zip' }));
    let sawChoice = false;
    let choiceHandled = false;
    let interrupted = false;
    // Another client interaction during import revokes automatic continuation for this upload.
    const interaction = new AbortController();
    const recordInteraction = (event: Event) => {
      if (!event.isTrusted) return;
      interrupted = true;
      if (event.type !== 'click' || !(event.target instanceof Element)) return;
      const accept = event.target.closest('button[data-replace-choice="continue"]');
      const dialog = accept?.closest('dialog[open][data-live-replacement="true"]');
      if (dialog?.querySelector('#live-replacement-title')?.textContent === translated.t('lifecycle.replaceConfirm')) choiceHandled = true;
    };
    document.addEventListener('click', recordInteraction, { capture: true, signal: interaction.signal });
    document.addEventListener('change', recordInteraction, { capture: true, signal: interaction.signal });
    const feedback = document.getElementById('header-feedback');
    const priorError = !feedback?.hidden && feedback?.dataset.error === 'true' ? feedback.textContent : null;
    try {
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(async () => {
        if (runtime.healthy && runtime.workspace.id !== previous) {
          if (!choiceHandled) throw new Error('The owner workspace changed without confirming this restore.');
          return true;
        }
        const dialog = document.querySelector<HTMLDialogElement>('dialog[open][data-live-replacement="true"]');
        if (dialog) {
          sawChoice = true;
          if (replaceWorkspaceId && !choiceHandled && !interrupted
              && dialog.querySelector('#live-replacement-title')?.textContent === translated.t('lifecycle.replaceConfirm')) {
            // A fresh handshake asks the owner for its current ID while this specific prompt is open.
            const current = await views.attachRuntimeView({ token: selection.token, baseURL: app.href });
            try {
              if (current.workspace.id !== replaceWorkspaceId || !current.healthy) {
                throw new Error('The workspace changed before confirming the restore. Review the open owner prompt.');
              }
              if (!interrupted && dialog.isConnected && dialog.open) {
                const accept = dialog.querySelector<HTMLButtonElement>('button[data-replace-choice="continue"]');
                if (!accept || accept.disabled) throw new Error('The owner cannot accept the site replacement.');
                choiceHandled = true;
                accept.click();
              }
            } finally { current.dispose(); }
          }
        }
        if (feedback && !feedback.hidden && feedback.dataset.error === 'true' && feedback.textContent !== priorError) {
          throw new Error(feedback.textContent || 'The site archive could not be restored.');
        }
        const launchError = document.querySelector('#error-view:not([hidden]) #error-message')?.textContent;
        if (launchError) throw new Error(launchError);
        if (sawChoice && !dialog && !control<HTMLButtonElement>('upload-site-button').disabled) {
          throw new Error('The owner closed the replacement operation without switching the workspace.');
        }
        return false;
      }, 'The restore is pending or was cancelled in the owner window. Inspect the workspace before retrying.', 575_000);
    } finally { interaction.abort(); }
    return { workspaceId: runtime.workspace.id, restored: true };
  };
  return runtime;
}
