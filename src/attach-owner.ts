// Serialized into the selected owner page. All browser-side dependencies come from that Playground release.
export async function connectOwner(base: string) {
  const app = new URL(base);
  if (location.origin !== app.origin || ![app.pathname, app.pathname + 'index.html'].includes(location.pathname)) {
    throw new Error('The selected tab navigated away from Playground.');
  }
  const views = await import(new URL('src/runtime-views.mjs', app).href);
  const selection = views.readActiveRuntimeView({ baseURL: app.href });
  if (!selection) throw new Error('No running site was found in this browser profile. Start or resume the site in Playground.');
  const runtime = await views.attachRuntimeView({ token: selection.token, baseURL: app.href });
  if (!runtime.healthy || runtime.closed) {
    runtime.dispose();
    throw new Error('The selected site is stopped or unavailable. Resume it in the owner window.');
  }

  function control<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error('The owner window is missing the Playground control ' + id + '.');
    return node as T;
  }
  async function wait(check: () => boolean, message: string, timeout: number) {
    const end = Date.now() + timeout;
    while (!check()) {
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
      return { key, value, field: control<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(fields[key]!) };
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
    for (const { key, value, field } of edits) {
      if (field instanceof HTMLInputElement && field.type === 'checkbox') {
        if (typeof value !== 'boolean') throw new Error(key + ' requires true or false.');
        field.checked = value;
      } else if (key === 'languageTags') {
        if (!Array.isArray(value) || !value.every(tag => typeof tag === 'string')) throw new Error('languageTags requires an array of language tags.');
        field.value = value.join(',');
      } else if (field instanceof HTMLTextAreaElement) {
        field.value = JSON.stringify(value);
      } else {
        if (typeof value !== 'string') throw new Error(key + ' requires a string.');
        field.value = value;
      }
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

  runtime.agentRestore = async (archive: Uint8Array<ArrayBuffer>) => {
    const input = control<HTMLInputElement>('upload-site-file');
    if (control<HTMLButtonElement>('upload-site-button').disabled || document.querySelector('dialog[open]')) {
      throw new Error('Finish the active operation or dialog in the Playground owner before restoring.');
    }
    const previous = runtime.workspace.id;
    const files = new DataTransfer();
    files.items.add(new File([archive], 'playground-site.zip', { type: 'application/zip' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    let sawChoice = false;
    await wait(() => {
      // Replacement is independently confirmed by the client in the owner window.
      if (document.querySelector('dialog[open] [data-replace-choice]')) sawChoice = true;
      const feedback = document.getElementById('header-feedback');
      if (feedback && !feedback.hidden && feedback.dataset.error === 'true') throw new Error(feedback.textContent || 'The site archive could not be restored.');
      if (runtime.healthy && runtime.workspace.id !== previous) return true;
      if (sawChoice && !document.querySelector('dialog[open] [data-replace-choice]') && !control<HTMLButtonElement>('upload-site-button').disabled) {
        throw new Error('The owner closed the replacement operation without switching the workspace.');
      }
      return false;
    }, 'The restore is pending or was cancelled in the owner window. Inspect the workspace before retrying.', 575_000);
    return { workspaceId: runtime.workspace.id, restored: true };
  };
  return runtime;
}
