import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CURRENT_SQLITE_SCHEMA_VERSION,
  CURRENT_STATE_VERSION,
  JsonStore,
  SQLiteStore,
  createStore,
} from './store.js';
import { CONTROL_DATA_LEASE_DIRECTORY } from './control-data-lease.js';

export const CONTROL_BACKUP_FORMAT = 'nado-control-backup';
export const CONTROL_BACKUP_FORMAT_VERSION = 1;
export const CONTROL_BACKUP_MANIFEST = 'nado-backup-manifest.json';
export const CONTROL_RESTORE_RECEIPT = 'nado-restore-receipt.json';
export const CONTROL_RESTORE_RECEIPT_FORMAT = 'nado-control-restore-receipt';
export const CONTROL_RESTORE_RECEIPT_VERSION = 1;

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function requireOfflineConfirmation(options) {
  if (!options.offlineConfirmed) {
    throw new Error('Offline confirmation required: stop the control service and pass --offline-confirmed');
  }
}

function pathContainedBy(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeManifestPath(value) {
  const candidate = String(value || '');
  const segments = candidate.split('/');
  if (!candidate || candidate.includes('\\') || path.posix.isAbsolute(candidate)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe backup path: ${candidate}`);
  }
  return candidate;
}

function nativePath(root, relativePath) {
  return path.join(root, ...safeManifestPath(relativePath).split('/'));
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { bytes, sha256: hash.digest('hex') };
}

function normalizeRestoreReceipt(value) {
  if (
    !value
    || value.format !== CONTROL_RESTORE_RECEIPT_FORMAT
    || Number(value.formatVersion) !== CONTROL_RESTORE_RECEIPT_VERSION
    || !/^restore_[0-9a-f-]{36}$/.test(String(value.id || ''))
    || !Number.isFinite(Date.parse(value.restoredAt || ''))
    || !Number.isFinite(Date.parse(value.sourceCreatedAt || ''))
    || !/^[a-f0-9]{64}$/.test(String(value.manifestSha256 || ''))
    || !['json', 'sqlite'].includes(value.backend)
    || !Number.isSafeInteger(value.stateVersion)
    || (value.backend === 'sqlite' && !Number.isSafeInteger(value.sqliteSchemaVersion))
    || !Number.isSafeInteger(value.fileCount)
    || value.fileCount < 0
    || !Number.isSafeInteger(value.totalBytes)
    || value.totalBytes < 0
  ) {
    throw new Error('Control restore receipt is invalid');
  }
  return {
    format: value.format,
    formatVersion: Number(value.formatVersion),
    id: value.id,
    restoredAt: value.restoredAt,
    sourceCreatedAt: value.sourceCreatedAt,
    manifestSha256: value.manifestSha256,
    backend: value.backend,
    stateVersion: value.stateVersion,
    sqliteSchemaVersion: value.backend === 'sqlite' ? value.sqliteSchemaVersion : null,
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
  };
}

export async function readControlRestoreReceipt(dataDir) {
  const file = path.join(path.resolve(dataDir), CONTROL_RESTORE_RECEIPT);
  try {
    return normalizeRestoreReceipt(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isTransientStateWrite(relative) {
  return !relative.includes('/')
    && /^control-state\.(?:json|sqlite)\.\d+\.\d+\.[0-9a-f]+\.tmp$/i.test(relative);
}

async function listRegularFiles(root, options = {}, current = root, prefix = '') {
  const rows = [];
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const controlLeaseEntry = !prefix && (
      entry.name === CONTROL_DATA_LEASE_DIRECTORY
      || entry.name.startsWith(`${CONTROL_DATA_LEASE_DIRECTORY}.stale-`)
      || entry.name.startsWith(`${CONTROL_DATA_LEASE_DIRECTORY}.released-`)
    );
    if (controlLeaseEntry || options.excludeRootNames?.has(relative) || isTransientStateWrite(relative)) {
      continue;
    }
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Control backup does not follow symbolic links: ${relative}`);
    }
    if (entry.isDirectory()) {
      rows.push(...await listRegularFiles(root, options, absolute, relative));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported control data entry: ${relative}`);
    }
    rows.push({ relative, absolute });
  }
  return rows;
}

async function copyRegularTree(source, destination, options = {}) {
  const files = await listRegularFiles(source, options);
  for (const file of files) {
    const target = nativePath(destination, file.relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(file.absolute, target);
    await fs.chmod(target, 0o600);
  }
  return files.map((file) => file.relative);
}

async function discoverBackend(dataDir, requested) {
  if (requested) {
    const backend = String(requested).toLowerCase();
    if (backend !== 'json' && backend !== 'sqlite' && backend !== 'sqlite-wasm' && backend !== 'file') {
      throw new Error(`Unknown Nado store backend: ${requested}`);
    }
    return backend === 'file' ? 'json' : backend === 'sqlite-wasm' ? 'sqlite' : backend;
  }
  if (await exists(SQLiteStore.defaultPath(dataDir))) {
    return 'sqlite';
  }
  if (await exists(JsonStore.defaultPath(dataDir))) {
    return 'json';
  }
  throw new Error(`No control state found under ${dataDir}; pass --store only after confirming the intended data directory`);
}

function managedStagingPath(target, purpose) {
  const parent = path.dirname(target);
  const staging = path.join(
    parent,
    `.${path.basename(target)}.${purpose}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  );
  if (!pathContainedBy(parent, staging) || staging === parent) {
    throw new Error(`Unsafe staging path: ${staging}`);
  }
  return staging;
}

