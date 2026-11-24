import { deploymentTools } from './deployment.js';
import { createRequire } from 'node:module';
import { Ajv } from 'ajv';
import { providerTools } from './provider-tools.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema,
  ListToolsRequestSchema, ReadResourceRequestSchema, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { openCloudWorkspace, type Workspace } from './browser.js';
import { WorkspaceOperations } from './operations.js';
import { getDeploymentCatalog, getDeploymentSchema } from './browser-catalog.js';
import { lifecycleTools } from './lifecycle.js';
import { browserTools } from './browser-ui.js';
import { attachWorkspace } from './attach.js';
import { createJoomlaProvider, connectComposerProvider } from './joomla.js';
import { hostArtifactTools, transferArtifact } from './artifacts.js';
import { runtimeTools } from './runtime-tools.js';
import { jcbTools } from './jcb.js';
import { getSkillPrompt, listSkillPrompts, listSkillResources, readSkillResource, searchSkills, skillCapabilities, skillStatus } from './skills.js';

export interface HostOptions {
  baseURL?: string;
  executablePath?: string;
  browserEndpoint?: string;
  composerSite?: string;
  artifactDirectory?: string;
  headless?: boolean;
  profileDirectory?: string;
}

const { name: packageName, version: packageVersion } = createRequire(import.meta.url)('../package.json') as { name: string; version: string };
const textField = { type: 'string', minLength: 1 } as const;
function tool(name: string, description: string, properties: Record<string, object> = {}, required: string[] = []): Tool {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const bootstrap = [
  tool('deployment_catalog', 'List available Playground recipes, language packages, Joomla and JCB versions and compatible PHP. Pass deployId to read one complete built-in manifest before opening a workspace.', { deployId: textField }),
  tool('skills_capabilities', 'Map the operations available on this MCP host to canonical Skills. Supply a capability ID to narrow the result. See tools/list for complete per-operation schemas.', { capability: textField }),
  tool('skills_status', 'Report the active and npm-bundled canonical Skills revisions, file count and last upstream check. Set refresh to check the upstream default branch now.', { refresh: { type: 'boolean' } }),
  tool('skills_search', 'Search across the canonical skill guides, workflows, models and examples. Use each result URI with skills_read.', { query: { type: 'string', minLength: 1, maxLength: 512 }, cursor: textField }, ['query']),
  tool('skills_list', 'List current JCB and Playground skills with their resource URIs. Follow nextCursor for more.', { cursor: textField }),
  tool('skills_read', 'Read a canonical workflow by resource URI. Start with joomengine://skills/SKILL.md and follow its relative links.', { uri: textField }, ['uri']),
  tool('workspace_open', 'Launch a fresh site in an isolated agent browser. Use jcb-mcp for native Joomla and JCB capabilities. An open workspace must first be closed explicitly.', {
    deployId: textField, configuration: { type: 'object' }, document: { type: 'object' },
    sourceURL: textField, shareURL: textField, savedSiteKey: textField, idle: { type: 'boolean' },
  }),
  tool('workspace_close', 'Release the current workspace. Closing a cloud browser discards its private profile. Export wanted artifacts first. Closing an attached workspace leaves the client application running.'),
];
const longRunning = ['workspace_open', 'workspace_attach', 'workspace_start', 'workspace_restart', 'workspace_stop', 'workspace_reset', 'workspace_resume', 'deployment_configure', 'deployment_launch', 'deployment_clone', 'site_console', 'jcb_compile', 'extension_install', 'jcb_refresh_tools', 'site_export', 'site_restore', 'backup_save', 'backup_update', 'backup_import', 'backup_export', 'workspace_recovery_export', 'workspace_repair', 'artifact_save', 'artifact_load'];
const external = (prefix: string, label: string) => [
  tool(prefix + '_tools', 'List the ' + label + ' tool schemas, passing nextCursor as cursor for subsequent pages.', { cursor: textField }),
  tool(prefix + '_call', 'Invoke a discovered ' + label + ' tool using its exact input schema.', { name: textField, arguments: { type: 'object' } }, ['name']),
];

export function createPlaygroundServer(options: HostOptions = {}) {
  const tools: Tool[] = [...bootstrap, ...lifecycleTools, ...deploymentTools, ...runtimeTools, ...providerTools(!!options.composerSite), ...browserTools, ...jcbTools, ...external('joomla', 'TypeScript Joomla MCP')];
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
    instructions: 'Read joomengine://skills/SKILL.md and use skills_capabilities to match this host’s tools to canonical guides for your task. Open a fresh workspace or attach to the designated client workspace. Discover installed Joomla capabilities through native_tools. Use joomla_tools for the independent TypeScript implementation. Preserve wanted files and backups before closing a cloud session.',
  });
  let workspace: Workspace | undefined;
  let joomla: Awaited<ReturnType<typeof createJoomlaProvider>> | undefined;
  let joomlaWorkspaceId: string | undefined;
  let composer: Awaited<ReturnType<typeof connectComposerProvider>> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let usedNative = false;

  async function closeNative() {
    if (usedNative && workspace) await workspace.call('native_close', {}).catch(() => {});
    usedNative = false;
  }

  async function closeWorkspace() {
    try { await closeNative(); await joomla?.close(); }
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
          profileDirectory: options.profileDirectory, input: args, deployId: args.deployId as string | undefined, configuration: args.configuration as Record<string, unknown> | undefined });
      }
      try { return await workspace.call('workspace_info', {}); }
      catch (error) { await closeWorkspace(); throw error; }
    }
    if (name === 'workspace_close') { await closeWorkspace(); return { closed: true }; }
    const delegated = name.startsWith('provider_');
    if (name.startsWith('composer_') || (delegated && args.provider === 'composer')) {
      composer ??= await connectComposerProvider(options.composerSite!);
      if (delegated) return composer.describe(name, args);
      return name === 'composer_tools' ? composer.listTools(args.cursor as string | undefined) : composer.callTool(args.name as string, (args.arguments ?? {}) as Record<string, unknown>);
    }
    if (!workspace) throw new Error('Open a cloud workspace or attach to an existing workspace first.');
    if (['site_restore','workspace_stop','workspace_start','workspace_reset','workspace_resume','workspace_restart','deployment_launch','deployment_clone'].includes(name)) {
      // Replacing the site ends all site-specific write plans, even when a restore later fails.
      await closeNative();
      await joomla?.close();
      joomla = undefined;
      joomlaWorkspaceId = undefined;
    }
    if (name === 'artifact_save' || name === 'artifact_load') return transferArtifact(workspace, options.artifactDirectory!, name, args);
    if (name.startsWith('native_') || (delegated && args.provider === 'native')) {
      usedNative = true;
      return workspace.call(delegated ? name.replace('provider_', 'native_') : name, args);
    }
    if (name.startsWith('joomla_') || (delegated && args.provider === 'joomla')) {
      const info = await workspace.call('workspace_info', {}) as { workspaceId?: string };
      if (!info.workspaceId) throw new Error('The active site has no workspace identity.');
      if (joomla && joomlaWorkspaceId !== info.workspaceId) { await joomla.close(); joomla = undefined; }
      joomla ??= await createJoomlaProvider(workspace);
      joomlaWorkspaceId = info.workspaceId;
      if (delegated) return joomla.describe(name, args);
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
        result = await getDeploymentCatalog({ baseURL: options.baseURL, deployId: args.deployId as string | undefined });
      } else if (params.name === 'deployment_schema') {
        result = await getDeploymentSchema(options.baseURL, args.section as string | undefined);
      } else if (params.name === 'skills_capabilities') {
        result = await skillCapabilities(tools, args.capability as string | undefined);
      } else if (params.name === 'skills_status') {
        result = await skillStatus(args.refresh === true);
      } else if (params.name === 'skills_search') {
        result = await searchSkills(args.query as string, args.cursor as string | undefined);
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
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: await listSkillPrompts() }));
  server.setRequestHandler(GetPromptRequestSchema, async ({ params }) => getSkillPrompt(params.name));
  let closing: Promise<void> | undefined;
  function dispose() {
    disposed = true;
    return closing ??= pending.then(async () => { try { await closeWorkspace(); } finally { await composer?.close(); } });
  }
  server.onclose = () => { void dispose().catch(error => console.error('Workspace cleanup failed:', error.message)); };
  return { server, dispose };
}
