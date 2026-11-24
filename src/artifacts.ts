import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

interface WorkspaceTransfer {
  call(operation: string, args: Record<string, unknown>): Promise<unknown>;
}
interface Receipt { id: string; filename: string; mimeType: string; size: number; sha256: string }
const chunkSize = 256 * 1024;
const maxBytes = 512 * 1024 * 1024;
const filenameProperty = { type: 'string', minLength: 1, maxLength: 240 };
export const hostArtifactTools: Tool[] = [
  { name: 'artifact_save', description: 'Save an exported artifact in the configured host directory and verify its SHA-256. Choose an unused filename or accept the exported name.',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' }, filename: filenameProperty }, required: ['id'], additionalProperties: false } },
  { name: 'artifact_load', description: 'Load a file from the configured host directory into the selected browser and verify its SHA-256. Choose kind site for a complete site ZIP to restore, or file for an installer.',
    inputSchema: { type: 'object' as const, properties: { filename: filenameProperty, kind: { type: 'string', enum: ['site','file'] } }, required: ['filename','kind'], additionalProperties: false } }
];

function safeName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value) > 240 ||
      /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) || /[. ]$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error('Choose a plain filename within the configured artifact directory.');
  }
  return value;
}

function checkReceipt(value: unknown, id: string): Receipt {
  const r = value as Partial<Receipt> | null;
  if (!r || r.id !== id || !Number.isSafeInteger(r.size) || r.size! < 0 || r.size! > maxBytes ||
      typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) throw new Error('The workspace returned invalid artifact metadata.');
  return r as Receipt;
}

async function save(workspace: WorkspaceTransfer, directory: string, args: Record<string, unknown>) {
  if (typeof args.id !== 'string' || !args.id) throw new Error('An artifact ID is required.');
  const receipt = checkReceipt(await workspace.call('artifact_info', { id: args.id }), args.id);
  const filename = safeName(args.filename ?? receipt.filename);
  const target = join(directory, filename);
  // link() publishes a complete, verified file without replacing any existing file or symlink.
  // The temporary file must be on the same volume to support an atomic link.
  const temporary = join(directory, '.joomengine-artifact-' + randomUUID());
  const file = await open(temporary, 'wx', 0o600);
  try {
    const digest = createHash('sha256');
    for (let offset = 0; offset < receipt.size;) {
      const length = Math.min(chunkSize, receipt.size - offset);
      const packet = await workspace.call('artifact_read', { id: receipt.id, offset, length }) as {
        total: number; offset: number; base64: string; nextOffset: number | null;
      };
      const nextOffset = offset + length;
      if (packet.total !== receipt.size || packet.offset !== offset || packet.nextOffset !== (nextOffset === receipt.size ? null : nextOffset) ||
          typeof packet.base64 !== 'string' || packet.base64.length !== 4 * Math.ceil(length / 3)) {
        throw new Error('The workspace returned an incomplete artifact chunk.');
      }
      const bytes = Buffer.from(packet.base64, 'base64');
      if (bytes.length !== length) throw new Error('Invalid artifact bytes.');
      digest.update(bytes);
      await file.writeFile(bytes);
      offset = nextOffset;
    }
    if (digest.digest('hex') !== receipt.sha256) throw new Error('The downloaded artifact failed its SHA-256 check.');
    await file.sync();
    await file.close();
    await link(temporary, target);
    return { filename, size: receipt.size, sha256: receipt.sha256 };
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary);
  }
}

async function load(workspace: WorkspaceTransfer, directory: string, args: Record<string, unknown>) {
  const filename = safeName(args.filename);
  if (args.kind !== 'file' && args.kind !== 'site') throw new Error('Choose file or site as the artifact kind.');
  const source = join(directory, filename);
  const listed = await lstat(source);
  if (!listed.isFile() || listed.size > maxBytes) throw new Error('Choose a regular file of at most 512 MiB in the configured directory.');
  const file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let pending: string | undefined;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || listed.dev !== metadata.dev || listed.ino !== metadata.ino || metadata.size > maxBytes) {
      throw new Error('The selected file changed before it could be opened.');
    }
    const response = await workspace.call('artifact_upload_begin', { filename, kind: args.kind, size: metadata.size }) as { id: string };
    if (typeof response?.id !== 'string' || !response.id) throw new Error('The browser did not open an artifact upload.');
    pending = response.id;
    const buffer = Buffer.allocUnsafe(chunkSize);
    const digest = createHash('sha256');
    for (let offset = 0; offset < metadata.size;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(chunkSize, metadata.size - offset), offset);
      if (!bytesRead) throw new Error('The local artifact was shortened during the transfer.');
      const bytes = buffer.subarray(0, bytesRead);
      digest.update(bytes);
      const chunk = await workspace.call('artifact_upload_chunk', { id: pending, offset, base64: bytes.toString('base64') }) as { received: number };
      offset += bytesRead;
      if (chunk.received !== offset) throw new Error('The browser did not acknowledge the complete artifact chunk.');
    }
    const final = await file.stat();
    if (final.size !== metadata.size || final.mtimeMs !== metadata.mtimeMs || final.ctimeMs !== metadata.ctimeMs) {
      throw new Error('The local artifact changed during the transfer.');
    }
    const sha256 = digest.digest('hex');
    const receipt = checkReceipt(await workspace.call('artifact_upload_finish', { id: pending, sha256 }), pending);
    if (receipt.size !== metadata.size || receipt.sha256 !== sha256) throw new Error('The browser received different artifact bytes.');
    pending = undefined;
    return receipt;
  } finally {
    if (pending) await workspace.call('artifact_release', { id: pending }).catch(() => {});
    await file.close();
  }
}

export async function transferArtifact(workspace: WorkspaceTransfer, dir: string, name: string, args: Record<string, unknown>) {
  const directory = await realpath(dir);
  if (!(await stat(directory)).isDirectory()) throw new Error('The host artifact path must be an existing directory.');
  if (name === 'artifact_load') return load(workspace, directory, args);
  if (name === 'artifact_save') return save(workspace, directory, args);
  throw new Error('Unknown host artifact operation.');
}