async function cleanupStaging(staging, target) {
  const parent = path.dirname(target);
  if (!pathContainedBy(parent, staging) || staging === parent || staging === target) {
    throw new Error(`Refusing to clean unsafe staging path: ${staging}`);
  }
  await fs.rm(staging, { recursive: true, force: true });
}

export async function createControlBackup(options = {}) {
  requireOfflineConfirmation(options);
  const dataDir = path.resolve(options.dataDir || '.nado');
  const output = path.resolve(options.output || `nado-control-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (pathContainedBy(dataDir, output)) {
    throw new Error('Backup output must be outside the control data directory');
  }
  if (!await exists(dataDir)) {
    throw new Error(`Control data directory does not exist: ${dataDir}`);
  }
  if (await exists(output)) {
    throw new Error(`Backup output already exists: ${output}`);
  }

  const backend = await discoverBackend(dataDir, options.backend);
  const store = createStore({ dataDir, backend });
  await store.load();
  await store.save();

  const staging = managedStagingPath(output, 'backup');
  try {
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    await copyRegularTree(dataDir, staging, {
      excludeRootNames: new Set([CONTROL_BACKUP_MANIFEST, CONTROL_RESTORE_RECEIPT]),
    });
    const copiedFiles = await listRegularFiles(staging);
    const files = [];
    for (const file of copiedFiles) {
      files.push({ path: file.relative, ...await hashFile(file.absolute) });
    }
    const manifest = {
      format: CONTROL_BACKUP_FORMAT,
      formatVersion: CONTROL_BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      backend,
      stateVersion: store.state.version,
      sqliteSchemaVersion: backend === 'sqlite' ? CURRENT_SQLITE_SCHEMA_VERSION : null,
      sourceDataDir: dataDir,
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      files,
    };
    const manifestPath = path.join(staging, CONTROL_BACKUP_MANIFEST);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(manifestPath, 0o600);
    await fs.rename(staging, output);
    return { output, manifest };
  } catch (error) {
    await cleanupStaging(staging, output);
    throw error;
  }
}

export async function verifyControlBackup(options = {}) {
  const backupDir = path.resolve(options.backupDir || options.from || '');
  const manifestPath = path.join(backupDir, CONTROL_BACKUP_MANIFEST);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.format !== CONTROL_BACKUP_FORMAT || manifest.formatVersion !== CONTROL_BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported control backup format: ${manifest.format || 'unknown'} v${manifest.formatVersion ?? 'unknown'}`);
  }
  if ((manifest.backend !== 'json' && manifest.backend !== 'sqlite')
    || typeof manifest.sourceDataDir !== 'string'
    || (!path.posix.isAbsolute(manifest.sourceDataDir) && !path.win32.isAbsolute(manifest.sourceDataDir))) {
    throw new Error('Backup manifest storage metadata is invalid');
  }
  if (manifest.stateVersion > CURRENT_STATE_VERSION) {
    throw new Error(`Backup state version ${manifest.stateVersion} is newer than supported version ${CURRENT_STATE_VERSION}`);
  }
  if (manifest.backend === 'sqlite' && manifest.sqliteSchemaVersion > CURRENT_SQLITE_SCHEMA_VERSION) {
    throw new Error(`Backup SQLite schema version ${manifest.sqliteSchemaVersion} is newer than supported version ${CURRENT_SQLITE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== manifest.fileCount
    || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) {
    throw new Error('Backup manifest file count is invalid');
  }

  const expected = new Map();
  for (const file of manifest.files) {
    const relative = safeManifestPath(file.path);
    if (expected.has(relative) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) {
      throw new Error(`Invalid backup manifest entry: ${relative}`);
    }
    expected.set(relative, file);
  }
  const actual = await listRegularFiles(backupDir, {
    excludeRootNames: new Set([CONTROL_BACKUP_MANIFEST]),
  });
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file.relative))) {
    throw new Error('Backup contents do not match the manifest');
  }
  let totalBytes = 0;
  for (const file of actual) {
    const digest = await hashFile(file.absolute);
    const declared = expected.get(file.relative);
    if (digest.bytes !== declared.bytes || digest.sha256 !== declared.sha256) {
      throw new Error(`Backup checksum mismatch: ${file.relative}`);
    }
    totalBytes += digest.bytes;
  }
  if (totalBytes !== manifest.totalBytes) {
    throw new Error('Backup total byte count is invalid');
  }
  return { backupDir, ok: true, manifest };
}

function sourcePathApi(sourceDataDir) {
  return /^[A-Za-z]:[\\/]/.test(sourceDataDir) || sourceDataDir.startsWith('\\\\')
    ? path.win32
    : path.posix;
}

function remapPersistedControlPaths(value, sourceDataDir, targetDataDir) {
  if (!value || typeof value !== 'object') {
    return;
  }
  const sourceApi = sourcePathApi(sourceDataDir);
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'storagePath' || key === 'tempPath') && typeof child === 'string') {
      const relative = sourceApi.relative(sourceDataDir, child);
      if (relative === '' || (!relative.startsWith('..') && !sourceApi.isAbsolute(relative))) {
        value[key] = path.join(targetDataDir, ...relative.split(/[\\/]+/).filter(Boolean));
      }
      continue;
    }
    remapPersistedControlPaths(child, sourceDataDir, targetDataDir);
  }
}

export async function restoreControlBackup(options = {}) {
  requireOfflineConfirmation(options);
  if (!options.dataDir) {
    throw new Error('Restore requires an explicit new --data-dir path');
  }
  const backupDir = path.resolve(options.backupDir || options.from || '');
  const target = path.resolve(options.dataDir || '');
  if (await exists(target)) {
    throw new Error(`Restore target already exists; choose a new empty path: ${target}`);
  }
  if (pathContainedBy(backupDir, target)) {
    throw new Error('Restore target must be outside the backup directory');
  }
  const verified = await verifyControlBackup({ backupDir });
  const staging = managedStagingPath(target, 'restore');
  try {
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    for (const file of verified.manifest.files) {
      const source = nativePath(backupDir, file.path);
      const destination = nativePath(staging, file.path);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.copyFile(source, destination);
      await fs.chmod(destination, 0o600);
      const copied = await hashFile(destination);
      if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) {
        throw new Error(`Restored file checksum mismatch: ${file.path}`);
      }
    }
    const store = createStore({ dataDir: staging, backend: verified.manifest.backend });
    await store.load();
    remapPersistedControlPaths(store.state, verified.manifest.sourceDataDir, target);
    await store.save();
    const manifestDigest = await hashFile(path.join(backupDir, CONTROL_BACKUP_MANIFEST));
    const receipt = normalizeRestoreReceipt({
      format: CONTROL_RESTORE_RECEIPT_FORMAT,
      formatVersion: CONTROL_RESTORE_RECEIPT_VERSION,
      id: `restore_${crypto.randomUUID()}`,
      restoredAt: new Date().toISOString(),
      sourceCreatedAt: verified.manifest.createdAt,
      manifestSha256: manifestDigest.sha256,
      backend: verified.manifest.backend,
      stateVersion: store.state.version,
      sqliteSchemaVersion: verified.manifest.backend === 'sqlite' ? CURRENT_SQLITE_SCHEMA_VERSION : null,
      fileCount: verified.manifest.fileCount,
      totalBytes: verified.manifest.totalBytes,
    });
    const receiptPath = path.join(staging, CONTROL_RESTORE_RECEIPT);
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(receiptPath, 0o600);
    await fs.rename(staging, target);
    return {
      ok: true,
      dataDir: target,
      backend: verified.manifest.backend,
      stateVersion: store.state.version,
      migrated: Boolean(store.lastMigration?.migrated),
      sourceCreatedAt: verified.manifest.createdAt,
      receipt,
    };
  } catch (error) {
    await cleanupStaging(staging, target);
    throw error;
  }
}
