interface Release {
  version: string;
  channel?: string;
  php?: string[];
  phpMinimum?: string;
}

export function playgroundBase(address = 'https://playground.joomengine.org/') {
  const base = new URL(address);
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:'
      && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) {
    throw new Error('Configure a Playground HTTPS root URL or a local test server.');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return base;
}

/** The same three public JSON documents used by Rocket. A browser is unnecessary for discovery. */
export async function getDeploymentCatalog(options: { baseURL?: string; deployId?: string } = {}) {
  const base = playgroundBase(options.baseURL);
  async function read(path: string) {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status + '.');
    return response.json();
  }
  if (options.deployId !== undefined) {
    const catalog = await read('deploys/catalog.json');
    const recipe = catalog.deploys.find((entry: { id: string }) => entry.id === options.deployId);
    if (!recipe) throw new Error('Unknown built-in deployment: ' + options.deployId);
    const directory = new URL('deploys/', base);
    const url = new URL(recipe.file, directory);
    if (url.origin !== directory.origin || !url.pathname.startsWith(directory.pathname) || url.username || url.password) {
      throw new Error('Recipe manifest must be hosted by the configured Playground.');
    }
    return { recipe, manifest: await read(url.href), url: url.href };
  }
  const [manifest, recipes, releases] = await Promise.all([
    read('assets/manifest.json'), read('deploys/catalog.json'), read('assets/version-catalog.json'),
  ]);
  const php: { version: string; patchVersion?: string }[] = manifest.php;
  const staged: Release[] = manifest.joomla;
  const available: Release[] = releases.joomla;
  // The published release catalogue already selects current stable, preview and nightly packages.
  const compatible = (entry: Release) => {
    const eligible = entry.php ?? (entry.phpMinimum ? php.map(item => item.version) :
      staged.filter(item => item.version.split('.')[0] === entry.version.split('.')[0]).flatMap(item => item.php || []));
    return php.filter(item => eligible.includes(item.version) && (!entry.phpMinimum ||
      (item.patchVersion ?? item.version + '.0').localeCompare(entry.phpMinimum, 'en', { numeric: true }) >= 0)).map(item => item.version);
  };
  return {
    sourceCommit: manifest.sourceCommit, generatedAt: releases.generatedAt,
    defaults: { ...manifest.defaults, joomlaVersion: available.find(r => r.channel === 'stable' &&
      r.version.split('.')[0] === manifest.defaults.joomlaVersion.split('.')[0] && compatible(r).length)?.version ?? manifest.defaults.joomlaVersion },
    defaultRecipe: recipes.default, defaultRecipesByJoomla: recipes.defaultsByJoomla ?? {},
    languages: recipes.languages ?? {},
    recipes: recipes.deploys.map((r: { id: string; title: string; description?: string; file?: string; joomla: string[]; requirements: object }) => ({
      id: r.id, title: r.title, description: r.description, manifestURL: r.file ? new URL(r.file, new URL('deploys/', base)).href : undefined, joomlaMajors: r.joomla, requirements: r.requirements,
    })),
    php: php.map(({ version, patchVersion }) => ({ version, patchVersion })),
    joomla: available.map(r => ({ version: r.version, channel: r.channel, php: compatible(r) })).filter(r => r.php.length),
    jcb: releases.jcb.map((r: Release) => ({ version: r.version, channel: r.channel })),
    stagedJoomla: staged.map(r => ({ version: r.version, php: r.php })),
  };
}

/** Return the JSON Schema published alongside the selected Playground (including its local references). */
export async function getDeploymentSchema(baseURL?: string, section?: string) {
  const url = new URL('deploys/document.schema.json', playgroundBase(baseURL));
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('The deployment schema returned HTTP ' + response.status + '.');
  const schema = await response.json();
  if (!section) return { url: url.href, sections: Object.keys(schema.$defs), schema };
  if (!Object.hasOwn(schema.$defs, section)) throw new Error('Unknown deployment schema section: ' + section);
  return { url: url.href, schema: schema.$defs[section] };
}
