import assert from 'node:assert/strict';
import test from 'node:test';
import { attachWorkspace } from '../dist/attach.js';

test('attachment accepts an operator-selected local debugger and trusted Playground shell only', async () => {
  for (const endpoint of [
    'http://example.com:9222/', 'http://127.0.0.1:9222/json/list', 'ws://127.0.0.1:9222/devtools/browser/all-tabs',
    'http://user:password@127.0.0.1:9222', 'http://localhost:9222/?page=1', 'https://127.0.0.1:9222',
  ]) await assert.rejects(attachWorkspace({endpoint}), /loopback/);
  for (const playgroundUrl of ['http://example.com/', 'https://example.com/?profile=foo', 'https://user:pass@example.com/', 'https://example.com/playground']) {
    await assert.rejects(attachWorkspace({endpoint:'http://127.0.0.1:9222', playgroundUrl}), /Playground base URL/);
  }
});
