// Run only on a fresh JCB + MCP acceptance site. This exercise changes its JCB definitions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

async function invoke(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 16 * 60_000 });
  const message = result.content?.find(part => part.type === 'text')?.text;
  assert.notEqual(result.isError, true, name + ': ' + message);
  return result.structuredContent ?? JSON.parse(message);
}

async function assertArchive(call, artifact, expected) {
  assert.equal(artifact.sha256, expected.sha256);
  assert.equal(artifact.size, expected.size);
  const digest = createHash('sha256');
  let offset = 0;
  do {
    const part = await call('artifact_read', { id: artifact.id, offset });
    assert.equal(part.offset, offset);
    const bytes = Buffer.from(part.base64, 'base64');
    if (offset === 0) assert.equal(bytes.readUInt32LE(), 0x04034b50);
    offset += bytes.length;
    digest.update(bytes);
    if (part.nextOffset === null) break;
    assert.equal(part.nextOffset, offset);
    assert.ok(bytes.length > 0);
  } while (offset < expected.size);
  assert.equal(offset, expected.size);
  assert.equal(digest.digest('hex'), expected.sha256);
}

async function generatedRead(native) {
  const match = await native('joomla_actions_search', { text: 'jcb.api.demo.countr', domain: 'component_api' });
  const action = match.actions.find(row => /\.displaylist\.get\./i.test(row.id));
  assert.ok(action, 'The generated Demo countries endpoint must be present in native discovery');
  const description = await native('joomla_action_describe', { action: action.id });
  assert.equal(description.action.id, action.id);
  const result = await native('joomla_action_read', { action: action.id, transport: 'api', input: { limit: 1 } });
  assert.equal(result.response.status, 200);
  const data = result.response.data.data;
  assert.equal(data.length, 1, 'The generated consumer must return a seeded country');
  assert.ok(data[0].id && data[0].attributes);
  return { id: data[0].id, type: data[0].type, attributes: data[0].attributes.name };
}

