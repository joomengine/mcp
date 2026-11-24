import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Invoke against a real disposable owner through cloud stdio, attached browser, or desktop transport. */
export async function exerciseDeployment(call) {
  const marker = 'MCP ' + randomUUID().slice(0, 8);
  const target = { kind: 'component', component: 'com_content' };
  const inventory = await call('deployment_discover', {});
  assert(inventory.sections.configurationTargets > 0);
  const page = await call('deployment_discover', { section: 'configurationTargets', limit: 1 });
  assert.equal(page.items.length, 1);
  const fields = await call('deployment_discover', { target });
  assert(fields.schema);
  const { captures } = await call('deployment_capture', { target });
  assert.equal(captures[0].overlay.component, 'com_content');
  assert(Array.isArray(captures[0].related));

  const original = (await call('deployment_export', {})).document;
  const applied = await call('deployment_configure', { configuration: { siteName: marker } });
  assert.equal(applied.siteName, marker);
  await call('workspace_flush', {});
  assert((await call('file_read', { path: '/configuration.php' })).content.includes(marker));
  const saved = await call('deployment_recipe_save', { name: marker });
  assert.match(saved.id, /^custom-/);
  assert.equal((await call('deployment_recipes', {})).recipes.find(r => r.id === saved.id).revision, saved.revision);
  const privateRecipe = (await call('deployment_export', { format: 'private', source: { deployId: saved.id } })).document;
  assert.equal(privateRecipe.schemaVersion, 3);
  assert.equal(privateRecipe.configuration.siteName, marker);
  const transferred = await call('deployment_recipe_save', { name: marker + ' imported', source: { document: privateRecipe } });
  const renamed = await call('deployment_recipe_save', { id: saved.id, expectedRevision: saved.revision,
    name: marker + ' renamed', source: { deployId: saved.id } });
  assert.notEqual(renamed.revision, saved.revision);
  await assert.rejects(call('deployment_recipe_delete', { id: saved.id, expectedRevision: saved.revision }), /changed|revision/i);
  const { url } = await call('deployment_export', { format: 'share', source: { deployId: 'blank' } });
  const shared = (await call('deployment_export', { source: { shareURL: url } })).document;
  assert.equal(shared.configuration.deployId, 'blank');
  assert.equal(shared.configuration.admin, undefined);
  for (const entry of [renamed, transferred]) {
    assert.equal((await call('deployment_recipe_delete', { id: entry.id, expectedRevision: entry.revision })).deleted, true);
  }
  assert(!(await call('deployment_recipes', {})).recipes.some(r => [saved.id, transferred.id].includes(r.id)));

  const vars = original.configuration.phpSettings?.max_input_vars ?? 10000;
  const changedVars = vars === 50000 ? vars - 1 : vars + 1;
  const php = await call('deployment_configure', { configuration: { phpSettings: { max_input_vars: changedVars } } });
  assert.equal(php.phpSettings.max_input_vars, changedVars);
  const path = '/deployment-proof-' + randomUUID() + '.php';
  const proof = await call('file_write', { path, expectedRevision: null, content: "<?php header('Content-Type: text/plain'); echo ini_get('max_input_vars');" });
  assert.equal((await call('site_request', { path })).body.trim(), String(changedVars));
  await call('file_manage', { action: 'delete', path, expectedRevision: proof.revision });
  await call('deployment_configure', { configuration: { phpSettings: { max_input_vars: vars } } });

  const restored = await call('deployment_configure', { configuration: { siteName: original.configuration.siteName } });
  assert.equal(restored.siteName, original.configuration.siteName);
}

/** Run last, since opening a portable deployment intentionally creates a different installation. */
export async function exerciseDeploymentLaunch(call) {
  const previous = await call('workspace_info', {});
  const marker = randomUUID().replaceAll('-', '');
  const path = '/deployment-copy-' + marker + '.txt';
  const table = 'mcp_copy_' + marker;
  await call('file_write', { path, expectedRevision: null, content: marker });
  await call('database_query', { sql: 'CREATE TABLE ' + table + ' (marker VARCHAR(64) NOT NULL)' });
  await call('database_query', { sql: 'INSERT INTO ' + table + ' VALUES (?)', parameters: [marker] });
  const copy = await call('deployment_clone', { replaceWorkspaceId: previous.workspaceId, configuration: { siteName: 'MCP copy ' + marker } });
  assert.notEqual(copy.workspaceId, previous.workspaceId);
  assert.equal((await call('workspace_info', {})).workspaceId, copy.workspaceId);
  assert.equal((await call('file_read', { path })).content, marker);
  assert.equal((await call('database_query', { sql: 'SELECT marker FROM ' + table })).rows[0].marker, marker);

  const siteName = 'MCP imported ' + marker;
  const document = { schemaVersion: 1, configuration: { deployId: 'blank', siteName } };
  await call('deployment_launch', { replaceWorkspaceId: copy.workspaceId, source: { document } });
  const current = await call('workspace_info', {});
  assert.notEqual(current.workspaceId, copy.workspaceId);
  assert.equal(current.deployId, 'blank');
  assert.equal(current.siteName, siteName);
  const check = await call('database_query', { sql: 'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', parameters: [table] });
  assert.equal(Number(check.rows[0].n), 0);
  assert((await call('file_read', { path: '/configuration.php' })).content.includes(siteName));
}
