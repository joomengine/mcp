import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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
const cacheEntry = /^(\d{13})-([a-f0-9]{40})-(bundled|[a-f0-9]{64}\.zip)$/;
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
  private archive?: Buffer;
  private source: Source = 'bundled';
  private checkedAt = 0;
  private remoteRevision?: string;
  private observedRevision?: string;
  private readonly revisionListeners = new Set<() => void>();
  private error?: string;

  constructor(options: Options = {}) {
    this.bundle = options.bundle ?? bundlePath;
    this.cache = options.cache ?? process.env.JOOMENGINE_SKILLS_CACHE ??
      join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'joomengine-mcp', 'skills');
    this.offline = options.offline ?? process.env.JOOMENGINE_SKILLS_OFFLINE === '1';
    this.request = options.request ?? fetch;
    this.now = options.now ?? Date.now;
  }

  onRevisionChanged(listener: () => void) {
    this.revisionListeners.add(listener);
    return () => this.revisionListeners.delete(listener);
  }

  private directory() { return join(this.cache, this.bundled.revision); }

  private async load() {
    const manifest = JSON.parse(await readFile(join(this.bundle, 'manifest.json'), 'utf8'));
    this.bundled = await validateSnapshot({
      revision: manifest.revision, files: manifest.files,
      read: path => readFile(join(this.bundle, 'joomengine-jcb', path)),
    });
    this.current = this.bundled;
    for (const name of await this.cacheEntries()) {
      const [, at, revision, suffix] = name.match(cacheEntry)!;
      if (Number(at) > this.now()) continue;
      try {
        if (suffix === 'bundled') {
          if (revision !== this.bundled.revision) continue;
        } else {
          const bytes = await readFile(join(this.directory(), name));
          if (bytes.length > maxArchive || digest(bytes) + '.zip' !== suffix) continue;
          this.current = await openArchive(bytes, revision);
          this.archive = bytes;
          this.source = 'cached';
        }
        this.checkedAt = Number(at);
        this.remoteRevision = revision;
        return;
      } catch { /* Try the preceding verified snapshot if this file is damaged or rotated. */ }
    }
  }

  private async cacheEntries() {
    try {
      return (await readdir(this.directory())).filter(name => cacheEntry.test(name)).sort().reverse();
    } catch {
      return [];
    }
  }

  private async cacheSnapshot() {
    const directory = this.directory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const suffix = this.archive ? digest(this.archive) + '.zip' : 'bundled';
    const filename = this.checkedAt + '-' + this.current.revision + '-' + suffix;
    // Ordering by observation time keeps a slow process from replacing a newer revision.
    await replaceFile(join(directory, filename), this.archive ?? '');
    const old = (await this.cacheEntries()).slice(2);
    await Promise.all(old.map(name => rm(join(directory, name), { force: true })));
  }

  private async refresh() {
    this.checkedAt = this.now();
    try {
      const revision = (await download(commitEndpoint, this.request, 'application/vnd.github.sha', 100)).toString().trim();
      if (!sha.test(revision)) throw new Error('GitHub returned an invalid Skills revision');
      this.remoteRevision = revision;
      if (revision === this.bundled.revision) {
        this.current = this.bundled;
        this.source = 'bundled';
        this.archive = undefined;
      } else if (revision !== this.current.revision) {
        const bytes = await download(archiveEndpoint + revision, this.request, 'application/zip', maxArchive);
        const snapshot = await openArchive(bytes, revision);
        this.current = snapshot;
        this.archive = bytes;
        this.source = 'upstream';
      }
      this.error = undefined;
      await this.cacheSnapshot();
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
    const previous = this.observedRevision;
    this.observedRevision = this.current.revision;
    if (previous !== undefined && previous !== this.observedRevision) {
      for (const listener of this.revisionListeners) listener();
    }
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