export async function exerciseJcb(client, { replaceWorkspaceId } = {}) {
  const call = (name, args) => invoke(client, name, args);
  const native = (name, args) => call('native_call', { name, arguments: args });
  const available = await call('jcb_list_components');
  const demo = available.components.find(c => c.name === 'Demo J6');
  assert.ok(demo, 'The JCB recipe must contain its Demo J6 component');
  const { tablePrefix } = await call('database_query', { sql: 'SELECT 1' });
  assert.match(tablePrefix, /^[A-Za-z0-9_]+$/);
  const sql = (sql, parameters = []) => call('database_query', { sql, parameters });
  const fieldGuid = '5d3d34dd-4876-4c6a-86ab-b4e162f22c08';
  const sourceField = await sql('SELECT xml FROM ' + tablePrefix + 'componentbuilder_field WHERE guid = ?', [fieldGuid]);
  const originalXml = JSON.parse(sourceField.rows[0].xml);
  const authoredXml = originalXml.replace(/maxlength="\d+"/, 'maxlength="117"');
  assert.notEqual(authoredXml, originalXml, 'Expected an editable JCB title-field length');
  const definition = await call('jcb_form', { view: 'field', fields: ['datatype'] });
  assert.deepEqual(Object.keys(definition.schema.properties), ['datatype']);
  assert.ok(definition.schema.properties.datatype.oneOf.some(choice => choice.const === 'VARCHAR'));
  const versionRecord = { key: 'mcp-demo-version', view: 'joomla_component', match: { system_name: 'Demo J6' } };
  const partial = await client.callTool({ name: 'jcb_save_records', arguments: { records: [
    { key: 'mcp-demo-title', view: 'field', guid: fieldGuid, fields: { xml: authoredXml } },
    { ...versionRecord, fields: { missing_acceptance_field: 1 } }
  ] } }, undefined, { timeout: 16 * 60_000 });
  assert.equal(partial.isError, true);
  assert.match(partial.content[0].text, /retry only the skipped keys/);
  assert.deepEqual(partial.structuredContent.results.map(r => [r.key, r.status]), [['mcp-demo-title', 'applied'], ['mcp-demo-version', 'skipped']]);
  const verifySource = async () => {
    const field = await sql('SELECT xml FROM ' + tablePrefix + 'componentbuilder_field WHERE guid = ?', [fieldGuid]);
    assert.equal(JSON.parse(field.rows[0].xml), authoredXml);
  };
  await verifySource();
  const retried = await call('jcb_save_records', { records: [{ ...versionRecord, fields: { component_version: '1.3.7' } }] });
  assert.equal(retried.results[0].status, 'applied', JSON.stringify(retried));
  const author = async () => (await sql('SELECT component_version FROM ' + tablePrefix + 'componentbuilder_joomla_component WHERE id = ?', [demo.id])).rows[0];
  assert.equal((await author()).component_version, '1.3.7');
  const plugins = async () => new Set((await sql("SELECT element FROM " + tablePrefix + "extensions WHERE type = 'plugin' AND folder = 'webservices'")).rows.map(row => row.element));
  const before = await plugins();
  console.log('Compile the authored definition and retrieve its exact package bytes over MCP');
  const compiled = await call('jcb_compile', { componentId: demo.id, joomlaMajor: 6 });
  const component = compiled.packages.find(p => /^com_demo_v1_3_7__J6\.zip$/i.test(p.filename));
  const webservices = compiled.packages.find(p => /^plg_webservices_/i.test(p.filename));
  assert.ok(component && webservices, 'JCB must deliver the authored component version and its linked webservices plugin');
  for (const pkg of [component, webservices]) {
    const retained = await call('file_export', { path: pkg.path });
    await assertArchive(call, retained, pkg);
    assert.equal((await call('extension_install', { artifactId: retained.id })).installed, true);
    await call('artifact_release', { id: retained.id });
  }
  const installedPlugins = [...await plugins()].filter(name => !before.has(name));
  assert.equal(installedPlugins.length, 1);
  await call('extension_enable_plugin', { folder: 'webservices', element: installedPlugins[0] });
  const category = async () => (await native('joomla_action_read', {
    action: 'content.categories.list', transport: 'api', input: { limit: 1 }
  })).response.data.data[0].id;
  const existingCategory = await category();
  const refreshed = await call('jcb_refresh_tools', { component: 'com_demo' });
  assert.ok(refreshed.refreshed && refreshed.apiRoutes > 0, JSON.stringify(refreshed));
  assert.equal(await category(), existingCategory, 'Refreshing Demo must preserve previously available native actions');
  const generatedForm = async () => {
    const file = await call('file_read', { path: '/administrator/components/com_demo/forms/look.xml' });
    assert.match(file.content, /maxlength="117"/, 'The generated installed form must contain the authored JCB field');
  };
  await generatedForm();
  console.log('Read the installed dashboard and generated API, then export and restore the complete site');
  await call('browser_navigate', { path: 'administrator/index.php?option=com_demo' });
  assert.match((await call('browser_inspect')).text, /Demo Dashboard/i);
  const original = await generatedRead(native);
  const archive = await call('site_export', { format: 'bundle' });
  assert.ok(archive.size > component.size && /^[a-f0-9]{64}$/.test(archive.sha256));
  const restored = await call('site_restore', { id: archive.id, ...(replaceWorkspaceId ? { replaceWorkspaceId } : {}) });
  assert.equal(restored.restored, true);
  if (restored.sha256) assert.equal(restored.sha256, archive.sha256);
  await verifySource();
  await generatedForm();
  assert.equal((await author()).component_version, '1.3.7');
  assert.deepEqual(await generatedRead(native), original);
  console.log(JSON.stringify({ component: component.filename, compilerSha256: component.sha256, extensionApi: original, restoredSiteSha256: archive.sha256 }));
}
