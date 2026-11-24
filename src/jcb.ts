/** JCB's browser compiler and the Joomla installer operate on the selected live site. */
type Schema = Record<string, unknown>;
const tool = (name: string, description: string, properties: Record<string, Schema> = {}, required: string[] = []) => ({
  name, description, inputSchema: { type: 'object' as const, properties, required, additionalProperties: false }
});
const identifier = { type: 'string', pattern: '^[a-z][a-z0-9_]*$' };
export const jcbTools = [
  tool('jcb_list_components', 'List component IDs, names, and supported target versions from the authenticated JCB compiler.'),
  tool('jcb_form', 'Describe editable fields on this installation’s native JCB administrator form before using jcb_save_records. Returns its JSON Schema with types, required fields, defaults, choices and relationship metadata where available. Optionally select individual fields.', {
    view: identifier, fields: { type: 'array', minItems: 1, uniqueItems: true, items: identifier },
    values: { type: 'object', description: 'Candidate source fields for a new record. Runs native validation without saving and describes the fields accepted for that input.' }
  }, ['view']),
  tool('jcb_compile', 'Compile a saved JCB component through its installed administrator form. Returns verified ZIP paths and hashes. Use file_export on those paths to retain installers.', {
    componentId: { type: 'integer', minimum: 1 },
    joomlaMajor: { type: 'integer', minimum: 3, description: 'Defaults to the active Joomla major.' }
  }, ['componentId']),
  tool('extension_install', 'Install one extension ZIP on the selected site. Supply an artifact ID from file_export or an HTTPS URL.', {
    artifactId: { type: 'string', minLength: 1 }, url: { type: 'string', minLength: 1 }
  }),
  tool('extension_enable_plugin', 'Enable an installed plugin using the native Joomla plugin administrator model.', { folder: identifier, element: identifier }, ['folder', 'element']),
  tool('jcb_save_records', 'Apply named JCB source records through Playground’s native Joomla form and JCB model overlays. Each record returns its own result and saved identity. Inspect applied and skipped results before retrying.', {
    records: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false,
      properties: { key: { type: 'string' }, view: identifier, guid: { type: 'string' }, match: { type: 'object' }, fields: { type: 'object' }, dependsOn: { type: 'array', items: { type: 'string' } } },
      required: ['key', 'view', 'fields'] } }
  }, ['records']),
  tool('jcb_refresh_tools', 'Refresh native MCP definitions for the selected installed component’s registered webservices APIs.', {
    component: { type: 'string', pattern: '^com_[a-z][a-z0-9_]*$' }
  }, ['component'])
];

