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
export async function getDeploymentCatalog(options: { baseURL?: string } = {}) {
  const base = playgroundBase(options.baseURL);
  async function read(path: string) {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status + '.');
    return response.json();
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
    recipes: recipes.deploys.map((r: { id: string; title: string; joomla: string[]; requirements: object }) => ({
      id: r.id, title: r.title, joomlaMajors: r.joomla, requirements: r.requirements,
    })),
    php: php.map(({ version, patchVersion }) => ({ version, patchVersion })),
    joomla: available.map(r => ({ version: r.version, channel: r.channel, php: compatible(r) })).filter(r => r.php.length),
    jcb: releases.jcb.map((r: Release) => ({ version: r.version, channel: r.channel })),
    stagedJoomla: staged.map(r => ({ version: r.version, php: r.php })),
  };
}
