export { runtimeTools } from './runtime-tools.js';

/**
 * Executed inside the selected Playground page. Keep this function self-contained so the
 * browser receives the same implementation through Playwright and the desktop connection.
 * The handle is supplied by Playground or its documented companion-window API.
 */
export async function dispatch(runtime: any, operation: string, args: Record<string, any>): Promise<any> {
  if (!runtime || runtime.closed) throw new Error('The Playground workspace has closed.');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const chunkSize = 256 * 1024;
  const artifactsKey = Symbol.for('joomengine.mcp.artifacts');
  const artifacts: Map<string, any> = runtime[artifactsKey] ??= new Map();

  function integer(value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(`Expected an integer between ${min} and ${max}.`);
    }
    return value;
  }
  function text(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.length) throw new Error(`${name} is required.`);
    return value;
  }
  function base64(bytes: Uint8Array): string {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 8192) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    }
    return btoa(binary);
  }
  function range(size: number) {
    const offset = integer(args.offset, 0, 0, size);
    const end = Math.min(size, offset + integer(args.length, chunkSize, 1, chunkSize));
    return { offset, end, nextOffset: end < size ? end : null, total: size };
  }
  function page(values: any[]) {
    const start = integer(args.offset, 0, 0, values.length);
    const end = Math.min(values.length, start + integer(args.limit, 100, 1, 250));
    return { items: values.slice(start, end), nextOffset: end < values.length ? end : null, total: values.length };
  }
  function reserve(size: number) {
    let used = 0;
    for (const item of artifacts.values()) used += item.bytes.byteLength;
    if (artifacts.size >= 32 || size + used > 1024 * 1024 * 1024) {
      throw new Error('Artifact space is full. Release transferred artifacts before exporting another.');
    }
  }
  async function checksum(bytes: Uint8Array) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function retain(bytes: Uint8Array, filename: string, mimeType: string, kind = 'file') {
    const sha256 = await checksum(bytes);
    reserve(bytes.byteLength);
    const id = crypto.randomUUID();
    artifacts.set(id, { bytes, filename, mimeType, kind, sha256 });
    return { id, filename, mimeType, size: bytes.byteLength, sha256 };
  }
  function artifact(uploading = false) {
    const value = artifacts.get(text(args.id, 'Artifact ID'));
    if (!value || !!value.uploading !== uploading) throw new Error('The artifact is unavailable in this workspace connection.');
    return value;
  }
  function upstream(module: string) {
    // Named backups and storage belong to the browser profile and remain usable while PHP is stopped.
    const base = new URL(runtime.agentModuleBase ?? runtime.baseUrl);
    if (base.origin !== location.origin) throw new Error('Invalid Playground origin.');
    if (runtime.agentModuleBase === undefined) {
      const index = base.pathname.indexOf('/__site/');
      if (index === -1) throw new Error('Invalid Playground site base URL.');
      base.pathname = base.pathname.slice(0, index + 1);
    } else if (!base.pathname.endsWith('/')) base.pathname += '/';
    base.search = ''; base.hash = '';
    return import(new URL('src/' + module, base).href);
  }
  function backupSummary(record: any) {
    const { id, revision, name, size, filename, updatedAt, sourceSiteKey, siteName, joomlaVersion, jcbVersion, phpVersion } = record;
    return { id, revision, name, size, filename, updatedAt, sourceSiteKey, siteName, joomlaVersion, jcbVersion, phpVersion };
  }
  function fileBytes(input: Record<string, any>) {
    if (input.artifactId !== undefined) {
      if (input.content !== undefined || input.encoding !== undefined) throw new Error('Supply an artifact ID or inline contents.');
      const value = artifacts.get(text(input.artifactId, 'Artifact ID'));
      if (!value || value.uploading) throw new Error('The file artifact is unavailable in this workspace connection.');
      return value.bytes;
    }
    if (typeof input.content !== 'string' || input.content.length > 1048576) throw new Error('A file write requires at most 1 MiB of inline text or base64. Use a file artifact for larger writes.');
    return input.encoding === 'base64' ? Uint8Array.from(atob(input.content), c => c.charCodeAt(0)) : encoder.encode(input.content);
  }
  function fileChange(input: Record<string, any>) {
    if (input.operation === 'copy' || input.operation === 'rename') {
      return { ...input, overwrite: typeof input.expectedTargetRevision === 'string' };
    }
    if (input.operation !== 'write') return input;
    if (input.expectedRevision !== null && typeof input.expectedRevision !== 'string') throw new Error('Supply the existing revision, or null to create a new file.');
    const { content, artifactId, encoding, id, ...fields } = input;
    return { ...fields, bytes: fileBytes(input), overwrite: input.expectedRevision !== null };
  }
  function fileReceipt(result: any) {
    // The editor retains an undo snapshot even when a later change fails.
    if (result?.ok === false) return { isError: true, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
    return result;
  }
  function requestOptions() {
    const method = args.method ?? 'GET';
    if (!['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(method)) throw new Error('Unsupported HTTP method.');
    if (args.body !== undefined && (typeof args.body !== 'string' || ['GET','HEAD'].includes(method))) {
      throw new Error('Supply a string body only for a request method that takes a body.');
    }
    return { method, headers: args.contentType ? { 'Content-Type': String(args.contentType) } : undefined, body: args.body };
  }

  switch (operation) {
    case 'workspace_info': {
      const config = runtime.configuration ?? {};
      const installed = runtime.installation ?? {};
      return {
        ...runtime.agentOwner?.state(), workspaceId: runtime.workspace.id, siteName: installed.siteName ?? config.siteName,
        deployId: config.deployId, siteUrl: runtime.baseUrl, joomlaVersion: installed.version ?? config.joomlaVersion,
        jcbVersion: config.jcbVersion, phpVersion: runtime.runtimeInfo?.phpVersion ?? config.phpVersion,
        healthy: !!runtime.healthy, persistent: !!config.persistence, lastSavedAt: runtime.lastSavedAt,
        persistencePending: !!runtime.persistencePending, debuggerState: runtime.debugger?.state,
        mailCount: runtime.mail?.state?.count, persistenceState: runtime.persistenceState, recovery: runtime.recovery
      };
    }
    case 'workspace_flush':
      await runtime.flush();
      return { saved: !!runtime.savedCurrentState, lastSavedAt: runtime.lastSavedAt, persistent: !!runtime.configuration?.persistence };
    case 'site_request': {
      const { resolveSiteURL } = await upstream('config.mjs');
      const target = text(args.path, 'Site path');
      resolveSiteURL(target, runtime.baseUrl);
      const response: Response = await runtime.request(target, requestOptions());
      const bytes = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      const info = { status: response.status, contentType, location: response.headers.get('location') };
      if (bytes.length <= chunkSize && (/^text\/|json|xml|javascript|urlencoded/i.test(contentType) || !bytes.length)) {
        return { ...info, body: decoder.decode(bytes) };
      }
      return { ...info, artifact: await retain(bytes, target.split(/[?#]/)[0]!.split('/').pop() || 'response', contentType) };
    }
    case 'file_list':
      return page(await runtime.workspace.request('list', { path: args.path ?? '/' }));
    case 'file_stat':
      return runtime.workspace.request('stat', { path: text(args.path, 'Workspace path'), revision: args.revision === true });
    case 'file_history': return { items: await runtime.workspace.request('history', {}) };
    case 'file_search_cancel': return runtime.workspace.request('cancelSearch', { cursor: text(args.cursor, 'Search cursor') });
    case 'file_search':
      return runtime.workspace.request('search', { ...args, path: args.path ?? '/', maxResults: args.maxResults ?? 100 });
    case 'file_read': {
      const file = await runtime.workspace.request('read', { path: text(args.path, 'File path') });
      const bounds = range(file.bytes.byteLength);
      // Continue at a UTF-8 character boundary. Binary callers can request exact byte offsets.
      if (args.encoding !== 'base64') {
        const isContinuation = (index: number) => (file.bytes[index] & 0xc0) === 0x80;
        if (bounds.offset < bounds.total && isContinuation(bounds.offset)) {
          throw new Error('The offset is inside a UTF-8 character. Use the returned nextOffset or base64.');
        }
        const originalEnd = bounds.end;
        while (bounds.end < bounds.total && bounds.end - originalEnd < 3 && isContinuation(bounds.end)) bounds.end++;
        bounds.nextOffset = bounds.end === bounds.total ? null : bounds.end;
      }
      const bytes = file.bytes.subarray(bounds.offset, bounds.end);
      return { path: file.path, revision: file.revision, ...bounds, encoding: args.encoding ?? 'utf8',
        content: args.encoding === 'base64' ? base64(bytes) : decoder.decode(bytes) };
    }
    case 'file_write': case 'file_import': {
      const { operation: _, ...edit } = fileChange({ ...args, path: text(args.path, 'File path'), operation: 'write',
        ...(operation === 'file_import' ? { artifactId: text(args.id, 'Artifact ID') } : {}) });
      return fileReceipt(await runtime.workspace.request('write', edit));
    }
    case 'file_batch':
      return fileReceipt(await runtime.workspace.request('batch', { changes: args.changes.map(fileChange), preconditions: args.preconditions }));
    case 'file_manage': {
      const action = args.action;
      if (action === 'recover') return fileReceipt(await runtime.workspace.request('recover', { recoveryId: text(args.recoveryId, 'Recovery ID') }));
      if (!['mkdir','delete','copy','rename'].includes(action)) throw new Error('Unsupported file operation.');
      const path = text(args.path, 'File path');
      const target = ['copy','rename'].includes(action) ? text(args.target, 'Destination path') : undefined;
      const { operation: _, ...change } = fileChange({ path, target, operation: action, recursive: args.recursive,
        expectedRevision: args.expectedRevision, expectedTargetRevision: args.expectedTargetRevision,
        expectedCanonicalPath: args.expectedCanonicalPath, expectedTargetCanonicalPath: args.expectedTargetCanonicalPath });
      return fileReceipt(await runtime.workspace.request(action, change));
    }
    case 'file_export': {
      const path = text(args.path, 'File path');
      const file = await runtime.workspace.request('read', { path });
      return retain(file.bytes, path.split('/').pop()!, path.endsWith('.zip') ? 'application/zip' : 'application/octet-stream');
    }
    case 'database_open': {
      const { url } = await runtime.openDatabase();
      const base = new URL(runtime.baseUrl);
      if (!base.pathname.endsWith('/')) base.pathname += '/';
      const target = new URL(url);
      if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname + '__adminer/')) throw new Error('Invalid database viewer URL.');
      return { path: '/' + target.href.slice(base.href.length), url: target.href };
    }
    case 'database_query': {
      const sql = text(args.sql, 'SQL');
      const parameters = args.parameters ?? [];
      if (sql.length > 65536 || !Array.isArray(parameters) || parameters.length > 256 ||
        parameters.some(value => value !== null && !['string','boolean','number'].includes(typeof value) &&
          !(typeof value === 'object' && typeof value.base64 === 'string' && value.base64.length <= 1048576))) {
        throw new Error('Invalid SQL statement or parameter values.');
      }
      const payload = base64(encoder.encode(JSON.stringify({ sql, parameters, binaryColumns: args.binaryColumns ?? [], rows: integer(args.rows, 100, 1, 250) })));
      // Parameter values travel as data and retain their types when bound. Joomla owns the credentials.
      const program = `<?php
try {
    require '/persist/www/configuration.php';
    $config = new JConfig();
    $pdo = new PDO('mysql:dbname=' . $config->db . ';charset=utf8mb4', $config->user, $config->password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $input = json_decode(base64_decode('${payload}'), true, 512, JSON_THROW_ON_ERROR);
    $statement = $pdo->prepare($input['sql']);
    foreach ($input['parameters'] as $i => $value) {
        if (is_array($value)) {
            $bytes = base64_decode($value['base64'], true);
            if ($bytes === false) throw new InvalidArgumentException('A binary parameter must contain valid base64.');
            $statement->bindValue($i + 1, $bytes, PDO::PARAM_LOB);
            continue;
        }
        $type = is_null($value) ? PDO::PARAM_NULL : (is_int($value) ? PDO::PARAM_INT : (is_bool($value) ? PDO::PARAM_BOOL : PDO::PARAM_STR));
        $statement->bindValue($i + 1, $value, $type);
    }
    $statement->execute();
    $rows = []; $size = 0; $truncated = false;
    if ($statement->columnCount()) {
        while (($row = $statement->fetch(PDO::FETCH_ASSOC)) !== false) {
            foreach ($row as $key => $value) {
                if (is_int($value) && ($value > 9007199254740991 || $value < -9007199254740991)) {
                    $row[$key] = (string) $value;
                } elseif (is_string($value) && (in_array($key, $input['binaryColumns'], true) || !preg_match('//u', $value))) {
                    $row[$key] = ['base64' => base64_encode($value)];
                }
            }
            $size += strlen(json_encode($row, JSON_THROW_ON_ERROR));
            if (count($rows) >= $input['rows'] || $size > 262144) { $truncated = true; break; }
            $rows[] = $row;
        }
    }
    echo json_encode(['rows' => $rows, 'affected' => $statement->rowCount(), 'truncated' => $truncated, 'tablePrefix' => $config->dbprefix], JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    echo json_encode(['error' => $error->getMessage()], JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
}`;
      const response = await runtime.runPhp(program);
      const result = JSON.parse(response.text);
      if (result.error) throw new Error(result.error);
      return result;
    }
    case 'mail_list':
      return page(await runtime.mail.list());
    case 'mail_clear': return runtime.mail.clear();
    case 'mail_get': {
      const message = await runtime.mail.get(text(args.id, 'Mail ID'));
      if (!message) throw new Error('The captured message no longer exists.');
      if (args.format === 'raw') return retain(message.raw, message.id + '.eml', 'message/rfc822');
      const { parsed, raw: _raw, ...summary } = message;
      if (args.format === 'headers') {
        const headers = parsed?.headers ?? [];
        const json = encoder.encode(JSON.stringify(headers));
        return json.length > chunkSize ? { ...summary, artifact: await retain(json, 'headers.json', 'application/json') } : { ...summary, headers };
      }
      const format = args.format === 'html' ? 'html' : 'text';
      const content = parsed?.[format] ?? null;
      if (typeof content === 'string' && content.length > chunkSize) {
        return { ...summary, attachments: parsed?.attachments ?? [], artifact: await retain(encoder.encode(content), `message.${format}`, 'text/' + (format === 'html' ? 'html' : 'plain')) };
      }
      return { ...summary, attachments: parsed?.attachments ?? [], format, content };
    }
    case 'debug_control': {
      const debug = runtime.debugger;
      const requestKey = Symbol.for('joomengine.mcp.debug-request');
      switch (args.action) {
        case 'state': return { state: debug.state, capabilities: debug.capabilities, request: runtime[requestKey] ?? null };
        case 'start': {
          const { resolveSiteURL } = await upstream('config.mjs');
          const url = resolveSiteURL(args.path ?? '/', runtime.baseUrl);
          const init = requestOptions();
          await debug.start({ url, method: init.method });
          const status: { pending: boolean; status?: number; error?: string } = { pending: true };
          runtime[requestKey] = status;
          // The HTTP request pauses at a breakpoint. Let later MCP calls inspect and resume it.
          void fetch(url, { ...init, redirect: 'manual' }).then(async response => {
            await response.body?.cancel();
            status.status = response.status;
          }).catch(error => { status.error = String(error.message || error); }).finally(() => { status.pending = false; });
          return { state: debug.state, request: status };
        }
        case 'setBreakpoints': {
          const path = text(args.path, 'Source path');
          if (!path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) throw new Error('Invalid debugger source path.');
          return debug.setBreakpoints(runtime.documentRoot + path, args.breakpoints ?? []);
        }
        case 'scopes': return debug.scopes(args.frameId);
        case 'variables': return debug.variables(args.reference, { start: args.start ?? 0, count: args.count ?? 100 });
        case 'evaluate': return debug.evaluate(text(args.expression, 'PHP expression'), args.frameId);
        case 'pause': case 'stop': case 'continue': case 'next': case 'stepIn': case 'stepOut': case 'stackTrace':
          return (await debug[args.action]()) ?? { state: debug.state };
        default: throw new Error('Unknown debugger action.');
      }
    }
    case 'workspace_cache_clear': return runtime.clearJoomlaCache();
    case 'workspace_repair': {
      if (!runtime.recovery) throw new Error('The current site is not in Joomla recovery mode.');
      return runtime.repairConfiguration();
    }
    case 'workspace_recovery_export': {
      const value = await runtime.exportRecoveryFiles();
      return retain(value.bytes, value.filename, value.mimeType);
    }
    case 'storage_list': case 'storage_remove': {
      const shell = await upstream('app.mjs');
      if (typeof shell.listManagedStorage !== 'function') throw new Error('This Playground predates the storage management API. Update the Playground host.');
      if (operation === 'storage_list') return page(await shell.listManagedStorage());
      return shell.removeManagedStorageById(text(args.id, 'Storage ID'), { allowUnassigned: args.allowUnassigned === true });
    }
    case 'site_export': {
      const format = args.format ?? 'bundle';
      const value = await runtime.exportSite({ format, includePlaygroundConfiguration: args.includePlaygroundConfiguration ?? format === 'bundle',
        ...(args.database ? { database: args.database } : {}) });
      return retain(value.bytes, value.filename, value.mimeType, format === 'bundle' ? 'site' : 'file');
    }
    case 'backup_list': case 'backup_save': case 'backup_update': case 'backup_import': case 'backup_delete': case 'backup_export': {
      const { createSiteBackups } = await upstream('site-backups.mjs');
      const backups = runtime[Symbol.for('joomengine.mcp.backups')] ??= createSiteBackups();
      if (operation === 'backup_list') return { ...page((await backups.list()).map(backupSummary)), usage: await backups.usage() };
      if (operation === 'backup_export') {
        const backup = await backups.get(text(args.id, 'Backup ID'));
        return retain(new Uint8Array(await backup.blob.arrayBuffer()), backup.filename, backup.mimeType, 'site');
      }
      if (operation === 'backup_delete') {
        if (typeof backups.removeRevision !== 'function') throw new Error('This Playground predates revision-checked backup deletion. Update the Playground host.');
        await backups.removeRevision(text(args.id, 'Backup ID'), integer(args.expectedRevision, 0, 1, Number.MAX_SAFE_INTEGER));
        window.dispatchEvent(new Event('joomengine-backups-changed'));
        return { deleted: true, id: args.id };
      }
      let result;
      if (operation === 'backup_import') {
        const { readSiteExport } = await upstream('site-import.mjs');
        const parsed = await readSiteExport(artifact().bytes);
        result = await backups.saveArchive({ bytes: parsed.bytes, metadata: parsed.metadata }, { name: args.name });
      } else {
        const options: Record<string, unknown> = { name: args.name, configuration: runtime.configuration, sourceSiteKey: runtime.configuration.storageKey };
        if (operation === 'backup_update') {
          options.id = text(args.id, 'Backup ID');
          options.expectedRevision = integer(args.expectedRevision, 0, 1, Number.MAX_SAFE_INTEGER);
        }
        const archive = await runtime.exportSite({ format: 'bundle', includePlaygroundConfiguration: true });
        result = await backups.saveArchive(archive, options);
      }
      if (!result.saved) throw new Error(result.error?.message ?? 'Playground could not save the backup (' + result.reason + ').');
      window.dispatchEvent(new Event('joomengine-backups-changed'));
      return backupSummary(result.record);
    }
    case 'site_restore': {
      const value = artifact();
      if (value.kind !== 'site') throw new Error('Restore requires a complete site export or backup.');
      if (typeof runtime.agentRestore !== 'function') throw new Error('Restore this export through Upload in the attached owner window.');
      if (args.replaceWorkspaceId !== undefined && text(args.replaceWorkspaceId, 'Replacement workspace ID') !== runtime.workspace.id) {
        throw new Error('The active workspace does not match replaceWorkspaceId. Inspect workspace_info before restoring.');
      }
      return runtime.agentRestore(value.bytes, args.replaceWorkspaceId);
    }
    // Both host-directory and direct MCP uploads share this per-workspace store.
    // A partial upload is never a usable artifact.
    case 'artifact_info': {
      const value = artifact();
      return { id: args.id, filename: value.filename, mimeType: value.mimeType, size: value.bytes.length, sha256: value.sha256 };
    }
    case 'artifact_upload_begin': {
      const size = integer(args.size, -1, 0, 512 * 1024 * 1024);
      const filename = text(args.filename, 'Filename');
      if (encoder.encode(filename).length > 240 || /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(filename) || /[. ]$/.test(filename)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) throw new Error('Choose a plain artifact filename.');
      if (size < 0 || !['site','file'].includes(args.kind)) throw new Error('Invalid upload metadata.');
      const extensions: Record<string, string> = { zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        webp: 'image/webp', gif: 'image/gif', json: 'application/json', sql: 'application/sql', csv: 'text/csv', eml: 'message/rfc822', txt: 'text/plain' };
      const mimeType = args.mimeType ?? extensions[filename.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
      if (typeof mimeType !== 'string' || mimeType.length > 127 || !/^[a-zA-Z0-9!#$%&^_.+-]+\/[a-zA-Z0-9!#$%&^_.+-]+$/.test(mimeType)) throw new Error('Invalid MIME type.');
      reserve(size);
      const id = crypto.randomUUID();
      artifacts.set(id, { bytes: new Uint8Array(size), written: 0, uploading: true, kind: args.kind, filename, mimeType });
      return { id };
    }
    case 'artifact_upload_status': {
      const value = artifact(true);
      return { id: args.id, received: value.written, size: value.bytes.byteLength };
    }
    case 'artifact_upload_chunk': {
      const value = artifact(true);
      const input = text(args.base64, 'Upload chunk');
      if (input.length > 4 * Math.ceil(chunkSize / 3) || args.offset !== value.written) throw new Error('Invalid upload chunk length or offset.');
      const bytes = Uint8Array.from(atob(input), c => c.charCodeAt(0));
      if (!bytes.length || bytes.length > chunkSize || args.offset + bytes.length > value.bytes.length) throw new Error('Upload exceeds its declared size.');
      value.bytes.set(bytes, value.written);
      value.written += bytes.length;
      return { received: value.written };
    }
    case 'artifact_upload_finish': {
      const complete = artifacts.get(text(args.id, 'Artifact ID'));
      if (complete && !complete.uploading && complete.sha256 === args.sha256) {
        return { id: args.id, filename: complete.filename, mimeType: complete.mimeType, size: complete.bytes.length, sha256: complete.sha256 };
      }
      const value = artifact(true);
      if (value.written !== value.bytes.length) throw new Error('The upload is incomplete.');
      const sha256 = await checksum(value.bytes);
      if (sha256 !== args.sha256) throw new Error('The uploaded artifact failed its SHA-256 check.');
      value.uploading = false;
      value.sha256 = sha256;
      return { id: args.id, filename: value.filename, mimeType: value.mimeType, size: value.bytes.length, sha256 };
    }
    case 'artifact_read': {
      const bytes = artifact().bytes;
      const bounds = range(bytes.byteLength);
      return { ...bounds, base64: base64(bytes.subarray(bounds.offset, bounds.end)) };
    }
    case 'artifact_release':
      return { released: artifacts.delete(text(args.id, 'Artifact ID')) };
    default:
      throw new Error(`Unknown Playground operation: ${operation}`);
  }
}
