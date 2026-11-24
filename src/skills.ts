import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { SkillDistribution, type Snapshot } from './skill-distribution.js';
import { loadCapabilityGroups, resolveCapabilities } from './skill-capabilities.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { GetPromptResult, ListResourcesResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

const distribution = new SkillDistribution();
export const skillStatus = (refresh = false) => distribution.status(refresh);
const base = 'joomengine://skills/';
const pageSize = 50;
const rootEntry = 'SKILL.md';
const applicationWorkflow = 'workflows/request-to-extension.md';
const playgroundGuide = 'testing/playground/README.md';
const deliveryWorkflow = 'workflows/delivery.md';
const firstEntries = [rootEntry, 'AGENTS.md', 'README.md', applicationWorkflow, playgroundGuide, deliveryWorkflow, 'registries/skills.json'];
const textTypes: Record<string, string> = {
  '.md': 'text/markdown', '.json': 'application/json', '.xml': 'application/xml',
  '.yml': 'text/yaml', '.yaml': 'text/yaml', '.sh': 'text/x-shellscript',
  '.php': 'text/x-php', '.power': 'text/plain', '.jq': 'text/plain', '.txt': 'text/plain',
};
const binaryTypes: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.zip': 'application/zip', '.pdf': 'application/pdf',
};

type Workflow = { name: string; description: string; path: string };
type Catalogue = {
  snapshot: Snapshot;
  paths: string[];
  byUri: Map<string, string>;
  prompts: Workflow[];
  groups: Awaited<ReturnType<typeof loadCapabilityGroups>>;
  index?: Promise<Map<string, string>>;
};
let active: { revision: string; value: Promise<Catalogue> } | undefined;

function uriFor(path: string) {
  return base + path.split('/').map(encodeURIComponent).join('/');
}

