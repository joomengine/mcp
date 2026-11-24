import type { JoomlaApiRequest, JoomlaApiResponse } from '@joomengine/joomla-mcp/adapters';

interface BrowserRuntime {
  baseUrl: string;
  workspace: { id: string };
  documentRoot: string;
  agentOwned?: boolean;
  installation?: { administrator?: { username: string; password: string } };
  getMcpConnection(): Promise<{ installed: boolean; token?: string }>;
  runPhp(source: string): Promise<unknown>;
  request(path: string, options: RequestInit): Promise<Response>;
}

/** Runs as a closed function in the selected Playground page. Keep all runtime values in that page. */
export async function joomlaApi(runtime: BrowserRuntime, args: Record<string, unknown>): Promise<JoomlaApiResponse> {
  if (args.workspaceId !== runtime.workspace.id || args.siteUrl !== runtime.baseUrl) {
    throw new Error('The active Joomla site changed. Reconnect before planning or applying further operations.');
  }
  const { method, path, query, body, etag, idempotencyKey } = args as unknown as JoomlaApiRequest;
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method) || typeof path !== 'string'
      || !/^v1\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(path)
      || path.split('/').some(part => {
        const decoded = decodeURIComponent(part);
        return !decoded || decoded === '.' || decoded === '..' || /[/\\%?#\x00-\x20]/.test(decoded);
      })) {
    throw new Error('Invalid Joomla API action path or method.');
  }
  const search = new URLSearchParams();
  for (const [key, values] of Object.entries(query ?? {})) {
    for (const value of Array.isArray(values) ? values : [values]) search.append(key, String(value));
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload && new TextEncoder().encode(payload).length > 1048576) throw new Error('Joomla API request exceeds 1 MiB.');

  // The installed component is an optional optimization. It can have a different permission model.
  let token = (await runtime.getMcpConnection().catch(() => undefined))?.token;
  if (!token) {
    // Joomla-only deployments use core's own profile token. Playground supplies its normal private
    // administrator login and Joomla bootstrap. Import the helpers from the edition actually running.
    const base = new URL(runtime.baseUrl);
    const marker = base.pathname.lastIndexOf('/__site/');
    if (marker < 0 || base.origin !== globalThis.location.origin) throw new Error('Invalid Playground site address.');
    const php = new URL(base.pathname.slice(0, marker + 1) + 'src/joomla/php/common.php', base.origin);
    const provision = await import(new URL('../index.mjs', php).href);
    const source = String.raw`
try {
    [$app] = playgroundApplication(playgroundRoot($playground), true);
    if (!$app->login($playground['admin'], ['silent' => true])) throw new RuntimeException();
    $user = $app->getIdentity();
    $options = \Joomla\CMS\Component\ComponentHelper::getParams('com_users');
    if (!$user || $user->guest || $user->block || $user->requireReset || !$user->authorise('core.login.api')
        || \Joomla\Component\Users\Administrator\Helper\Mfa::getUserMfaRecords($user->id)
        || array_intersect((array) $options->get('forceMFAUserGroups', []), $user->getAuthorisedGroups())
        || $app->getSession()->get('com_users.mandatory_mfa_setup', 0)) throw new RuntimeException();
    if (!\Joomla\CMS\Plugin\PluginHelper::isEnabled('user', 'token')
        || !\Joomla\CMS\Plugin\PluginHelper::isEnabled('api-authentication', 'token')) throw new RuntimeException();
    $app->getInput()->set('layout', 'default');
    $read = static function () use ($app, $user) {
        $profile = (object) ['id' => (int) $user->id];
        $app->bootPlugin('token', 'user')->onContentPrepareData(
            new \Joomla\CMS\Event\Model\PrepareDataEvent('onContentPrepareData', ['context' => 'com_users.profile', 'data' => $profile])
        );
        return $profile->joomlatoken ?? [];
    };
    $details = $read();
    if (empty($details['token']) && $playground['createMissing']) {
        // Let the core plugin create a missing seed. Its normal programmatic save preserves existing token fields.
        \Joomla\CMS\Plugin\PluginHelper::importPlugin('user');
        if (!$user->save()) throw new RuntimeException();
        $details = $read();
    }
    if (empty($details['token'])) throw new RuntimeException();
    playgroundFinish(['ok' => true, 'token' => $details['token']]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => 'Joomla API token unavailable. Check the administrator, API access, token plugins and MFA settings.']);
}`;
    const credentials = runtime.installation?.administrator;
    if (!credentials) throw new Error('The active Playground workspace has no configured administrator.');
    const program = await provision.buildPhpProgram('mcp', {
      root: runtime.documentRoot,
      admin: { username: credentials.username, password: credentials.password },
      createMissing: runtime.agentOwned === true
    }, async (name: string) => {
      if (name === 'mcp') return source;
      if (name !== 'common') throw new Error('Unexpected PHP provisioning source.');
      const response = await fetch(php);
      if (!response.ok) throw new Error('Cannot load the deployed Joomla bootstrap.');
      return response.text();
    });
    try {
      token = (await provision.parseProvisioningResult(await runtime.runPhp(program))).token;
    } catch {
      // Provisioning diagnostics can contain account data. Keep them inside the page.
      throw new Error('Cannot obtain a Joomla API token. Verify the current administrator, API permissions, token plugins and profile token.');
    }
  }
  if (!token || /[\r\n]/.test(token)) throw new Error('Joomla did not return an API token.');
  const headers: Record<string, string> = { Accept: 'application/vnd.api+json', 'X-Joomla-Token': token };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  if (etag !== undefined) headers['If-Match'] = etag;
  if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
  // An attached owner can replace its site while this request awaits browser-side authentication.
  if (args.workspaceId !== runtime.workspace.id || args.siteUrl !== runtime.baseUrl) throw new Error('The active Joomla site changed.');
  const response = await runtime.request('api/index.php/' + path + (search.size ? '?' + search : ''), {
    method, headers, body: payload, redirect: 'error'
  });
  if (!response.ok) return { status: response.status, headers: {}, data: null };
  const maximumBytes = 5_242_880;
  if (Number(response.headers.get('content-length')) > maximumBytes) throw new Error('Joomla API response exceeds 5 MiB.');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maximumBytes) throw new Error('Joomla API response exceeds 5 MiB.');
  const text = new TextDecoder().decode(bytes).replaceAll(token, '[redacted]');
  const selectedHeaders: Record<string, string> = {};
  for (const key of ['content-type', 'etag', 'last-modified', 'location', 'x-ratelimit-limit', 'x-ratelimit-remaining']) {
    const value = response.headers.get(key);
    if (value !== null) selectedHeaders[key] = value.replaceAll(token, '[redacted]');
  }
  let data: unknown = text || null;
  if (text && selectedHeaders['content-type']?.includes('json')) {
    try { data = JSON.parse(text); } catch { throw new Error('Joomla API returned invalid JSON.'); }
  }
  return { status: response.status, headers: selectedHeaders, data };
}
