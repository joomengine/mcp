import { createRequire } from 'node:module';
import { Ajv } from 'ajv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema,
  ListToolsRequestSchema, ReadResourceRequestSchema, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { openCloudWorkspace, type Workspace } from './browser.js';
import { WorkspaceOperations } from './operations.js';
import { getDeploymentCatalog } from './browser-catalog.js';
import { browserTools } from './browser-ui.js';
import { attachWorkspace } from './attach.js';
import { createJoomlaProvider, connectComposerProvider } from './joomla.js';
import { hostArtifactTools, transferArtifact } from './artifacts.js';
import { runtimeTools } from './runtime-tools.js';
import { jcbTools } from './jcb.js';
import { getSkillPrompt, listSkillResources, readSkillResource, skillPrompts } from './skills.js';

export interface HostOptions {
  baseURL?: string;
  executablePath?: string;
  browserEndpoint?: string;
  composerSite?: string;
  artifactDirectory?: string;
  headless?: boolean;
}

const { name: packageName, version: packageVersion } = createRequire(import.meta.url)('../package.json') as { name: string; version: string };
const textField = { type: 'string', minLength: 1 } as const;
function tool(name: string, description: string, properties: Record<string, object> = {}, required: string[] = []): Tool {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const bootstrap = [
  tool('deployment_catalog', 'List the hosted Playground recipes, Joomla and JCB versions, and compatible PHP releases before choosing a workspace.'),
  tool('skills_list', 'List packaged JCB and Playground skills with their resource URIs. Follow nextCursor for more.', { cursor: textField }),
  tool('skills_read', 'Read a packaged workflow by resource URI. Start with joomengine://skills/SKILL.md and follow its relative links.', { uri: textField }, ['uri']),
  tool('workspace_open', 'Launch a fresh site in an isolated agent browser. Use jcb-mcp for native Joomla and JCB capabilities. An open workspace must first be closed explicitly.', {
    deployId: textField, configuration: { type: 'object' },
  }),
  tool('workspace_close', 'Release the current workspace. Closing a cloud browser discards its private profile. Export wanted artifacts first. Closing an attached workspace leaves the client application running.'),
];
const longRunning = ['workspace_open', 'workspace_attach', 'deployment_configure', 'jcb_compile', 'extension_install', 'jcb_refresh_tools', 'site_export', 'site_restore', 'backup_save', 'artifact_save', 'artifact_load'];
const external = (prefix: string, label: string) => [
  tool(prefix + '_tools', 'List the ' + label + ' tool schemas, passing nextCursor as cursor for subsequent pages.', { cursor: textField }),
  tool(prefix + '_call', 'Invoke a discovered ' + label + ' tool using its exact input schema.', { name: textField, arguments: { type: 'object' } }, ['name']),
];

export function createPlaygroundServer(options: HostOptions = {}) {
  const tools: Tool[] = [...bootstrap, ...runtimeTools, ...browserTools, ...jcbTools, ...external('joomla', 'TypeScript Joomla MCP')];
  if (options.artifactDirectory) tools.push(...hostArtifactTools);
  if (options.browserEndpoint) tools.push(tool('workspace_attach', 'Connect to the selected open Playground browser or desktop workspace using the endpoint configured by its operator. Provide tabId when more than one workspace matches.', { tabId: textField }));
  if (options.composerSite) tools.push(...external('composer', 'Composer stdio Joomla MCP'));
  const operations = new WorkspaceOperations();
  const available = longRunning.filter(name => tools.some(item => item.name === name));
  tools.push(tool('operation_start', 'Start a long-running workspace tool and immediately return its operation ID. Poll operation_status on the same connection until completion.', {
    tool: { type: 'string', enum: available }, arguments: { type: 'object' },
  }, ['tool']));
  tools.push(tool('operation_status', 'Get a running or completed operation, including its result or error. Omit id to list recent operations in this session.', { id: textField }));
  const validator = new Ajv({ strict: false, allErrors: false });
  validator.addFormat('uri', { type: 'string', validate: (value: string) => URL.canParse(value) });
  const inputs = new Map(tools.map(item => [item.name, validator.compile(item.inputSchema)]));
  const server = new Server({ name: packageName, version: packageVersion }, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: 'Read joomengine://skills/SKILL.md and follow the Playground and native JCB authoring workflows. Open a fresh workspace or attach to the designated client workspace. Discover installed Joomla capabilities through native_tools. Use joomla_tools for the independent TypeScript implementation. Preserve wanted files and backups before closing a cloud session.',
  });
  let workspace: Workspace | undefined;
  let joomla: Awaited<ReturnType<typeof createJoomlaProvider>> | undefined;
  let joomlaWorkspaceId: string | undefined;
  let composer: Awaited<ReturnType<typeof connectComposerProvider>> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  let disposed = false;

  async function closeWorkspace() {
    try { await joomla?.close(); }
    finally { joomla = undefined; joomlaWorkspaceId = undefined; try { await workspace?.close(); } finally { workspace = undefined; } }
  }
  function checkInput(name: string, args: Record<string, unknown>) {
    if (disposed) throw new Error('The MCP session is closed.');
    const validate = inputs.get(name);
    if (!validate) throw new Error('Unknown or unconfigured tool: ' + name);
    if (!validate(args)) throw new Error(validator.errorsText(validate.errors));
  }
  async function invoke(name: string, args: Record<string, unknown>) {
    if (disposed) throw new Error('The MCP session is closed.');
    if (name === 'workspace_open' || name === 'workspace_attach') {
      if (workspace) throw new Error('A workspace is already open. Export wanted work and call workspace_close before switching.');
      if (name === 'workspace_attach') {
        workspace = await attachWorkspace({ endpoint: options.browserEndpoint!, playgroundUrl: options.baseURL, tabId: args.tabId as string | undefined });
      } else {
        workspace = await openCloudWorkspace({ baseURL: options.baseURL, executablePath: options.executablePath, headless: options.headless,
          deployId: (args.deployId as string | undefined) ?? 'jcb-mcp', configuration: args.configuration as Record<string, unknown> | undefined });
      }
      try { return await workspace.call('workspace_info', {}); }
      catch (error) { await closeWorkspace(); throw error; }
    }
    if (name === 'workspace_close') { await closeWorkspace(); return { closed: true }; }
    if (name.startsWith('composer_')) {
      composer ??= await connectComposerProvider(options.composerSite!);
      return name === 'composer_tools' ? composer.listTools(args.cursor as string | undefined) : composer.callTool(args.name as string, (args.arguments ?? {}) as Record<string, unknown>);
    }
    if (!workspace) throw new Error('Open a cloud workspace or attach to an existing workspace first.');
    if (name === 'site_restore') {
      // Replacing the site ends all site-specific write plans, even when a restore later fails.
      await joomla?.close();
      joomla = undefined;
      joomlaWorkspaceId = undefined;
    }
    if (name === 'artifact_save' || name === 'artifact_load') return transferArtifact(workspace, options.artifactDirectory!, name, args);
    if (name.startsWith('joomla_')) {
      const info = await workspace.call('workspace_info', {}) as { workspaceId?: string };
      if (!info.workspaceId) throw new Error('The active site has no workspace identity.');
      if (joomla && joomlaWorkspaceId !== info.workspaceId) { await joomla.close(); joomla = undefined; }
      joomla ??= await createJoomlaProvider(workspace);
      joomlaWorkspaceId = info.workspaceId;
      return name === 'joomla_tools' ? joomla.listTools(args.cursor as string | undefined) : joomla.callTool(args.name as string, (args.arguments ?? {}) as Record<string, unknown>);
    }
    return workspace.call(name, args);
  }
  function enqueue(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const run = pending.then(() => {
      if (signal?.aborted) throw new Error('The request was cancelled before it started.');
      return invoke(name, args);
    });
    pending = run.catch(() => {});
    return run;
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const token = params._meta?.progressToken;
    let progress = 0;
    const timer = token === undefined ? undefined : setInterval(() => {
      void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message: params.name + ' is running' } }).catch(() => {});
    }, 8000);
    try {
      const args = params.arguments ?? {};
      checkInput(params.name, args);
      let result: unknown;
      if (params.name === 'deployment_catalog') {
        result = await getDeploymentCatalog({ baseURL: options.baseURL });
      } else if (params.name === 'skills_list') {
        result = await listSkillResources(args.cursor as string | undefined);
      } else if (params.name === 'skills_read') {
        const { contents } = await readSkillResource(args.uri as string);
        result = { content: contents.map(resource => 'text' in resource
          ? { type: 'text', text: resource.text }
          : { type: 'resource', resource }) };
      } else if (params.name === 'operation_status') {
        result = operations.status(args.id as string | undefined);
      } else if (params.name === 'operation_start') {
        const name = args.tool as string;
        const nested = (args.arguments ?? {}) as Record<string, unknown>;
        checkInput(name, nested);
        result = operations.start(name, () => enqueue(name, nested));
      } else {
        result = await enqueue(params.name, args, extra.signal);
      }
      if (result && typeof result === 'object' && 'content' in result && Array.isArray(result.content)) return { ...result, content: result.content };
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    } finally { clearInterval(timer); }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async ({ params }) => listSkillResources(params?.cursor));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => readSkillResource(params.uri));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: skillPrompts }));
  server.setRequestHandler(GetPromptRequestSchema, async ({ params }) => getSkillPrompt(params.name));
  let closing: Promise<void> | undefined;
  function dispose() {
    disposed = true;
    return closing ??= pending.then(async () => { try { await closeWorkspace(); } finally { await composer?.close(); } });
  }
  server.onclose = () => { void dispose().catch(error => console.error('Workspace cleanup failed:', error.message)); };
  return { server, dispose };
}
