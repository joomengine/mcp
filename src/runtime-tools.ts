// JSON Schemas for the browser operations. Paths are relative to the Joomla document root.
type Property = Record<string, unknown>;
const string = { type: 'string' };
const object = { type: 'object' };
const boolean = { type: 'boolean' };
const path = { type: 'string', description: 'Absolute path within the Joomla document root, e.g. /administrator/index.php.' };
const id = { type: 'string', minLength: 1 };
const offset = { type: 'integer', minimum: 0 };
const length = { type: 'integer', minimum: 1, maximum: 262144 };
const choice = (...values: string[]) => ({ type: 'string', enum: values });
const tool = (name: string, description: string, properties: Record<string, Property> = {}, required: string[] = []) => ({
  name, description, inputSchema: { type: 'object' as const, properties, required, additionalProperties: false }
});

export const runtimeTools = [
  tool('workspace_info', 'Inspect the live Joomla site, deployment, versions and persistence state.'),
  tool('site_request', 'Request a Joomla page or submit a form on the active site. Pass form-encoded or JSON text and its content type. Binary or large responses return a downloadable artifact.', {
    path, method: choice('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'), body: string, contentType: string
  }, ['path']),
  tool('file_list', 'List a directory in JoomEngine Code. Use nextOffset to continue.', { path, offset, limit: { type: 'integer', minimum: 1, maximum: 250 } }),
  tool('file_search', 'Search filenames or text in JoomEngine Code. Follow cursor until it is null.', {
    path, query: string, kind: choice('files', 'text'), cursor: string, caseSensitive: boolean
  }),
  tool('file_read', 'Read a document-root file, returning its revision. UTF-8 is the default. Use base64 for exact binary or byte-range reads.', {
    path, offset, length, encoding: choice('utf8', 'base64')
  }, ['path']),
  tool('file_write', 'Save a file through JoomEngine Code. Pass null as expectedRevision to create it, or the revision from file_read to update it.', {
    path, content: { type: 'string', maxLength: 1048576 }, encoding: choice('utf8', 'base64'), expectedRevision: { type: ['string', 'null'] }
  }, ['path', 'content', 'expectedRevision']),
  tool('file_manage', 'Create a directory, rename, copy, or delete a path using the editor’s filesystem and recovery history. Use recover with the returned recoveryId to undo.', {
    action: choice('mkdir','rename','copy','delete','recover'), path, target: path, expectedRevision: string, recursive: boolean, recoveryId: string
  }, ['action']),
  tool('file_export', 'Retain a document-root file, including a compiled installer, as a downloadable binary artifact.', { path }, ['path']),
  tool('database_query', 'Run a prepared SQL statement against the active MariaDB database. SHOW TABLES lists tables; DESCRIBE inspects their schema. Use the Joomla API for JCB authoring. Use a WHERE clause for targeted edits. Results include the actual Joomla table prefix.', {
    sql: { type: 'string', minLength: 1, maxLength: 65536 },
    parameters: { type: 'array', items: { type: ['string','number','boolean','null'] }, maxItems: 256 },
    rows: { type: 'integer', minimum: 1, maximum: 250 }
  }, ['sql']),
  tool('debug_control', 'Control phpdbg on real Joomla HTTP requests. Set breakpoints with source paths, then use start to arm and dispatch a GET or POST asynchronously. Inspect state, stackTrace, scopes, and variables; continue or step until the request completes.', {
    action: choice('state','setBreakpoints','start','continue','next','stepIn','stepOut','pause','stop','stackTrace','scopes','variables','evaluate'),
    path, breakpoints: { type: 'array', maxItems: 1000, items: { type: 'object', properties: { line: { type: 'integer', minimum: 1 }, condition: string }, required: ['line'], additionalProperties: false } },
    method: choice('GET','POST'), body: string, contentType: string, frameId: { type: 'integer' }, reference: { type: 'integer' }, expression: string
  }, ['action']),
  tool('mail_list', 'List messages captured by the local Playground inbox.', { offset, limit: { type: 'integer', minimum: 1, maximum: 250 } }),
  tool('mail_get', 'Read a captured message, including rendered text or original .eml as a binary artifact.', { id, format: choice('text','html','raw') }, ['id']),
  tool('deployment_configure', 'Apply deployment configuration to the current owner workspace, e.g. siteName, menus, language or add-on extensions. Set PHP settings through the phpSettings field separately.', { configuration: object }, ['configuration']),
  tool('workspace_flush', 'Wait for the live workspace to save its committed files and database.'),
  tool('native_tools', 'Discover paginated tool schemas on the installed native Joomla/JCB MCP; supply nextCursor as cursor for subsequent pages.', { cursor: string }),
  tool('native_call', 'Call an installed Joomla/JCB MCP tool by its discovered name and arguments; preserves the native grant, plan and confirmation flow.', { name: string, arguments: object }, ['name']),
  tool('site_export', 'Create a complete, files-only, or SQL export. Complete archives include the site credentials and configuration. Retrieve bytes with artifact_read.', { format: choice('bundle','files','database') }),
  tool('backup_list', 'List intentional backups saved in the current Playground browser profile.', { offset, limit: { type: 'integer', minimum: 1, maximum: 250 } }),
  tool('backup_save', 'Save a complete site archive in the Playground Backups panel.', { name: string }),
  tool('backup_export', 'Retain an existing backup as a downloadable site artifact.', { id }, ['id']),
  tool('site_restore', 'Restore a complete site artifact. An agent-owned workspace switches after import succeeds; a client workspace uses the owner window’s Upload flow.', { id }, ['id']),
  tool('artifact_read', 'Read a bounded base64 chunk from an exported file. Use nextOffset until null and verify the SHA-256 from the export.', { id, offset, length }, ['id']),
  tool('artifact_release', 'Release an exported artifact from this workspace connection after transfer.', { id }, ['id'])
];
