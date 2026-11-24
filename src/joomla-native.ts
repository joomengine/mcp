// Serialized into the selected browser. Each attachment owns its own handle and MCP session.
export async function nativeDispatch(runtime: any, operation: string, args: Record<string, any>) {
  const key = Symbol.for('joomengine.mcp.site-native-session');
  const workspaceId = runtime.workspace?.id;
  const siteUrl = runtime.baseUrl;
  let state = runtime[key];
  // An owner can switch sites outside the MCP. A stale token/session must never reach the replacement.
  if (state && (state.workspaceId !== workspaceId || state.siteUrl !== siteUrl)) {
    delete runtime[key];
    state = undefined;
  }
  if (operation === 'native_close') {
    delete runtime[key];
    if (state) await state.client.close();
    return {};
  }
  if (!workspaceId || runtime.closed) throw new Error('Open a running Joomla workspace.');
  if (!state) {
    const conn = await runtime.getMcpConnection();
    if (!conn?.installed || !conn.token) throw new Error('The native Joomla MCP is unavailable. Use a deployment with the native MCP package.');
    const site = new URL(siteUrl);
    const index = site.pathname.indexOf('/__site/');
    if (index < 0 || site.origin !== location.origin) throw new Error('Invalid Playground site address.');
    const { createMcpClient } = await import(new URL(site.pathname.slice(0, index + 1) + 'src/mcp.mjs', site.origin).href);
    const request = (path: string, init: RequestInit) => {
      if (runtime.closed || runtime.workspace?.id !== workspaceId || runtime.baseUrl !== siteUrl) throw new Error('The active Joomla site changed.');
      return runtime.request(path, init);
    };
    const client = createMcpClient({ request, token: conn.token });
    try {
      const info = await client.initialize();
      state = { client, info, workspaceId, siteUrl };
      runtime[key] = state;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
  const { client, info } = state;
  const page = args.cursor ? { cursor: args.cursor } : {};
  switch (operation) {
    case 'native_info': return { serverInfo: info.serverInfo, capabilities: info.capabilities, instructions: info.instructions };
    case 'native_tools': return client.request('tools/list', page);
    case 'native_call': return client.request('tools/call', { name: args.name, arguments: args.arguments ?? {} });
    case 'native_resources': return info.capabilities.resources ? client.request('resources/list', page) : { resources: [] };
    case 'native_resource_templates': return info.capabilities.resources ? client.request('resources/templates/list', page) : { resourceTemplates: [] };
    case 'native_resource': return client.request('resources/read', { uri: args.uri });
    case 'native_prompts': return info.capabilities.prompts ? client.request('prompts/list', page) : { prompts: [] };
    case 'native_prompt': return client.request('prompts/get', { name: args.name, arguments: args.arguments ?? {} });
    default: throw new Error('Unknown native Joomla MCP operation.');
  }
}
