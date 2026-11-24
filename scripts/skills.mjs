import { execFileSync } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the canonical default branch once. Record the exact offline fallback in the package.
const repository = 'https://github.com/joomengine/skills.git';
const project = fileURLToPath(new URL('../', import.meta.url));
const stage = await mkdtemp(join(project, '.skills-build-'));
const checkout = join(stage, 'joomengine-jcb');
const destination = join(project, 'skills');
const previous = `${stage}-previous`;
let replaced = false;

try {
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '--depth=1', '--single-branch', '--no-tags',
    '--', repository, checkout], { stdio: 'inherit' });
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
  const branch = git('branch', '--show-current').trim();
  const revision = git('rev-parse', 'HEAD').trim();
  const files = git('ls-files', '--stage', '-z').split('\0').filter(Boolean).map(entry => {
    const separator = entry.indexOf('\t');
    const metadata = entry.slice(0, separator);
    const path = entry.slice(separator + 1);
    if (!/^100(?:644|755) [0-9a-f]+ 0$/.test(metadata)) {
      throw new Error(`Unsupported non-regular entry in skills repository: ${path}`);
    }
    return path;
  });
  for (const required of ['SKILL.md', 'AGENTS.md', 'LICENSE', 'registries/skills.json']) {
    if (!files.includes(required)) throw new Error(`Incomplete skills checkout: missing ${required}`);
  }
  await rm(join(checkout, '.git'), { recursive: true });
  await writeFile(join(stage, 'manifest.json'), JSON.stringify({ repository, branch, revision, files }, null, 2) + '\n');

  try {
    await rename(destination, previous);
    replaced = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(stage, destination);
  } catch (error) {
    if (replaced) await rename(previous, destination);
    throw error;
  }
  if (replaced) await rm(previous, { recursive: true });
  console.log(`Packaged joomengine/skills@${revision} (${files.length} files).`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
