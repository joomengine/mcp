import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJoomlaProvider, connectComposerProvider } from '../dist/joomla.js';
import { joomlaApi } from '../dist/joomla-browser.js';

test('published TypeScript server discovers and executes a category read through the workspace', async () => {
  const calls = [];
  const provider = await createJoomlaProvider({ call: async (operation, payload) => {
    calls.push({ operation, payload });
    return { status: 200, headers: {}, data: { data: [{ type: 'categories', id: '42', attributes: { title: 'Playground test' } }] } };
  } });
  try {
    const catalogue = await provider.listTools();
    assert(catalogue.tools.some(tool => tool.name === 'joomla_action_read'));
    const result = await provider.callTool('joomla_action_read', { action: 'content.categories.list', transport: 'api' });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, /Playground test/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation, 'joomla.api');
    assert.equal(calls[0].payload.method, 'GET');
    assert.equal(calls[0].payload.path, 'v1/content/categories');
    assert.equal(calls[0].payload.token, undefined);
  } finally { await provider.close(); }
});

test('browser transport retains native token, bounds routes and preserves optimistic writes', async () => {
  const token = 'private-credential-for-active-workspace';
  let requests = 0;
  const runtime = {
    getMcpConnection: async () => ({ installed: true, token }),
    request: async (path, options) => {
      requests++;
      assert.equal(path, 'api/index.php/v1/content/articles/3?filter=one&filter=two');
      assert.equal(options.headers['X-Joomla-Token'], token);
      assert.equal(options.headers['If-Match'], 'revision');
      assert.equal(options.headers['Idempotency-Key'], 'intent1');
      assert.equal(options.body, '{"title":"Change"}');
      return Response.json({ id: 3, message: 'echo ' + token }, { headers: { etag: 'new', 'set-cookie': 'private' } });
    }
  };
  const result = await joomlaApi(runtime, {
    path: 'v1/content/articles/3', method: 'PATCH', body: { title: 'Change' },
    query: { filter: ['one', 'two'] }, etag: 'revision', idempotencyKey: 'intent1'
  });
  assert.equal(result.data.id, 3);
  assert.equal(result.headers.etag, 'new');
  assert(!JSON.stringify(result).includes(token));
  assert(!Object.hasOwn(result.headers, 'set-cookie'));
  await assert.rejects(joomlaApi(runtime, { path: 'v1/%2E%2e/admin', method: 'GET' }));
  assert.equal(requests, 1);
});

test('Composer site names cannot contain launcher arguments', async () => {
  await assert.rejects(connectComposerProvider('--help'), /Invalid Composer site alias/);
});
