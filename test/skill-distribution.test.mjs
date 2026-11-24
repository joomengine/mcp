import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { zipSync } from 'fflate';
import { apiEndpoint, gitAdvertisement, gitEndpoint } from './skills-endpoints.mjs';
import { SkillDistribution } from '../dist/skill-distribution.js';

test('adopts one complete upstream revision and preserves verified content during interrupted updates and offline restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundle = join(dir, 'bundle'), cache = join(dir, 'cache');
  const base = 'a'.repeat(40), next = 'b'.repeat(40);
  const files = { 'SKILL.md': 'bundled', 'AGENTS.md': 'agent guide', LICENSE: 'license',
    'registries/skills.json': JSON.stringify({ skills: [{ name: 'root', path: 'SKILL.md' }] }),
    'registries/modules.json': JSON.stringify({ modules: [] }),
    'registries/playground-mcp.json': JSON.stringify({ version: 1, capabilities: [
      { id: 'discovery', title: 'Discover', tools: ['skills_*'], guides: ['SKILL.md'] },
    ] }) };
  await mkdir(join(bundle, 'joomengine-jcb', 'registries'), { recursive: true });
  for (const [path, text] of Object.entries(files)) await writeFile(join(bundle, 'joomengine-jcb', path), text);
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ revision: base, files: Object.keys(files) }));

  let remote = next, broken = false, calls = 0;
  let advertisement = gitAdvertisement, apiAvailable = false, apiCalls = 0;
  const request = async (url, options) => {
    calls++;
    if (url === gitEndpoint) {
      assert.equal(options.headers.Accept, 'application/x-git-upload-pack-advertisement');
      return new Response(advertisement(remote));
    }
    if (url === apiEndpoint) {
      apiCalls++;
      return apiAvailable ? new Response(remote) : new Response('API rate limit exceeded', { status: 403 });
    }
    assert.equal(url, 'https://codeload.github.com/joomengine/skills/zip/' + remote);
    const contents = { ...files, 'SKILL.md': 'updated guide', 'new/workflow.md': 'new instructions' };
    if (broken) delete contents.LICENSE;
    return new Response(zipSync(Object.fromEntries(Object.entries(contents).map(
      ([name, text]) => ['skills-' + remote + '/' + name, Buffer.from(text)]))));
  };
  const provider = new SkillDistribution({ bundle, cache, request, offline: false });
  const [first, same] = await Promise.all([provider.snapshot(), provider.snapshot()]);
  assert.equal(first, same);
  assert.equal(calls, 2);
  assert.equal(apiCalls, 0, 'Git HEAD and its immutable archive work without the rate-limited API');
  assert.equal((await first.read('new/workflow.md')).toString(), 'new instructions');
  assert.equal((await provider.status()).source, 'upstream');
  advertisement = revision => gitAdvertisement(revision, 'refs/heads/unrelated');
  const missingHead = await provider.status(true);
  assert.equal(missingHead.revision, next);
  assert.match(missingHead.refreshError, /Git did not advertise a valid HEAD.*HTTP 403/);
  advertisement = revision => gitAdvertisement(revision).slice(0, 68);
  const truncated = await provider.status(true);
  assert.match(truncated.refreshError, /Invalid Git upload-pack advertisement.*HTTP 403/);
  apiAvailable = true;
  assert.equal((await provider.status(true)).refreshError, null, 'API fallback for blocked or invalid Git responses');
  advertisement = gitAdvertisement;
  remote = 'c'.repeat(40); broken = true;
  const failure = await provider.status(true);
  assert.equal(failure.revision, next);
  assert.equal(failure.remoteRevision, remote);
  assert.match(failure.refreshError, /Incomplete/);

  const offline = new SkillDistribution({ bundle, cache, offline: true,
    request() { assert.fail('Offline mode contacted the network'); } });
  assert.equal((await offline.status(true)).source, 'cached');
  assert.equal((await (await offline.snapshot()).read('SKILL.md')).toString(), 'updated guide');
  const archives = (await readdir(join(cache, base))).filter(path => path.endsWith('.zip'));
  assert(archives.length > 0);
  for (const archive of archives) await writeFile(join(cache, base, archive), 'truncated archive');
  const recovered = new SkillDistribution({ bundle, cache, offline: true });
  assert.equal((await recovered.status()).revision, base);
  assert.equal((await (await recovered.snapshot()).read('SKILL.md')).toString(), 'bundled');

  const raceCache = join(dir, 'race');
  const startedAt = Date.now();
  let releaseSlow, startSlow;
  const slowStarted = new Promise(resolve => { startSlow = resolve; });
  const holdSlow = new Promise(resolve => { releaseSlow = resolve; });
  const requester = (rev, delayed = false) => async url => {
    if (url === gitEndpoint) {
      if (delayed) { startSlow(); await holdSlow; }
      return new Response(gitAdvertisement(rev));
    }
    return new Response(zipSync(Object.fromEntries(Object.entries(files).map(
      ([name, text]) => ['skills-' + rev + '/' + name, Buffer.from(text)]))));
  };
  const slow = new SkillDistribution({ bundle, cache: raceCache, offline: false, now: () => startedAt,
    request: requester('d'.repeat(40), true) });
  const fast = new SkillDistribution({ bundle, cache: raceCache, offline: false, now: () => startedAt + 1,
    request: requester('e'.repeat(40)) });
  const waiting = slow.snapshot();
  await slowStarted;
  await fast.snapshot();
  releaseSlow();
  await waiting;
  const restarted = new SkillDistribution({ bundle, cache: raceCache, offline: true, now: () => startedAt + 2 });
  assert.equal((await restarted.status()).revision, 'e'.repeat(40));
});
