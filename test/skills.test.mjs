import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { getSkillPrompt, listSkillResources, readSkillResource, skillPrompts } from '../dist/skills.js';

const bundle = new URL('../skills/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', bundle), 'utf8'));
const start = 'joomengine://skills/SKILL.md';

test('discovery lists every file of the resolved checkout exactly once across pages', async () => {
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  const resources = [];
  let cursor;
  do {
    const page = await listSkillResources(cursor);
    assert.ok(page.resources.length > 0 && page.resources.length <= 50);
    resources.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(resources[0].uri, start);
  assert.match(resources[0].description, new RegExp(manifest.revision));
  assert.deepEqual(resources.map(info => info.name).sort(), [...manifest.files].sort());
  assert.equal(new Set(resources.map(info => info.uri)).size, manifest.files.length);
  assert.ok(resources.some(resource => resource.name === 'LICENSE'));
  assert.ok(resources.some(resource => resource.name === 'tools/check.sh'));
  await assert.rejects(listSkillResources('old-revision:50'), { code: -32602 });
});

test('relative Markdown links, registry data and binary evidence resolve offline', async () => {
  const registry = new URL('../../registries/skills.json#skills', 'joomengine://skills/testing/playground/SKILL.md');
  const { contents: [reference] } = await readSkillResource(registry.href);
  assert.equal(reference.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(reference.text), JSON.parse(await readFile(new URL('joomengine-jcb/registries/skills.json', bundle), 'utf8')));
  const photo = manifest.files.find(path => path.endsWith('.jpg'));
  const { contents: [image] } = await readSkillResource(`joomengine://skills/${photo}`);
  assert.equal(image.mimeType, 'image/jpeg');
  assert.deepEqual(Buffer.from(image.blob, 'base64'), await readFile(new URL(`joomengine-jcb/${photo}`, bundle)));
  await assert.rejects(readSkillResource('file:///etc/passwd'), { code: -32602 });
  await assert.rejects(readSkillResource('joomengine://skills/%2E%2E%2Fpackage.json'), { code: -32602 });
  await assert.rejects(readSkillResource('joomengine://skills/missing/file'), { code: -32002 });
});

test('workflow prompts embed the canonical root and corresponding packaged instructions', async () => {
  for (const { name } of skillPrompts) {
    const prompt = await getSkillPrompt(name);
    const [root, workflow] = prompt.messages.filter(message => message.content.type === 'resource');
    assert.equal(root.content.resource.uri, start);
    const { contents: [source] } = await readSkillResource(workflow.content.resource.uri);
    assert.equal(workflow.content.resource.text, source.text);
  }
  await assert.rejects(getSkillPrompt('unknown'), { code: -32602 });
});
