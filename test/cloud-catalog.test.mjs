import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { getDeploymentCatalog } from '../dist/browser.js';

test('list deployed recipes and compatible releases without launching Chromium', async () => {
  const php = [{ version: '8.3', patchVersion: '8.3.7' }, { version: '8.4', patchVersion: '8.4.10' }];
  const files = {
    'assets/manifest.json': { sourceCommit: 'test', defaults: { phpVersion: '8.4', joomlaVersion: '6.2.0' },
      php, joomla: [{ version: '6.2.0', php: ['8.3', '8.4'] }] },
    'deploys/catalog.json': { deploys: [{ id: 'blank', title: 'Joomla only', joomla: ['6'], requirements: { jcb: 'optional' } }] },
    'assets/version-catalog.json': { generatedAt: '2026-11-24T00:00:00Z', joomla: [
      { version: '6.2.1', channel: 'stable', phpMinimum: '8.3.8' }, { version: '7.0.0-dev', channel: 'nightly', phpMinimum: '8.5.0' }
    ], jcb: [{ version: '6.2.1', channel: 'stable' }] }
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname.slice('/demo/'.length);
    res.writeHead(files[path] ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(files[path] ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await getDeploymentCatalog({ baseURL: 'http://127.0.0.1:' + server.address().port + '/demo' });
    assert.equal(result.defaults.joomlaVersion, '6.2.1');
    assert.deepEqual(result.joomla, [{ version: '6.2.1', channel: 'stable', php: ['8.4'] }]);
    assert.deepEqual(result.stagedJoomla[0], { version: '6.2.0', php: ['8.3', '8.4'] });
    assert.equal(result.recipes[0].id, 'blank');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
