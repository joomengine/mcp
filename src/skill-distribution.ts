import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { loadCapabilityGroups } from './skill-capabilities.js';

const repository = 'joomengine/skills';
const commitEndpoint = 'https://api.github.com/repos/' + repository + '/commits/HEAD';
const archiveEndpoint = 'https://codeload.github.com/' + repository + '/zip/';
const sha = /^[0-9a-f]{40}$/;
const required = ['SKILL.md', 'AGENTS.md', 'LICENSE', 'registries/skills.json', 'registries/modules.json'];
const maxArchive = 32 * 1024 * 1024;
const refreshInterval = 15 * 60_000;
const bundlePath = fileURLToPath(new URL('../skills/', import.meta.url));

export type Snapshot = {
  revision: string;
  files: string[];
  read: (path: string) => Promise<Buffer>;
};
type Source = 'bundled' | 'cached' | 'upstream';
type Receipt = { checkedAt: number; revision: string; digest?: string };
type Options = { bundle?: string; cache?: string; offline?: boolean; request?: typeof fetch; now?: () => number };

function validPath(path: string) {
  return !/[\\\0]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
}

async function validateSnapshot(snapshot: Snapshot) {
  const files = new Set(snapshot.files);
  if (!sha.test(snapshot.revision) || !required.every(path => files.has(path)) ||
      files.size !== snapshot.files.length || !snapshot.files.every(validPath)) {
    throw new Error('Incomplete canonical Skills snapshot');
  }
  const skills = JSON.parse((await snapshot.read('registries/skills.json')).toString()).skills;
  const modules = JSON.parse((await snapshot.read('registries/modules.json')).toString()).modules;
  if (!Array.isArray(skills) || !skills.length || !Array.isArray(modules)) throw new Error('Invalid Skills registries');
  for (const entry of skills) {
    if (typeof entry?.name !== 'string' || !files.has(entry.path)) throw new Error('Broken canonical skill entry point');
  }
  for (const entry of modules) {
    for (const key of ['entrypoint', 'skill_entrypoint', 'test_workflow', 'source_baseline']) {
      if (entry[key] !== undefined && !files.has(entry[key])) throw new Error('Broken canonical module reference: ' + entry[key]);
    }
  }
  await loadCapabilityGroups(snapshot);
  return snapshot;
}

async function openArchive(bytes: Buffer, revision: string) {
  const prefix = 'skills-' + revision + '/';
  let expanded = 0;
  const entries = unzipSync(bytes, { filter(entry) {
    if (!entry.name.startsWith(prefix)) throw new Error('Unexpected canonical archive root');
    const path = entry.name.slice(prefix.length);
    if (!path || path.endsWith('/')) return false;
    expanded += entry.originalSize;
    if (!validPath(path) || expanded > 128 * 1024 * 1024) throw new Error('Invalid canonical Skills archive');
    return true;
  } });
  return validateSnapshot({
    revision, files: Object.keys(entries).map(name => name.slice(prefix.length)).sort(),
    async read(path) { return Buffer.from(entries[prefix + path]); },
  });
}

async function download(url: string, request: typeof fetch, accept: string, limit: number) {
  const response = await request(url, {
    headers: { Accept: accept, 'User-Agent': 'JoomEngine-Playground-MCP', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok || !response.body) throw new Error('GitHub Skills download returned HTTP ' + response.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('GitHub Skills download exceeds the supported size');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function replaceFile(path: string, data: Buffer | string) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Maintain a whole revision; a failed refresh always leaves the previous revision usable. */
export class SkillDistribution {
  private readonly bundle: string;
  private readonly cache: string;
  private readonly offline: boolean;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private initial?: Promise<void>;
  private update?: Promise<void>;
  private bundled!: Snapshot;
  private current!: Snapshot;
  private source: Source = 'bundled';
  private checkedAt = 0;
  private remoteRevision?: string;
  private error?: string;

  constructor(options: Options = {}) {
    this.bundle = options.bundle ?? bundlePath;
    this.cache = options.cache ?? process.env.JOOMENGINE_SKILLS_CACHE ??
      join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'joomengine-mcp', 'skills');
    this.offline = options.offline ?? process.env.JOOMENGINE_SKILLS_OFFLINE === '1';
    this.request = options.request ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private directory() { return join(this.cache, this.bundled.revision); }

  private async load() {
    const manifest = JSON.parse(await readFile(join(this.bundle, 'manifest.json'), 'utf8'));
    this.bundled = await validateSnapshot({
      revision: manifest.revision, files: manifest.files,
      read: path => readFile(join(this.bundle, 'joomengine-jcb', path)),
    });
    this.current = this.bundled;
    try {
      const receipt: Receipt = JSON.parse(await readFile(join(this.directory(), 'current.json'), 'utf8'));
      if (!sha.test(receipt.revision) || !(receipt.checkedAt > 0 && receipt.checkedAt <= this.now())) return;
      if (receipt.revision !== this.bundled.revision) {
        const bytes = await readFile(join(this.directory(), receipt.revision + '.zip'));
        if (bytes.length > maxArchive || digest(bytes) !== receipt.digest) return;
        this.current = await openArchive(bytes, receipt.revision);
        this.source = 'cached';
      }
      this.checkedAt = receipt.checkedAt;
      this.remoteRevision = receipt.revision;
    } catch { /* The npm bundle remains available on a fresh or damaged cache. */ }
  }

  private async refresh() {
    this.checkedAt = this.now();
    try {
      const revision = (await download(commitEndpoint, this.request, 'application/vnd.github.sha', 100)).toString().trim();
      if (!sha.test(revision)) throw new Error('GitHub returned an invalid Skills revision');
      this.remoteRevision = revision;
      let bytes: Buffer | undefined;
      if (revision === this.bundled.revision) {
        this.current = this.bundled;
        this.source = 'bundled';
      } else if (revision !== this.current.revision) {
        bytes = await download(archiveEndpoint + revision, this.request, 'application/zip', maxArchive);
        const snapshot = await openArchive(bytes, revision);
        this.current = snapshot;
        this.source = 'upstream';
      }
      this.error = undefined;
      const directory = this.directory();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // An archive becomes visible before its receipt. Concurrent processes can safely use each immutable archive.
      const archive = join(directory, revision + '.zip');
      if (bytes) await replaceFile(archive, bytes);
      const receipt: Receipt = { revision, checkedAt: this.checkedAt };
      if (revision !== this.bundled.revision) receipt.digest = digest(bytes ?? await readFile(archive));
      await replaceFile(join(directory, 'current.json'), JSON.stringify(receipt));
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  async snapshot(force = false) {
    this.initial ??= this.load().catch(error => { this.initial = undefined; throw error; });
    await this.initial;
    if (!this.offline && (force || !this.checkedAt || this.now() - this.checkedAt >= refreshInterval)) {
      this.update ??= this.refresh().finally(() => { this.update = undefined; });
    }
    await this.update;
    return this.current;
  }

  async status(force = false) {
    const current = await this.snapshot(force);
    return { repository, revision: current.revision, bundledRevision: this.bundled.revision,
      remoteRevision: this.remoteRevision ?? null, source: this.source, fileCount: current.files.length,
      offline: this.offline, checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
      refreshError: this.error ?? null };
  }
}
