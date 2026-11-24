// Author a fresh native JCB graph in an isolated site, then exercise its generated administrator form.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'fresh-notes-acceptance', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), stderr: 'inherit',
});
async function call(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 16 * 60_000 });
  const output = reply.content.find(x => x.type === 'text')?.text;
  assert.notEqual(reply.isError, true, name + ': ' + output);
  return reply.structuredContent ?? JSON.parse(output);
}
async function defaults(view) {
  const { schema } = await call('jcb_form', { view });
  // A JCB model can remove conditional fields from a specific installation's
  // native form. Only use defaults actually declared by that form.
  return Object.fromEntries((schema.required ?? []).flatMap(key => {
    const { default: value } = schema.properties[key];
    return value === undefined || value === '' || value === null ? [] : [[key, value]];
  }));
}
const admin = '/administrator/index.php?option=com_mcpnotebook';
const ids = { field: randomUUID(), view: randomUUID(), component: randomUUID() };
const xml = '<field type="text" name="title" label="Title" description="Note title" maxlength="120" required="true" filter="STRING" />';
try {
  await client.connect(transport);
  const guide = await client.readResource({ uri: 'joomengine://skills/testing/scenarios/notes-admin-verification.md' });
  assert.match(guide.contents[0].text, /Notes/);
  await call('workspace_open', { deployId: 'jcb-mcp' });
  const [fieldDefaults, viewDefaults, componentDefaults] = await Promise.all(['field', 'admin_view', 'joomla_component'].map(defaults));
  const { tablePrefix } = await call('database_query', { sql: 'SELECT 1' });
  assert.match(tablePrefix, /^[A-Za-z0-9_]+$/);
  const read = async (sql, parameters = []) => (await call('database_query', { sql, parameters })).rows;
  const rows = await read('SELECT guid FROM ' + tablePrefix + 'componentbuilder_fieldtype WHERE guid = ?', ['201327fe-3067-4316-a155-3fe2a52e05c0']);
  assert.equal(rows.length, 1, 'The native Joomla Text field type is required');
  console.log('Create a new component, concrete Title field, Note view, field assignment and component view assignment');
  const created = await call('jcb_save_records', { records: [
    { key: 'notes-title', view: 'field', guid: ids.field, fields: { ...fieldDefaults, published: 1, access: 1, name: 'MCP Notebook Title',
      fieldtype: rows[0].guid, xml, datatype: 'VARCHAR', datalenght: 'Other', datalenght_other: '120', datadefault: '', indexes: '0', store: '0' } },
    { key: 'notes-view', view: 'admin_view', guid: ids.view, fields: { ...viewDefaults, published: 1, access: 1, system_name: 'MCP Notebook Notes',
      name_single: 'Note', name_list: 'Notes', short_description: 'Manage notebook notes', type: '1' } },
    { key: 'notebook', view: 'joomla_component', guid: ids.component, fields: { ...componentDefaults, published: 1, access: 1,
      name: 'MCP Notebook', system_name: 'MCP Notebook', name_code: 'mcpnotebook', short_description: 'Administrator notebook',
      author: 'JoomEngine', companyname: 'JoomEngine', email: 'qa@example.test', website: 'https://joomengine.org/',
      component_version: '1.0.0', namespace_prefix: 'Joomengine' } },
    { key: 'notes-fields', view: 'admin_fields', match: { admin_view: ids.view }, dependsOn: ['notes-title', 'notes-view'],
      fields: { admin_view: ids.view, published: 1, addfields: { addfields0: { field: ids.field, list: '1', order_list: '1',
        title: '1', sort: '1', search: '1', link: '1', tab: '1', alignment: '1', order_edit: '1' } } } },
    { key: 'notebook-views', view: 'component_admin_views', match: { joomla_component: ids.component }, dependsOn: ['notebook', 'notes-fields'],
      fields: { joomla_component: ids.component, published: 1, addadmin_views: { addadmin_views0: { adminview: ids.view, icomoon: 'pencil',
        mainmenu: '1', dashboard_add: '1', dashboard_list: '1', submenu: '1', checkin: '1', filter: '2', order: '1' } } } },
  ] });
  assert(created.results.length === 5 && created.results.every(r => r.status === 'applied'), JSON.stringify(created));
  const component = created.results.find(r => r.key === 'notebook');
  assert.equal(component.guid, ids.component);
  const compiled = await call('jcb_compile', { componentId: component.id, joomlaMajor: 6 });
  const installer = compiled.packages.find(p => /^com_mcpnotebook_v1_0_0__J6\.zip$/i.test(p.filename));
  assert(installer, JSON.stringify(compiled));
  const exported = await call('file_export', { path: installer.path });
  assert.equal(exported.sha256, installer.sha256);
  assert.equal((await call('extension_install', { artifactId: exported.id })).installed, true);
  const form = await call('file_read', { path: '/administrator/components/com_mcpnotebook/forms/note.xml' });
  assert.match(form.content, /name="title"/);
  assert.match(form.content, /maxlength="120"/);
  const destination = tablePrefix + 'mcpnotebook_note';
  async function saveTitle(title, id = 0) {
    await call('browser_navigate', { path: admin + '&view=note&layout=edit&id=' + id });
    await call('browser_fill', { selector: 'input[name="jform[title]"]', value: title });
    await call('browser_click', { selector: '#toolbar-apply button,button[data-submit-task="note.apply"],button[task="note.apply"]' });
    for (let i = 0; i < 20; i++) {
      const found = await read('SELECT id, title FROM ' + destination + ' WHERE title = ?', [title]);
      if (found.length) return found[0].id;
      await delay(400);
    }
    const screen = await call('browser_inspect');
    assert.fail('The generated Joomla form did not save the title. Page: ' + screen.text.slice(0, 1500));
  }
  console.log('Create and edit a Note through its installed administrator form');
  const id = await saveTitle('Created through the generated form');
  assert.equal(await saveTitle('Edited through the generated form', id), id);
  await call('browser_navigate', { path: admin + '&view=notes' });
  assert.match((await call('browser_inspect', { waitForText: 'Edited through the generated form' })).text, /Edited through the generated form/);
  console.log(JSON.stringify({ package: installer.filename, sha256: installer.sha256, sourceGuids: ids, verifiedNoteId: id }));
} finally { await client.close(); }
