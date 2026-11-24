import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJoomlaProvider, connectComposerProvider } from '../dist/joomla.js';
import { joomlaApi } from '../dist/joomla-browser.js';

test('published TypeScript server discovers and executes a category read through the workspace', async () => {
  const calls = [];
  const provider = await createJoomlaProvider({ call: async (operation, payload) => {
    if (operation === 'workspace_info') return { workspaceId: 'cloud-test', siteUrl: 'https://example.test/__site/fixture/' };
    calls.push({ operation, payload });
    return { status: 200, headers: {}, data: { data: [{ type: 'categories', id: '42', attributes: { title: 'Playground test' } }] } };
  } });
  try {
    const info = await provider.describe('provider_info', {});
    assert(info.capabilities.tools && info.capabilities.resources);
    const resources = await provider.describe('provider_resources', {});
    const catalogueUri = resources.resources.find(entry => entry.uri === 'joomla://catalog/core')?.uri;
    assert(catalogueUri);
    const metadata = await provider.describe('provider_resource', { uri: catalogueUri });
    assert(metadata.contents[0].text.length > 0);
    assert.deepEqual(await provider.describe('provider_prompts', {}), { prompts: [] });
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
  const identity = { workspaceId: 'fixture', siteUrl: 'https://fixture.test/__site/instance/' };
  const runtime = {
    workspace: { id: identity.workspaceId }, baseUrl: identity.siteUrl,
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
    ...identity, path: 'v1/content/articles/3', method: 'PATCH', body: { title: 'Change' },
    query: { filter: ['one', 'two'] }, etag: 'revision', idempotencyKey: 'intent1'
  });
  assert.equal(result.data.id, 3);
  assert.equal(result.headers.etag, 'new');
  assert(!JSON.stringify(result).includes(token));
  assert(!Object.hasOwn(result.headers, 'set-cookie'));
  await assert.rejects(joomlaApi(runtime, { ...identity, path: 'v1/%2E%2e/admin', method: 'GET' }));
  await assert.rejects(joomlaApi(runtime, { ...identity, workspaceId: 'another', path: 'v1/content/categories', method: 'GET' }), /site changed/);
  assert.equal(requests, 1);
});

test('Composer site names cannot contain launcher arguments', async () => {
  await assert.rejects(connectComposerProvider('--help'), /Invalid Composer site alias/);
});

test('the embedded JCB provider verifies a permanent delete against the same browser site', async () => {
  const collection = 'v1/componentbuilder/languages';
  const item = { id: '7', type: 'languages', attributes: { id: 7, name: 'Fixture', langtag: 'en-NZ', published: -2 } };
  let removed = false;
  const requests = [];
  const provider = await createJoomlaProvider({ call: async (operation, args) => {
    if (operation === 'workspace_info') return { workspaceId: 'local', siteUrl: 'https://example.test/__site/jcb/' };
    assert.equal(operation, 'joomla.api');
    assert.equal(args.workspaceId, 'local');
    requests.push([args.method, args.path]);
    if (args.method === 'GET' && args.path === collection) {
      return { status: 200, headers: {}, data: { data: removed ? [] : [item] } };
    }
    assert.equal(args.path, collection + '/7');
    if (args.method === 'DELETE') {
      removed = true;
      return { status: 204, headers: {}, data: null };
    }
    assert.equal(args.method, 'GET');
    return removed ? { status: 404, headers: {}, data: null } : { status: 200, headers: {}, data: { data: item } };
  } });
  const call = async (name, args) => {
    const result = await provider.callTool(name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return result.structuredContent;
  };
  try {
    const action = 'jcb.api.languages.delete';
    const discovery = await call('joomla_actions_search', { domain: 'jcb', text: action, includeWrites: true });
    assert(discovery.actions.some(entry => entry.id === action));
    const form = await call('joomla_action_describe', { action: 'jcb.api.languages.create' });
    assert.equal(form.availability.executable, true);
    const permission = await call('joomla_permission_request', {
      toolsets: ['jcb.write'], duration: 'once', reason: 'Remove the test language',
    });
    await call('joomla_permission_approve', { requestId: permission.requestId, acknowledgement: permission.acknowledgement });
    const plan = await call('joomla_action_write_plan', {
      action, transport: 'api', input: { id: 7 }, idempotencyKey: '409aadf1-c1f7-4f43-bc47-824fa196ba05', dryRun: false,
    });
    const result = await call('joomla_write_apply', { confirmationToken: plan.confirmationToken });
    assert.equal(result.verification.status, 'verified', JSON.stringify(result.verification));
    assert.deepEqual(requests.slice(-3), [['DELETE', collection + '/7'], ['GET', collection + '/7'], ['GET', collection]]);
  } finally { await provider.close(); }
});
