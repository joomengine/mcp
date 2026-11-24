import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeDispatch } from '../dist/joomla-native.js';

test('the native bridge keeps one session across discovery, grants and calls, then releases it on close', async () => {
  const calls = [];
  const info = { serverInfo: { name: 'site-native', version: '1' }, capabilities: { tools: {}, resources: {}, prompts: {} } };
  const client = {
    request: async (method, params) => { calls.push({ method, params }); return { ok: true }; },
    close: async () => { calls.push({ method: 'close' }); }
  };
  const key = Symbol.for('joomengine.mcp.site-native-session');
  const runtime = { baseUrl: 'https://example.com/__site/one/', workspace: { id: 'one' } };
  runtime[key] = { workspaceId: 'one', siteUrl: runtime.baseUrl, client, info };
  assert.equal((await nativeDispatch(runtime, 'native_info', {})).serverInfo, info.serverInfo);
  await nativeDispatch(runtime, 'native_resources', { cursor: 'next-page' });
  await nativeDispatch(runtime, 'native_call', { name: 'confirm', arguments: { plan: 'plan' } });
  await nativeDispatch(runtime, 'native_prompt', { name: 'verify', arguments: { component: 'com_demo' } });
  await nativeDispatch(runtime, 'native_close', {});
  assert.deepEqual(calls, [
    { method: 'resources/list', params: { cursor: 'next-page' } },
    { method: 'tools/call', params: { name: 'confirm', arguments: { plan: 'plan' } } },
    { method: 'prompts/get', params: { name: 'verify', arguments: { component: 'com_demo' } } },
    { method: 'close' },
  ]);
  assert.equal(runtime[key], undefined);
  runtime[key] = { workspaceId: 'old', siteUrl: runtime.baseUrl, client, info };
  runtime.getMcpConnection = async () => ({ installed: false });
  await assert.rejects(nativeDispatch(runtime, 'native_call', { name: 'confirm' }), /unavailable/);
  assert.equal(calls.length, 4, 'A stale session cannot operate on the new Joomla site');
});
