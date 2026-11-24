import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createJoomlaMcp, ToolsetSchema, type ApiConfig } from '@joomengine/joomla-mcp';
import { JoomlaApiError, type JoomlaApiRequest, type JoomlaApiResponse, type JoomlaApiTransport } from '@joomengine/joomla-mcp/adapters';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

interface RequestWorkspace {
  call(operation: string, args: Record<string, unknown>): Promise<unknown>;
}

function provider(client: Client, close: () => Promise<void>) {
  const capabilities = client.getServerCapabilities();
  return {
    describe(name: string, args: Record<string, unknown>) {
      const page = args.cursor ? { cursor: String(args.cursor) } : {};
      switch (name) {
        case 'provider_info': return { serverInfo: client.getServerVersion(), capabilities, instructions: client.getInstructions() };
        case 'provider_resources': return capabilities?.resources ? client.listResources(page) : { resources: [] };
        case 'provider_resource_templates': return capabilities?.resources ? client.listResourceTemplates(page) : { resourceTemplates: [] };
        case 'provider_resource': return client.readResource({ uri: String(args.uri) });
        case 'provider_prompts': return capabilities?.prompts ? client.listPrompts(page) : { prompts: [] };
        case 'provider_prompt': return client.getPrompt({ name: String(args.name), arguments: args.arguments as Record<string, string> | undefined });
        default: throw new Error('Unknown provider operation.');
      }
    },
    listTools: (cursor?: string) => client.listTools(cursor ? { cursor } : {}),
    callTool: (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 }),
    close
  };
}

/** Bind an upstream Joomla action to the browser's own authenticated request channel. */
export async function createJoomlaProvider(workspace: RequestWorkspace) {
  const info = await workspace.call('workspace_info', {}) as { workspaceId?: string; siteUrl?: string };
  if (!info.workspaceId || !info.siteUrl) throw new Error('The active Joomla workspace has no site identity.');
  const { workspaceId, siteUrl } = info;
  const request = async (_config: ApiConfig, request: JoomlaApiRequest): Promise<JoomlaApiResponse> => {
    if (request.authentication === 'joomla-update-token') {
      throw new Error('The Joomla core updater requires a separately configured Joomla Update token.');
    }
    const response = await workspace.call('joomla.api', { ...request, workspaceId, siteUrl }) as JoomlaApiResponse;
    if (response.status < 200 || response.status >= 300) {
      // Never forward a PHP error page or token-bearing request headers as diagnostics.
      throw new JoomlaApiError(response.status, null);
    }
    return response;
  };
  const api: JoomlaApiTransport = {
    request,
    get: (config, path, query) => request(config, { method: 'GET', path, query })
  };
  // The injected transport owns authentication and obtains the real token inside the browser.
  const site = {
    id: 'playground',
    toolsets: new Set(ToolsetSchema.options.filter(toolset => !['cli.discovery', 'jcb.execute', 'core-update'].includes(toolset))),
    api: {
      baseUrl: siteUrl, tokenEnv: 'WORKSPACE', token: 'browser-managed',
      timeoutMs: 180_000, maxResponseBytes: 5_242_880, maxPageSize: 100
    }
  };
  const application = createJoomlaMcp({
    configuration: {
      defaultSite: site.id, sites: new Map([[site.id, site]]),
      approval: { secret: randomBytes(32).toString('hex'), ttlMs: 300_000 }
    },
    runtimeOptions: { api }
  });
  const server = application.createServer();
  const client = new Client({ name: 'joomengine-playground', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (error) {
    await Promise.allSettled([client.close(), server.close()]);
    throw error;
  }
  return provider(client, async () => { await client.close(); await server.close(); });
}

/** Connect only to a site configuration previously saved by the operator's Composer client. */
export async function connectComposerProvider(siteAlias: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(siteAlias)) throw new Error('Invalid Composer site alias.');
  const launcher = process.env.JOOMENGINE_MCP_COMPOSER_BIN || 'joomengine-mcp';
  if (launcher !== 'joomengine-mcp' && !isAbsolute(launcher)) {
    throw new Error('JOOMENGINE_MCP_COMPOSER_BIN must be the absolute path to the Composer launcher.');
  }
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'SystemRoot', 'XDG_CONFIG_HOME', 'JOOMENGINE_MCP_CONFIG_DIR']) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  const client = new Client({ name: 'joomengine-playground', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: launcher, args: ['serve', siteAlias], env, stderr: 'inherit' }));
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return provider(client, () => client.close());
}