// Serialized into both agent-owned and attached browser workspaces. Keep helpers local.
export async function jcbDispatch(runtime: any, operation: string, args: Record<string, unknown>) {
  const site = new URL(runtime.baseUrl);
  const base = new URL(runtime.agentModuleBase ?? '../../../', site);
  const moduleUrl = new URL('src/joomla/index.mjs', base).href;
  if (base.origin !== site.origin) throw new Error('The Joomla provisioning module must share the Playground origin.');
  async function runJoomlaProgram(script: string, payload: Record<string, unknown>) {
    const { buildPhpProgram, parseProvisioningResult } = await import(moduleUrl);
    const source = await buildPhpProgram('customize', { root: runtime.documentRoot, admin: runtime.installation?.administrator, ...payload }, async (name: string) => {
      if (name === 'customize') return script;
      const res = await fetch(new URL('src/joomla/php/common.php', base));
      if (!res.ok) throw new Error('Cannot load Playground’s Joomla bootstrap.');
      return res.text();
    });
    return parseProvisioningResult(await runtime.runPhp(source, { timeoutMs: 600_000 }));
  }
  if (operation === 'extension_install') {
    const { installExtension, installExtensionFromURL } = await import(moduleUrl);
    if (Boolean(args.artifactId) === Boolean(args.url)) throw new Error('Supply exactly one artifactId or HTTPS url.');
    if (args.url) {
      const url = new URL(String(args.url));
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Supply an HTTPS package URL without embedded credentials.');
      await installExtensionFromURL(runtime, url.href);
      return { installed: true };
    }
    const artifact = runtime[Symbol.for('joomengine.mcp.artifacts')]?.get(args.artifactId);
    if (!artifact || artifact.uploading || artifact.kind !== 'file' || !/\.zip$/i.test(artifact.filename) ||
        artifact.bytes?.[0] !== 0x50 || artifact.bytes?.[1] !== 0x4b) throw new Error('Select an extension ZIP retained by file_export.');
    await installExtension(runtime, artifact.bytes);
    return { installed: true, filename: artifact.filename };
  }
  if (operation === 'extension_enable_plugin') {
    for (const key of ['folder', 'element']) {
      if (typeof args[key] !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(args[key] as string)) throw new Error('Invalid Joomla plugin identity.');
    }
    const { applyJoomlaOverlays } = await import(moduleUrl);
    const result = await applyJoomlaOverlays(runtime, [{
      key: `mcp.enable.${args.folder}.${args.element}`, kind: 'plugin', folder: args.folder, element: args.element, fields: { enabled: 1 }
    }], { admin: runtime.installation?.administrator });
    const plugin = result.results[0];
    if (plugin?.status !== 'applied') throw new Error(plugin?.notice || 'Joomla could not enable the selected plugin.');
    return { enabled: true, folder: args.folder, element: args.element, id: plugin.id };
  }
  if (operation === 'jcb_form') {
    if (typeof args.view !== 'string' || !/^[a-z][a-z0-9_]*$/.test(args.view)) throw new Error('Select a JCB administrator view.');
    const { discoverJoomlaConfiguration } = await import(moduleUrl);
    const target = { kind: 'record', component: 'com_componentbuilder', view: args.view };
    const result = args.values === undefined
      ? await discoverJoomlaConfiguration(runtime, { ...target, admin: runtime.installation?.administrator })
      : await runJoomlaProgram(String.raw`<?php
try {
    $root = playgroundRoot($playground);
    [$app, $container, $db] = playgroundApplication($root, true);
    $user = playgroundDataAdministrator($root, $playground, $app, $container, $db);
    playgroundDataLanguage($playground, $app, $container);
    $target = playgroundDataCanonicalTarget($playground['target'], $app);
    $ctx = playgroundDataContext($target, [], $app, $db, $user);
    if (array_intersect(array_keys($playground['values']), ['id', 'guid', 'extension_id', 'asset_id', 'checked_out', 'checked_out_time'])) {
        throw new InvalidArgumentException('Supply source fields for a new JCB record without database identity fields.');
    }
    $values = playgroundDataMerge($ctx['data'], $playground['values']);
    // New-record overlays validate once before checking the writable fields.
    // JCB models can remove conditional fields from their cached native form.
    try {
        playgroundDataValidate($ctx['model'], $values);
        $validation = ['valid' => true];
    } catch (Throwable $error) {
        $validation = ['valid' => false, 'message' => playgroundDataRedact($error->getMessage(), $playground)];
    }
    $form = $ctx['model']->getForm($values, false);
    if (!$form) throw new RuntimeException('The native configuration form is unavailable.');
    $form->bind($values);
    $schema = playgroundDataSchema($form, $ctx['metadata']);
    $fields = (array) $schema['properties'];
    foreach (array_keys($fields) as $name) {
        if (!$form->getField($name) && !$form->getGroup($name, true)) unset($fields[$name]);
    }
    $schema['properties'] = (object) $fields;
    $schema['required'] = array_values(array_intersect($schema['required'], array_keys($fields)));
    ob_clean();
    playgroundFinish(['ok' => true, 'view' => $target['view'], 'schema' => $schema, 'validation' => $validation]);
} catch (Throwable $error) { ob_clean(); playgroundFinish(['ok' => false, 'error' => playgroundDataRedact($error->getMessage(), $playground)]); }`, { target, values: args.values });
    const view = result.view ?? result.configurationTargets[0].view;
    const schema = result.schema;
    const validation = result.validation ? { validation: result.validation } : {};
    if (!args.fields) return { view, schema, ...validation };
    if (!Array.isArray(args.fields) || !args.fields.length) throw new Error('Select at least one field.');
    const properties: Record<string, unknown> = {};
    for (const name of args.fields) {
      if (typeof name !== 'string' || !Object.hasOwn(schema.properties, name)) throw new Error('Unknown field in the installed ' + view + ' form: ' + name);
      properties[name] = schema.properties[name];
    }
    return { view, schema: { ...schema, properties, required: schema.required.filter((name: string) => Object.hasOwn(properties, name)) }, ...validation };
  }
  if (operation === 'jcb_save_records') {
    if (!Array.isArray(args.records) || !args.records.length || args.records.length > 50) throw new Error('Supply between one and fifty JCB records.');
    const { normalizeDeploymentOverlays } = await import(new URL('src/deployment-overlays.mjs', base).href);
    const { applyJoomlaOverlays } = await import(moduleUrl);
    const records = normalizeDeploymentOverlays(args.records.map(r => ({ ...r, kind: 'record', component: 'com_componentbuilder' })));
    const saved = await applyJoomlaOverlays(runtime, records, { admin: runtime.installation?.administrator });
    const skipped = saved.results.filter((item: { status: string }) => item.status !== 'applied');
    if (!skipped.length) return saved;
    const notices = skipped.map((item: { key: string; notice?: string }) => item.notice ?? ('Skipped ' + item.key + '.'));
    return { isError: true, structuredContent: saved, content: [{ type: 'text',
      text: `Applied ${saved.results.length - skipped.length} of ${saved.results.length} JCB records. Read back saved records, correct the errors, and retry only the skipped keys.\n` + notices.join('\n')
    }] };
  }
  if (operation === 'jcb_refresh_tools') {
    if (typeof args.component !== 'string' || !/^com_[a-z][a-z0-9_]{0,95}$/.test(args.component)) throw new Error('Select an installed Joomla component.');
    // Native Operations delegates discovery to a PHP child process. Browser PHP
    // runs the same installed registration and synchronization classes in one request.
    const script = String.raw`<?php
use Joomla\CMS\Application\ApiApplication;
use Joomla\CMS\Event\Application\BeforeApiRouteEvent;
use Joomla\CMS\Extension\ExtensionHelper;
use Joomla\CMS\Factory;
use Joomla\CMS\Plugin\PluginHelper;
use Joomla\CMS\Router\ApiRouter;
use Joomla\Event\DispatcherInterface;
use VDM\Component\JoomEngineMcp\Administrator\Database\JoomlaStore;
use VDM\Component\JoomEngineMcp\Administrator\Installer\Assets;
use VDM\Component\JoomEngineMcp\Administrator\Jcb\ApiRegistry;
use VDM\Component\JoomEngineMcp\Administrator\Jcb\CatalogueSynchronizer;
use VDM\Component\JoomEngineMcp\Administrator\Jcb\GeneratedApiInventory;
use VDM\Component\JoomEngineMcp\Administrator\Jcb\RegistrationObserver;
use VDM\Component\JoomEngineMcp\Administrator\Security\JoomlaPrincipal;
try {
    $root = playgroundRoot($playground);
    [$app, $container, $db] = playgroundApplication($root, true);
    $user = playgroundDataAdministrator($root, $playground, $app, $container, $db);
    $app->bootComponent('com_joomengine_mcp');
    require_once JPATH_ADMINISTRATOR . '/components/com_joomengine_mcp/autoload.php';
    $principal = new JoomlaPrincipal($user);
    $target = $playground['component'];
    if (!$principal->authorise('core.manage', 'com_joomengine_mcp') || !$principal->authorise('core.admin', 'com_joomengine_mcp')
        || !$principal->authorise('mcp.access', 'com_joomengine_mcp') || !$principal->authorise('core.admin', $target)) {
        throw new RuntimeException('The current Joomla identity cannot refresh these definitions.');
    }
    $db->setQuery("SELECT type, element, enabled FROM #__extensions WHERE type = 'component' AND element = " . $db->quote($target));
    $core = array_map(static fn($e) => $e[1], array_filter(ExtensionHelper::getCoreExtensions(), static fn($e) => $e[0] === 'component'));
    $components = GeneratedApiInventory::components($db->loadAssocList(), $core);
    if ($components !== [$target]) throw new RuntimeException('Select an enabled third-party component or JCB.');
    // The native seed updater owns all records under a synchronized provider.
    // A WASM API inventory cannot replace previously imported native CLI targets.
    if ($target === 'com_componentbuilder') {
        $db->setQuery("SELECT COUNT(*) FROM #__joomengine_mcp_target t JOIN #__joomengine_mcp_provider p ON p.id=t.provider_id WHERE p.name='jcb.installed'");
        if ((int) $db->loadResult() > 0) throw new RuntimeException('This JCB catalogue also owns native CLI targets. Refresh this provider on its native Joomla host to preserve them.');
    }
    $api = $container->get(ApiApplication::class);
    $api->loadIdentity($user);
    Factory::$application = $api;
    try {
        $router = new ApiRouter($api);
        $dispatcher = $container->get(DispatcherInterface::class);
        PluginHelper::importPlugin('webservices', null, true, $dispatcher);
        $owners = (new RegistrationObserver())->dispatch($dispatcher,
            new BeforeApiRouteEvent('onBeforeApiRoute', ['router' => $router, 'subject' => $api]),
            static fn() => $router->getRoutes());
        $routes = (new ApiRegistry($router, $owners, $components))->inventory();
        $inventory = GeneratedApiInventory::enrich($routes, JPATH_ADMINISTRATOR . '/components', JPATH_ROOT . '/api/components');
    } finally { Factory::$application = $app; }
    $store = new JoomlaStore($db);
    $changes = (new CatalogueSynchronizer($store, [new Assets($db, $store), 'synchronize']))->synchronize([], $inventory, $principal);
    playgroundFinish(['ok' => true, 'refreshed' => true, 'component' => $target, 'apiRoutes' => $changes['apiRoutes'],
        'unsupportedRoutes' => $changes['unsupportedRoutes'], 'revision' => $changes['revision']]);
} catch (Throwable $error) { playgroundFinish(['ok' => false, 'error' => $error->getMessage()]); }`;
    return runJoomlaProgram(script, { component: args.component });
  }
  if (operation !== 'jcb_list_components' && operation !== 'jcb_compile') throw new Error('Unknown JCB operation.');
  const route = 'administrator/index.php?option=com_componentbuilder&view=compiler';
  function localPath(value: URL) {
    if (value.origin !== site.origin || !value.pathname.startsWith(site.pathname) || value.username || value.password) {
      throw new Error('JCB returned a URL outside the selected site.');
    }
    return value.pathname.slice(site.pathname.length) + value.search;
  }
  async function page(routeUrl: URL, body?: URLSearchParams) {
    let url = routeUrl;
    let response = await runtime.request(localPath(url), body ? {
      method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeoutMs: 600_000
    } : {});
    for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.status); redirects++) {
      if (body && [307, 308].includes(response.status)) throw new Error('JCB redirected the POST without completing it. Inspect the compiler before retrying.');
      const location = response.headers.get('Location');
      if (!location || redirects >= 8) throw new Error('Invalid Joomla compiler redirect.');
      url = new URL(location, url);
      response = await runtime.request(localPath(url));
      body = undefined;
    }
    if (!response.ok) throw new Error(`JCB compiler request returned HTTP ${response.status}.`);
    return { doc: new DOMParser().parseFromString(await response.text(), 'text/html'), url };
  }
  const compiler = await page(new URL(route, site));
  const form = compiler.doc.querySelector<HTMLFormElement>('form#adminForm');
  if (!form || compiler.doc.querySelector('input[name="passwd"]')) throw new Error('Sign in to Joomla with access to the installed JCB compiler.');
  const component = form.querySelector<HTMLSelectElement>('select#component_id');
  const version = form.querySelector<HTMLSelectElement>('select#joomla_version');
  const components = [...(component?.options ?? [])].filter(o => /^[1-9]\d*$/.test(o.value)).map(o => ({ id: Number(o.value), name: o.label.trim() }));
  const versions = [...(version?.options ?? [])].filter(o => /^\d+$/.test(o.value)).map(o => Number(o.value));
  if (operation === 'jcb_list_components') return { components, joomlaMajors: versions };
  const selected = components.find(item => item.id === args.componentId);
  const major = Number(args.joomlaMajor ?? String(runtime.configuration.joomlaVersion).split('.')[0]);
  if (!component || !version || !selected || !versions.includes(major)) throw new Error('Choose a component ID and target Joomla major from jcb_list_components.');
  const previousTimes = new Map<string, string>();
  for (const link of compiler.doc.querySelectorAll<HTMLAnchorElement>('.com-componentbuilder-compiler-success a[href]')) {
    const url = new URL(link.getAttribute('href')!, compiler.url);
    if (!url.pathname.toLowerCase().endsWith('.zip')) continue;
    const path = localPath(url);
    if (/^tmp\/[A-Za-z0-9_.-]+\.zip$/i.test(path)) {
      const stat = await runtime.fs.stat(runtime.documentRoot + '/' + path);
      if (stat?.isFile) previousTimes.set(path, stat.mtime);
    }
  }
  const data = new URLSearchParams();
  for (const [key, value] of new FormData(form)) if (typeof value === 'string') data.append(key, value);
  if (![...data].some(([k, v]) => /^[a-f0-9]{32}$/i.test(k) && v === '1')) throw new Error('JCB did not supply the Joomla session form token.');
  data.set(component.name, String(selected.id));
  data.set(version.name, String(major));
  data.set('task', 'compiler.compiler');
  const result = await page(new URL(form.getAttribute('action') || compiler.url.href, compiler.url), data);
  // Only accept archives from the success layout of this submission.
  const success = result.doc.querySelector('.com-componentbuilder-compiler-success');
  const errors = [...result.doc.querySelectorAll('#system-message-container, joomla-alert[type="danger"], .alert-danger')].map(n => n.textContent ?? '').join(' ');
  const failure = /Fatal error|Maximum execution time|Undefined constant|SQLSTATE|(?:Super|Joomla)\s+Power\s+repository\b[\s\S]{0,250}?gave the following error|Power\s+guid:\s*[a-f0-9-]+\s+(?:not found|could not be found)|Failed to (?:fetch|connect to)\b/i.test(errors);
  if (!success || failure) throw new Error('JCB did not report a successful compile. Inspect the compiler messages and dependency availability.');
  const packages: { path: string; filename: string; size: number; sha256: string }[] = [];
  const paths = new Set<string>();
  for (const link of success.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const url = new URL(link.getAttribute('href')!, result.url);
    if (!url.pathname.toLowerCase().endsWith('.zip')) continue;
    const path = localPath(url);
    if (!/^tmp\/[A-Za-z0-9_.-]+\.zip$/i.test(path) || paths.has(path)) continue;
    paths.add(path);
    const filename = runtime.documentRoot + '/' + path;
    if (previousTimes.has(path) && (await runtime.fs.stat(filename))?.mtime === previousTimes.get(path)) {
      throw new Error('JCB returned an installer from an earlier compilation. Inspect the compiler messages.');
    }
    const bytes = new Uint8Array(await runtime.fs.readFile(filename));
    if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) throw new Error('JCB returned an invalid installer ZIP.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    packages.push({ path: '/' + path, filename: path.split('/').pop()!, size: bytes.length, sha256: [...digest].map(n => n.toString(16).padStart(2, '0')).join('') });
  }
  if (!packages.length) throw new Error('JCB reported success without an accessible installer ZIP.');
  return { componentId: selected.id, name: selected.name, joomlaMajor: major, packages };
}
