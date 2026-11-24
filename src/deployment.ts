// The deep form schema comes from the deployed Playground; third-party extension targets
// are discovered from the running Joomla installation, including their native field types.
const text = { type: 'string', minLength: 1 };
const object = { type: 'object' };
const list = { type: 'array', items: object };
const strings = { type: 'array', items: text };
const bool = { type: 'boolean' };
const version = { ...text, description: 'Select a version from deployment_catalog.' };
export const deploymentFields = {
  siteName: text, initialPath: text, autoLogin: bool, language: text, multilingual: bool, languageTags: strings,
  extensions: list, startupCommands: { type: 'array', items: strings }, languages: list, menus: list,
  template: { type: ['object', 'null'] }, content: { type: ['object', 'null'] }, overlays: list,
  phpVersion: version, phpSettings: object
};
const source = { type: 'object', additionalProperties: false, properties: {
  deployId: { ...text, description: 'Built-in or saved custom recipe ID.' },
  document: { ...object, description: 'Public v1 or full v2/v3 deployment document.' },
  sourceURL: { ...text, description: 'Public hosted deployment JSON URL.' },
  shareURL: { ...text, description: 'A share link from this Playground.' },
  configuration: { ...object, description: 'Deployment field overrides. Consult deployment_schema for the current form definitions.' }
} };
const selector = {
  type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['component', 'record', 'plugin', 'module'] },
    component: text, view: text, element: text, folder: text, clientId: { type: 'integer' }, id: { type: 'integer', minimum: 1 },
    uiLanguage: text
  }
};
const tool = (name: string, description: string, properties: Record<string, object> = {}, required: string[] = []) => ({
  name, description, inputSchema: { type: 'object' as const, properties, required, additionalProperties: false }
});
export const deploymentTools = [
  tool('deployment_schema', 'Read the deployment document schema directly from the configured Playground, before or after opening a site. Choose a section like menu, content, template, overlay, configurationFields or phpSettings.', { section: text }),
  tool('deployment_discover', 'List installed Joomla components, menu layouts, menus, templates and configuration targets. Specify target to obtain its native form schema. With no section, returns collection counts and names.', {
    target: selector, section: { type: 'string', enum: ['menuTypes', 'templates', 'menus', 'configurationTargets'] },
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }
  }),
  tool('deployment_capture', 'Capture a saved Joomla record, module, plugin or component settings as a reusable deployment overlay, including related overlay records. Omit target to capture selected records in the current Joomla administrator page.', { target: selector }),
  tool('deployment_configure', 'Apply changed fields to the running site, preserving other settings. Consult deployment_schema for nested values. PHP version or settings must be applied in a separate call. Joomla, JCB, and administrator changes use a new deployment.', {
    configuration: { type: 'object', properties: deploymentFields, minProperties: 1, additionalProperties: false }
  }, ['configuration']),
  tool('deployment_export', 'Export the current or selected recipe. Public documents omit administrator data. Private format includes the sandbox administrator and complete recipe provenance. Share format returns a reusable public URL.', {
    source, format: { type: 'string', enum: ['public', 'private', 'share'] }, immediate: bool
  }),
  tool('deployment_recipes', 'List named custom deployment recipes in the active browser profile, with IDs and revisions. Built-in presets are listed by deployment_catalog. Read recipe details with deployment_export.'),
  tool('deployment_recipe_save', 'Save an independent named copy of the current recipe, or import from a source. To update an existing recipe, pass its ID and expected revision. Renaming uses the same update with source.deployId set to that recipe.', {
    name: { ...text, maxLength: 100 }, source, id: text, expectedRevision: text
  }, ['name']),
  tool('deployment_recipe_delete', 'Delete a named custom recipe after checking its revision. Existing sites, their files, database and backups remain independent.', {
    id: text, expectedRevision: text
  }, ['id', 'expectedRevision']),
  tool('deployment_clone', 'Copy the current Joomla files and database into an independent installation. Optionally change site settings, upgrade a compatible JCB version, or rotate the sandbox administrator in the copy. The source stays resumable.', {
    replaceWorkspaceId: text, configuration: { type: 'object', additionalProperties: false, properties: {
      ...deploymentFields, hideToolbar: bool, jcbVersion: version, jcbPackage: object, admin: object
    } }
  }, ['replaceWorkspaceId']),
  tool('deployment_launch', 'Use a built-in, saved, shared or imported recipe to start an independent deployment in this owner. Export the current site first if needed. Replacing a running site requires its workspaceId.', {
    source, replaceWorkspaceId: text
  }, ['source', 'replaceWorkspaceId']),
];

type Data = Record<string, any>;

