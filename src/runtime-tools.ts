// JSON Schemas for the browser operations. Paths are relative to the Joomla document root.
type Property = Record<string, unknown>;
const string = { type: 'string' };
const object = { type: 'object' };
const revision = { type: ['string', 'null'] };
const filterPatterns = { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 1024 } };
const sqlValue = { anyOf: [{ type: ['string','number','boolean','null'] }, {
  type: 'object', required: ['base64'], additionalProperties: false, properties: { base64: { type: 'string', maxLength: 1048576 } }
}] };
const backupRevision = { type: 'integer', minimum: 1 };
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
  tool('file_stat', 'Inspect a workspace path, including its canonical path and type. Request a revision to compare file or directory contents before mutation. Missing paths return null.', { path, revision: boolean }, ['path']),
  tool('file_history', 'List recoverable changes in the active editor worker, including recovery IDs and affected paths.', {}),
  tool('file_search_cancel', 'Cancel a paginated editor search and release its cursor.', { cursor: id }, ['cursor']),
  tool('file_search', 'Search filenames or text in JoomEngine Code. Follow cursor until it is null.', {
    path, query: string, kind: choice('files', 'text'), cursor: string, caseSensitive: boolean, isWordMatch: boolean, include: filterPatterns, exclude: filterPatterns, maxResults: { type: 'integer', minimum: 1, maximum: 500 }
  }),
  tool('file_read', 'Read a document-root file, returning its revision. UTF-8 is the default. Use base64 for exact binary or byte-range reads.', {
    path, offset, length, encoding: choice('utf8', 'base64')
  }, ['path']),
  tool('file_write', 'Save a file through JoomEngine Code. Pass null as expectedRevision to create it, or the revision from file_read to update it.', {
    path, content: { type: 'string', maxLength: 1048576 }, encoding: choice('utf8', 'base64'), expectedRevision: { type: ['string', 'null'] }
  }, ['path', 'content', 'expectedRevision']),
  tool('file_import', 'Write the exact binary bytes of an artifact into the editor workspace. Pass a file revision for replacement or null for creation.', { path, id, expectedRevision: revision }, ['path', 'id', 'expectedRevision']),
  tool('file_batch', 'Apply up to 128 editor changes in one worker operation. Every write needs a revision or null and content or an artifact ID. A partial failure returns applied items, recoveryId and failed index.', {
    changes: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', additionalProperties: false,
      required: ['operation', 'path'], properties: { operation: choice('write','mkdir','rename','copy','delete'), path, target: path,
        expectedRevision: revision, expectedTargetRevision: revision, expectedCanonicalPath: path, expectedTargetCanonicalPath: path,
        recursive: boolean, content: { type: 'string', maxLength: 1048576 }, encoding: choice('utf8','base64'), artifactId: id } } }
  }, ['changes']),
  tool('file_manage', 'Create a directory, rename, copy, or delete a path using the editor’s filesystem and recovery history. Use recover with the returned recoveryId to undo.', {
    action: choice('mkdir','rename','copy','delete','recover'), path, target: path, expectedRevision: string, recursive: boolean, recoveryId: string
  }, ['action']),
  tool('file_export', 'Retain a document-root file, including a compiled installer, as a downloadable binary artifact.', { path }, ['path']),
  tool('database_open', 'Install/open the native Adminer viewer for this workspace. Navigate to the returned relative path to use its schema, import, export and editing forms.', {}),
  tool('database_query', 'Run a prepared SQL statement against the active MariaDB database. SHOW TABLES lists tables; DESCRIBE inspects their schema. Use the Joomla API for JCB authoring. Use a WHERE clause for targeted edits. Returns the real Joomla table prefix. Use {base64} for binary parameters or name binaryColumns for lossless results. Large integers return as decimal strings.', {
    sql: { type: 'string', minLength: 1, maxLength: 65536 },
    parameters: { type: 'array', items: sqlValue, maxItems: 256 },
    binaryColumns: { type: 'array', items: string, maxItems: 256 },
    rows: { type: 'integer', minimum: 1, maximum: 250 }
  }, ['sql']),
  tool('debug_control', 'Control phpdbg on real Joomla HTTP requests. Set breakpoints with source paths, then use start to arm and dispatch a GET or POST asynchronously. Inspect state, stackTrace, scopes, and variables; continue or step until the request completes.', {
    action: choice('state','setBreakpoints','start','continue','next','stepIn','stepOut','pause','stop','stackTrace','scopes','variables','evaluate'),
    path, breakpoints: { type: 'array', maxItems: 1000, items: { type: 'object', properties: { line: { type: 'integer', minimum: 1 }, condition: string }, required: ['line'], additionalProperties: false } },
    method: choice('GET','POST'), body: string, contentType: string, frameId: { type: 'integer' }, reference: { type: 'integer' }, start: offset, count: { type: 'integer', minimum: 1, maximum: 1000 }, expression: string
  }, ['action']),
  tool('mail_list', 'List messages captured by the local Playground inbox.', { offset, limit: { type: 'integer', minimum: 1, maximum: 250 } }),
  tool('mail_get', 'Read a captured message, including rendered text or original .eml as a binary artifact.', { id, format: choice('text','html','raw','headers') }, ['id']),
  tool('mail_clear', 'Clear the captured messages in this workspace’s session inbox.', {}),
  tool('workspace_cache_clear', 'Run Joomla cache:clean on the active site through Playground and persist its changes.', {}),
  tool('workspace_recovery_export', 'Download the native filesystem recovery archive even when MariaDB is unavailable. Returns a file artifact.', {}),
  tool('workspace_repair', 'Repair Joomla configuration in a recovery workspace. Playground backs up the original; restart the workspace after repair.', {}),
  tool('storage_list', 'List removable backup-panel storage and its live-site protections: stored runtimes, deployments, images and preferences. Unassigned stores require individual selection.', { offset, limit: { type: 'integer', minimum: 1, maximum: 250 } }),
  tool('storage_remove', 'Remove the exact removable storage ID shown by storage_list. Set allowUnassigned only for a specific reviewed unassigned store.', { id, allowUnassigned: boolean }, ['id']),
  tool('workspace_flush', 'Wait for the live workspace to save its committed files and database.'),
  tool('native_tools', 'Discover paginated tool schemas on the installed native Joomla/JCB MCP; supply nextCursor as cursor for subsequent pages.', { cursor: string }),
  tool('native_call', 'Call an installed Joomla/JCB MCP tool by its discovered name and arguments; preserves the native grant, plan and confirmation flow.', { name: string, arguments: object }, ['name']),
  tool('site_export', 'Create a complete, files-only, or SQL export. Complete archives include the site credentials and configuration. Retrieve bytes with artifact_read.', { format: choice('bundle','files','database'), includePlaygroundConfiguration: boolean,
    database: { type: 'object', additionalProperties: false, properties: { host: string, user: string, password: string, name: string } } }),
  tool('backup_list', 'List intentional backups saved in the current Playground browser profile.', { offset, limit: { type: 'integer', minimum: 1, maximum: 250 } }),
  tool('backup_save', 'Save a complete site archive in the Playground Backups panel.', { name: string }),
  tool('backup_update', 'Replace an existing backup with the current complete site. Supply the revision returned by backup_list; optionally change its display name.', { id, expectedRevision: backupRevision, name: string }, ['id', 'expectedRevision']),
  tool('backup_delete', 'Delete the selected backup at the exact listed revision. A concurrently updated backup remains available.', { id, expectedRevision: backupRevision }, ['id', 'expectedRevision']),
  tool('backup_import', 'Validate an uploaded complete-site artifact and save it as a named backup without replacing the running site.', { id, name: string }, ['id']),
  tool('backup_export', 'Retain an existing backup as a downloadable site artifact.', { id }, ['id']),
  tool('site_restore', 'Restore a complete site artifact. On an attached client, supply its workspace_info workspaceId as replaceWorkspaceId to authorize replacement of that exact site. Omit it to let the client choose in the owner window.', { id, replaceWorkspaceId: id }, ['id']),
  tool('artifact_info', 'Read size, filename, MIME type and SHA-256 of a completed artifact.', { id }, ['id']),
  tool('artifact_upload_begin', 'Start an upload directly from the MCP client, with a plain filename and exact byte size. Use kind site for a complete site ZIP. No shared host directory is required.', {
    filename: { type: 'string', minLength: 1, maxLength: 240 }, size: { type: 'integer', minimum: 0, maximum: 536870912 }, kind: choice('file','site')
  }, ['filename','size','kind']),
  tool('artifact_upload_status', 'Inspect the acknowledged byte offset of a pending upload before sending more data.', { id }, ['id']),
  tool('artifact_upload_chunk', 'Append base64 for up to 256 KiB of bytes at the received offset; returns the next byte offset.', {
    id, offset, base64: { type: 'string', minLength: 1, maxLength: 349528 }
  }, ['id','offset','base64']),
  tool('artifact_upload_finish', 'Publish a completed upload in this workspace only after verifying the sender’s SHA-256. Use artifact_release to cancel an incomplete transfer.', {
    id, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }
  }, ['id','sha256']),
  tool('artifact_read', 'Read a bounded base64 chunk from an exported file. Use nextOffset until null and verify the SHA-256 from the export.', { id, offset, length }, ['id']),
  tool('artifact_release', 'Release an exported artifact from this workspace connection after transfer.', { id }, ['id'])
];
