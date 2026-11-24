import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { GetPromptResult, ListResourcesResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

const bundleDirectory = fileURLToPath(new URL('../skills/', import.meta.url));
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

type Manifest = { revision: string; files: string[] };
let catalogPromise: Promise<{ revision: string; paths: string[]; byUri: Map<string, string> }> | undefined;

function uriFor(path: string) {
  return base + path.split('/').map(encodeURIComponent).join('/');
}

async function loadCatalogue() {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(join(bundleDirectory, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error('JoomEngine Skills bundle unavailable. In a source checkout, run npm run skills.', { cause: error });
  }
  const unique = new Set(manifest.files);
  const entrypoints = [...firstEntries, ...manifest.files.filter(path => path.endsWith('/SKILL.md'))];
  const paths = [...new Set([...entrypoints.filter(path => unique.has(path)), ...manifest.files])];
  const byUri = new Map(paths.map(path => [uriFor(path), path]));
  return { revision: manifest.revision, paths, byUri };
}

function catalogue() {
  catalogPromise ??= loadCatalogue().catch(error => {
    catalogPromise = undefined;
    throw error;
  });
  return catalogPromise;
}

function mediaType(path: string) {
  const extension = extname(path).toLowerCase();
  const text = textTypes[extension] ?? (/(^|\/)LICENSE$/.test(path) ? 'text/plain' : undefined);
  return { text: Boolean(text), mimeType: text ?? binaryTypes[extension] ?? 'application/octet-stream' };
}

export async function listSkillResources(cursor?: string): Promise<ListResourcesResult> {
  const { revision, paths } = await catalogue();
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
    ...(path === rootEntry ? { description: `Start here to select a JCB workflow. Bundled from joomengine/skills at ${revision}.` } : {}),
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
  const canonical = normalizeUri(uri);
  const path = (await catalogue()).byUri.get(canonical);
  if (!path) throw new McpError(-32002, `Unknown skills resource: ${canonical}`);
  const data = await readFile(join(bundleDirectory, 'joomengine-jcb', path));
  const { text, mimeType } = mediaType(path);
  return { contents: [text ? { uri: canonical, mimeType, text: data.toString('utf8') }
    : { uri: canonical, mimeType, blob: data.toString('base64') }] };
}

const workflows = [
  { name: 'jcb_build_extension', description: 'Build a Joomla extension from requirements using JCB.', path: applicationWorkflow },
  { name: 'jcb_verify_in_playground', description: 'Compile, install and exercise a JCB extension in Playground.', path: playgroundGuide },
  { name: 'jcb_deliver_extension', description: 'Deliver the installer and verify the portable site backup.', path: deliveryWorkflow },
];
export const skillPrompts = workflows.map(({ name, description }) => ({ name, description }));

export async function getSkillPrompt(name: string): Promise<GetPromptResult> {
  const workflow = workflows.find(entry => entry.name === name);
  if (!workflow) throw new McpError(ErrorCode.InvalidParams, `Unknown skills prompt: ${name}`);
  const [{ contents: [root] }, { contents: [task] }] = await Promise.all([
    readSkillResource(uriFor(rootEntry)), readSkillResource(uriFor(workflow.path)),
  ]);
  return { description: workflow.description, messages: [
    { role: 'user', content: { type: 'text', text: 'Follow the bundled JCB workflow for the requested task. Read linked references as needed by resolving relative links against the containing resource URI.' } },
    { role: 'user', content: { type: 'resource', resource: root } },
    { role: 'user', content: { type: 'resource', resource: task } },
  ] };
}