// Serialized into the owner page, so every helper used at runtime belongs in this function.
export async function deploymentDispatch(runtime: Data, operation: string, args: Data) {
  const base = runtime.agentModuleBase || new URL('./', location.href).href;
  const load = (file: string) => import(new URL('src/' + file + '.mjs', base).href);
  const workspaceId = runtime.workspace.id;
  if (operation === 'deployment_discover') {
    const result = await runtime.discoverConfiguration(args.target ?? {});
    if (args.target) return result;
    if (args.section === undefined) return { sections: Object.fromEntries(Object.entries(result)
      .filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, (value as unknown[]).length])) };
    const items = result[args.section];
    if (!Array.isArray(items)) throw new Error('The running site did not return the requested discovery section.');
    const offset = args.offset ?? 0, end = Math.min(offset + (args.limit ?? 30), items.length);
    return { total: items.length, items: items.slice(offset, end), nextOffset: end < items.length ? end : null };
  }
  if (operation === 'deployment_capture') {
    const { administratorCaptureTargets } = await load('deployment-capture');
    const targets = args.target ? [args.target] : administratorCaptureTargets(runtime.agentFrame ?? document.getElementById('site-frame'), runtime.baseUrl);
    if (!targets.length) throw new Error('Open a saved administrator item, select list records, or supply a capture target.');
    const captures = [];
    for (const target of targets) captures.push(await runtime.captureConfiguration(target));
    return { captures };
  }
  const app = (runtime.agentOwner || runtime.isRemoteView) ? await load('app') : {};
  const owner = app.ownerDeployment;
  if (operation === 'deployment_configure') {
    const config = args.configuration;
    if ('phpSettings' in config || 'phpVersion' in config) {
      if (Object.keys(config).some(k => !['phpSettings', 'phpVersion'].includes(k))) throw new Error('Apply PHP settings and version separately from site settings.');
      if (owner) return owner(workspaceId, 'php', config);
      await runtime.updatePhpSettings({ ...runtime.configuration.phpSettings, ...config.phpSettings }, config.phpVersion ?? runtime.configuration.phpVersion);
      return { phpVersion: runtime.configuration.phpVersion, phpSettings: runtime.configuration.phpSettings };
    }
    if (owner) return owner(workspaceId, 'apply', config);
    await runtime.applyConfiguration(config);
    return { applied: true, siteName: runtime.configuration.siteName, language: runtime.configuration.language };
  }
  if (operation === 'deployment_launch' || operation === 'deployment_clone') {
    if (args.replaceWorkspaceId !== workspaceId) throw new Error('The supplied workspaceId does not match the current site.');
    if (!app.getOwnerWorkspace) throw new Error('Use a current Playground owner to start an independent deployment in this window.');
    if (operation === 'deployment_clone') return owner(workspaceId, 'clone', args.configuration ?? {});
    return app.getOwnerWorkspace().perform('open', { ...args.source, replaceWorkspaceId: workspaceId });
  }
  const registry = await load('deployment-registry');
  const key = registry.deploymentRegistryKey(base);
  const read = () => registry.readDeploymentRegistry(localStorage, key);
  async function revision(doc: Data) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(doc)));
    return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  }
  async function describe(entry: Data) { return { id: entry.id, name: entry.title, revision: await revision(entry.document) }; }
  if (operation === 'deployment_recipes') return { recipes: await Promise.all(read().deployments.map(describe)) };
  const config = await load('config');
  async function resolveSource() {
    if (!args.source || Object.keys(args.source).length === 0) {
      const { loadDeployCatalog } = await load('deploys');
      const { deploys } = await loadDeployCatalog();
      const c = runtime.configuration;
      const preset = deploys.find((d: Data) => d.id === c.deployId || d.id === c.sourceDeployId);
      const requirements = c.deploymentRecipe?.requirements ?? (preset ? { ...preset.requirements, joomla: preset.joomla } : undefined);
      return { configuration: c, requirements };
    }
    const supplied = args.source;
    if (supplied.deployId?.startsWith('custom-') && Object.keys(supplied).length === 1) {
      const entry = read().deployments.find((item: Data) => item.id === supplied.deployId);
      if (!entry) throw new Error('Unknown saved custom deployment: ' + supplied.deployId);
      return { configuration: { ...config.parseDeploymentDocument(entry.document, { baseURL: base }), deployId: entry.id }, requirements: entry.document.requirements };
    }
    if (!owner) throw new Error('Open a current Playground owner to resolve a new deployment source.');
    return owner(workspaceId, 'resolve', supplied);
  }
  if (operation === 'deployment_export') {
    const { configuration, requirements } = await resolveSource();
    if (args.format === 'share') return { url: config.createShareURL(base, configuration, { immediate: args.immediate ?? false }) };
    return { document: config.createDeploymentDocument(configuration, { baseURL: base, requirements, includePrivate: args.format === 'private' }) };
  }
  if (!['deployment_recipe_save', 'deployment_recipe_delete'].includes(operation)) throw new Error('Unknown deployment operation.');
  if (Boolean(args.id) !== Boolean(args.expectedRevision)) throw new Error('Supply both id and expectedRevision to change an existing recipe.');
  const prepared = operation === 'deployment_recipe_save' ? await resolveSource() : null;
  const { loadDeployCatalog } = await load('deploys');
  const builtInNames = (await loadDeployCatalog()).deploys.map((item: Data) => item.title);
  return navigator.locks.request(key, async () => {
    const initial = read();
    const entry = args.id && initial.deployments.find((item: Data) => item.id === args.id);
    if (args.id && (!entry || await revision(entry.document) !== args.expectedRevision)) throw new Error('The saved deployment changed. Read the current revision from deployment_recipes.');
    // Re-read after hashing: the native editor may have saved from another window.
    const latest = read();
    if (args.id && JSON.stringify(latest.deployments.find((item: Data) => item.id === args.id)?.document) !== JSON.stringify(entry.document)) throw new Error('The saved deployment changed.');
    if (runtime.workspace.id !== workspaceId) throw new Error('The active workspace changed.');
    let saved;
    if (prepared) {
      const doc = config.createFullDeploymentDocument(prepared.configuration, { baseURL: base, name: args.name, requirements: prepared.requirements });
      saved = registry.saveCustomDeployment(localStorage, key, latest, doc, { id: args.id, builtInNames }).entry;
    } else registry.deleteCustomDeployment(localStorage, key, latest, args.id);
    if (owner) await owner(workspaceId, 'refreshRecipes');
    return saved ? describe(saved) : { deleted: true, id: args.id };
  });
}