async function loadCatalogue(snapshot: Snapshot): Promise<Catalogue> {
  const registered: { skills: { name: string; path: string; role: string }[] } =
    JSON.parse((await snapshot.read('registries/skills.json')).toString());
  const modules: { modules: { skill_entrypoint?: string; scope?: string }[] } =
    JSON.parse((await snapshot.read('registries/modules.json')).toString());
  const moduleDescriptions = new Map(modules.modules.map(entry => [entry.skill_entrypoint, entry.scope]));
  const unique = new Set(snapshot.files);
  const entrypoints = [...firstEntries, ...registered.skills.map(entry => entry.path)];
  const paths = [...new Set([...entrypoints.filter(path => unique.has(path)), ...snapshot.files])];
  const prompts: Workflow[] = workflows.filter(entry => unique.has(entry.path));
  for (const skill of registered.skills) {
    prompts.push({ name: 'skill_' + skill.name, path: skill.path,
      description: moduleDescriptions.get(skill.path) || `Use the ${skill.name} skill (${skill.role}).` });
  }
  for (const path of snapshot.files.filter(path => /(?:^|\/)workflows\/.*\.md$/.test(path))) {
    const slug = path.slice(0, -3).replace(/[^a-zA-Z0-9_-]/g, '_');
    let name = 'workflow_' + slug;
    if (prompts.some(entry => entry.name === name)) name += '_' + createHash('sha256').update(path).digest('hex').slice(0, 12);
    const heading = (await snapshot.read(path)).toString().match(/^#\s+(.+)$/m)?.[1];
    prompts.push({ name, path, description: heading ?? path });
  }
  return { snapshot, paths, byUri: new Map(paths.map(path => [uriFor(path), path])), prompts, groups: await loadCapabilityGroups(snapshot) };
}

async function catalogue() {
  const snapshot = await distribution.snapshot();
  if (active?.revision !== snapshot.revision) active = { revision: snapshot.revision, value: loadCatalogue(snapshot) };
  return active.value;
}

function mediaType(path: string) {
  const extension = extname(path).toLowerCase();
  const text = textTypes[extension] ?? (/(^|\/)LICENSE$/.test(path) ? 'text/plain' : undefined);
  return { text: Boolean(text), mimeType: text ?? binaryTypes[extension] ?? 'application/octet-stream' };
}

export async function listSkillResources(cursor?: string): Promise<ListResourcesResult> {
  const { snapshot: { revision }, paths } = await catalogue();
  let offset = 0;
  if (cursor !== undefined) {
    const match = /^([0-9a-f]+):([1-9][0-9]*)$/.exec(cursor);
    offset = Number(match?.[2]);
    if (match?.[1] !== revision || !Number.isSafeInteger(offset) || offset >= paths.length || offset % pageSize !== 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid or expired JoomEngine Skills cursor.');
    }
  }
  const resources = paths.slice(offset, offset + pageSize).map(path => ({
    name: path, uri: uriFor(path), mimeType: mediaType(path).mimeType,
    ...(path === rootEntry ? { description: `Start here to select a JCB workflow. Canonical joomengine/skills revision ${revision}.` } : {}),
  }));
  const next = offset + resources.length;
  return next < paths.length ? { resources, nextCursor: `${revision}:${next}` } : { resources };
}

function normalizeUri(uri: string) {
  try {
    const url = new URL(uri);
    if (url.protocol === 'joomengine:' && url.host === 'skills' && !url.username && !url.password && !url.search) {
      const segments = url.pathname.slice(1).split('/').map(decodeURIComponent);
      // A path component cannot introduce additional separators when decoded.
      if (segments.every(part => part && !/[\\/\0]/.test(part))) return uriFor(segments.join('/'));
    }
  } catch { /* Invalid URL or percent encoding. */ }
  throw new McpError(ErrorCode.InvalidParams, 'Invalid JoomEngine Skills resource URI.');
}

export async function readSkillResource(uri: string): Promise<ReadResourceResult> {
  return readFrom(await catalogue(), uri);
}

async function readFrom(catalog: Catalogue, uri: string): Promise<ReadResourceResult> {
  const canonical = normalizeUri(uri);
  const path = catalog.byUri.get(canonical);
  if (!path) throw new McpError(-32002, `Unknown skills resource: ${canonical}`);
  const data = await catalog.snapshot.read(path);
  const { text, mimeType } = mediaType(path);
  return { contents: [text ? { uri: canonical, mimeType, text: data.toString('utf8') }
    : { uri: canonical, mimeType, blob: data.toString('base64') }] };
}

const workflows = [
  { name: 'jcb_build_extension', description: 'Build a Joomla extension from requirements using JCB.', path: applicationWorkflow },
  { name: 'jcb_verify_in_playground', description: 'Compile, install and exercise a JCB extension in Playground.', path: playgroundGuide },
  { name: 'jcb_deliver_extension', description: 'Deliver the installer and verify the portable site backup.', path: deliveryWorkflow },
];
export async function skillCapabilities(tools: Tool[], group?: string) {
  const catalog = await catalogue();
  return { revision: catalog.snapshot.revision, ...resolveCapabilities(catalog.groups, tools, group) };
}

export async function listSkillPrompts() {
  return (await catalogue()).prompts.map(({ name, description }) => ({ name, description }));
}

export async function searchSkills(query: string, cursor?: string) {
  const catalog = await catalogue();
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new McpError(ErrorCode.InvalidParams, 'Enter one or more search terms.');
  catalog.index ??= (async () => {
    const texts = new Map<string, string>();
    for (const path of catalog.paths) {
      if (mediaType(path).text) texts.set(path, (await catalog.snapshot.read(path)).toString());
    }
    return texts;
  })();
  const results = [];
  for (const [path, text] of await catalog.index) {
    const lower = text.toLowerCase();
    const name = path.toLowerCase();
    if (!terms.every(term => name.includes(term) || lower.includes(term))) continue;
    const heading = text.match(/^#\s+(.+)$/m)?.[1] || path;
    const pos = Math.max(0, lower.indexOf(terms[0]));
    results.push({ path, uri: uriFor(path), heading, excerpt: text.slice(Math.max(0, pos - 35), pos + 180).trim(),
      score: terms.filter(term => name.includes(term) || heading.toLowerCase().includes(term)).length });
  }
  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const prefix = catalog.snapshot.revision + ':' + createHash('sha256').update(terms.join(' ')).digest('hex') + ':';
  const offset = cursor?.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : 0;
  if (cursor && (cursor !== prefix + offset || !Number.isSafeInteger(offset) || offset < 1 || offset >= results.length || offset % 20)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid or expired Skills search cursor.');
  }
  return { revision: catalog.snapshot.revision, total: results.length,
    results: results.slice(offset, offset + 20).map(({ score, ...entry }) => entry),
    nextCursor: offset + 20 < results.length ? prefix + (offset + 20) : null };
}

export async function getSkillPrompt(name: string): Promise<GetPromptResult> {
  const catalog = await catalogue();
  const workflow = catalog.prompts.find(entry => entry.name === name);
  if (!workflow) throw new McpError(ErrorCode.InvalidParams, `Unknown skills prompt: ${name}`);
  const [{ contents: [root] }, { contents: [task] }] = await Promise.all([
    readFrom(catalog, uriFor(rootEntry)), readFrom(catalog, uriFor(workflow.path)),
  ]);
  return { description: workflow.description, messages: [
    { role: 'user', content: { type: 'text', text: 'Follow the bundled JCB workflow for the requested task. Read linked references as needed by resolving relative links against the containing resource URI.' } },
    { role: 'user', content: { type: 'resource', resource: root } },
    { role: 'user', content: { type: 'resource', resource: task } },
  ] };
}
