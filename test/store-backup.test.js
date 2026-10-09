import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { runBackupRestoreExercise } from '../src/acceptance-exercises.js';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import {
  CURRENT_SQLITE_SCHEMA_VERSION,
  CURRENT_STATE_VERSION,
  JsonStore,
  SQLiteStore,
} from '../src/store.js';
import {
  CONTROL_BACKUP_MANIFEST,
  CONTROL_RESTORE_RECEIPT,
  createControlBackup,
  readControlRestoreReceipt,
  restoreControlBackup,
  verifyControlBackup,
} from '../src/store-backup.js';
import { startWorker } from '../src/worker-client.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-store-backup-'));
}

async function closeServerImmediately(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function seedStore(store, dataDir, workerId = 'backup-worker') {
  await store.load();
  await store.upsertWorker({ id: workerId, capabilities: ['code'], observedState: 'idle' });
  const task = await store.createTask({
    title: 'backup state task',
    command: 'echo backup',
    workerId,
  });
  const artifactPath = path.join(dataDir, 'artifacts', task.id, 'result.txt');
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, 'durable-backup-artifact', 'utf8');
  store.state.tasks[task.id].artifacts = [{
    id: 'artifact_result',
    path: 'result.txt',
    storagePath: artifactPath,
    size: 23,
    sha256: null,
    skipped: false,
  }];
  store.state.version = 1;
  await store.save();
  return { taskId: task.id, artifactPath };
}

test('JSON control backup migrates, verifies, restores, and remaps persisted file paths', async () => {
  const root = await tempDir();
  const dataDir = path.join(root, 'source-control');
  const backupDir = path.join(root, 'backup');
  const restoredDir = path.join(root, 'restored-control');
  const store = new JsonStore(JsonStore.defaultPath(dataDir));

  try {
    const seeded = await seedStore(store, dataDir);
    const abandonedAtomicWrite = `${JsonStore.defaultPath(dataDir)}.${process.pid}.${Date.now()}.deadbeef.tmp`;
    await fs.writeFile(abandonedAtomicWrite, 'incomplete-state', 'utf8');
    const staleLeaseDir = path.join(dataDir, '.nado-control-lease.stale-test');
    await fs.mkdir(staleLeaseDir, { recursive: true });
    await fs.writeFile(path.join(staleLeaseDir, 'owner.json'), '{"stale":true}\n', 'utf8');
    await assert.rejects(
      () => createControlBackup({ dataDir, output: backupDir, backend: 'json' }),
      /Offline confirmation required/,
    );

    const created = await createControlBackup({
      dataDir,
      output: backupDir,
      backend: 'json',
      offlineConfirmed: true,
    });
    assert.equal(created.manifest.stateVersion, CURRENT_STATE_VERSION);
    assert.equal(created.manifest.backend, 'json');
    assert.ok(created.manifest.files.some((file) => file.path.endsWith('result.txt')));
    assert.equal(created.manifest.files.some((file) => file.path.endsWith('.tmp')), false);
    assert.equal(created.manifest.files.some((file) => file.path.includes('.nado-control-lease')), false);
    assert.equal((await verifyControlBackup({ backupDir })).ok, true);

    const restored = await restoreControlBackup({
      backupDir,
      dataDir: restoredDir,
      offlineConfirmed: true,
    });
    assert.equal(restored.stateVersion, CURRENT_STATE_VERSION);
    assert.match(restored.receipt.id, /^restore_[0-9a-f-]{36}$/);
    assert.match(restored.receipt.manifestSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readControlRestoreReceipt(restoredDir), restored.receipt);
    const reloaded = new JsonStore(JsonStore.defaultPath(restoredDir));
    await reloaded.load();
    const restoredArtifact = reloaded.state.tasks[seeded.taskId].artifacts[0];
    assert.equal(restoredArtifact.storagePath, path.join(restoredDir, 'artifacts', seeded.taskId, 'result.txt'));
    assert.equal(await fs.readFile(restoredArtifact.storagePath, 'utf8'), 'durable-backup-artifact');

    const mismatchedReceipt = await readControlRestoreReceipt(restoredDir);
    mismatchedReceipt.backend = 'sqlite';
    mismatchedReceipt.sqliteSchemaVersion = CURRENT_SQLITE_SCHEMA_VERSION;
    await fs.writeFile(
      path.join(restoredDir, CONTROL_RESTORE_RECEIPT),
      JSON.stringify(mismatchedReceipt),
      'utf8',
    );
    await assert.rejects(
      () => startControlServer({
        host: '127.0.0.1',
        port: 0,
        token: 'receipt-backend-mismatch',
        dataDir: restoredDir,
        storeBackend: 'json',
      }),
      /restore receipt backend sqlite does not match active store json/,
    );

    await fs.appendFile(path.join(backupDir, 'artifacts', seeded.taskId, 'result.txt'), '-tampered');
    await assert.rejects(
      () => verifyControlBackup({ backupDir }),
      /checksum mismatch/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite backups preserve explicit database and state schema versions across restore', async () => {
  const root = await tempDir();
  const dataDir = path.join(root, 'sqlite-control');
  const backupDir = path.join(root, 'sqlite-backup');
  const restoredDir = path.join(root, 'sqlite-restored');
  const store = new SQLiteStore(SQLiteStore.defaultPath(dataDir));

  try {
    const seeded = await seedStore(store, dataDir, 'sqlite-backup-worker');
    const created = await createControlBackup({
      dataDir,
      output: backupDir,
      backend: 'sqlite',
      offlineConfirmed: true,
    });
    assert.equal(created.manifest.stateVersion, CURRENT_STATE_VERSION);
    assert.equal(created.manifest.sqliteSchemaVersion, CURRENT_SQLITE_SCHEMA_VERSION);
    assert.equal(JSON.parse(await fs.readFile(path.join(backupDir, CONTROL_BACKUP_MANIFEST), 'utf8')).fileCount, created.manifest.fileCount);

    const restored = await restoreControlBackup({ backupDir, dataDir: restoredDir, offlineConfirmed: true });
    assert.equal(restored.receipt.backend, 'sqlite');
    assert.equal(restored.receipt.sqliteSchemaVersion, CURRENT_SQLITE_SCHEMA_VERSION);
    assert.equal((await fs.stat(path.join(restoredDir, CONTROL_RESTORE_RECEIPT))).isFile(), true);
    const reloaded = new SQLiteStore(SQLiteStore.defaultPath(restoredDir));
    await reloaded.load();
    assert.equal(reloaded.state.version, CURRENT_STATE_VERSION);
    assert.equal(reloaded.schemaVersion, CURRENT_SQLITE_SCHEMA_VERSION);
    assert.equal(reloaded.getTask(seeded.taskId).title, 'backup state task');
    assert.equal(await fs.readFile(reloaded.state.tasks[seeded.taskId].artifacts[0].storagePath, 'utf8'), 'durable-backup-artifact');

    const secondBackupDir = path.join(root, 'sqlite-backup-after-restore');
    const second = await createControlBackup({
      dataDir: restoredDir,
      output: secondBackupDir,
      backend: 'sqlite',
      offlineConfirmed: true,
    });
    assert.equal(second.manifest.files.some((file) => file.path === CONTROL_RESTORE_RECEIPT), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stores reject state written by a newer incompatible runtime', async () => {
  const root = await tempDir();
  const file = JsonStore.defaultPath(root);
  try {
    await fs.writeFile(file, JSON.stringify({ version: CURRENT_STATE_VERSION + 1 }), 'utf8');
    await assert.rejects(
      () => new JsonStore(file).load(),
      /newer than supported/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI provides offline backup, verification, and fresh-directory restore', async () => {
  const root = await tempDir();
  const dataDir = path.join(root, 'cli-source');
  const backupDir = path.join(root, 'cli-backup');
  const restoredDir = path.join(root, 'cli-restored');
  const store = new JsonStore(JsonStore.defaultPath(dataDir));

  try {
    await seedStore(store, dataDir, 'cli-backup-worker');
    const backup = await execFileAsync(process.execPath, [
      cliPath, 'store', 'backup',
      '--data-dir', dataDir,
      '--out', backupDir,
      '--store', 'json',
      '--offline-confirmed',
    ]);
    assert.match(backup.stdout, /verification=ok/);

    const verify = await execFileAsync(process.execPath, [
      cliPath, 'store', 'verify', '--from', backupDir,
    ]);
    assert.match(verify.stdout, /verification=ok/);

    const restore = await execFileAsync(process.execPath, [
      cliPath, 'store', 'restore',
      '--from', backupDir,
      '--data-dir', restoredDir,
      '--offline-confirmed',
    ]);
    assert.match(restore.stdout, /verification=ok/);
    assert.match(restore.stdout, /restoreReceipt=restore_[0-9a-f-]{36}/);
    assert.match(restore.stdout, /backupManifestSha256=[a-f0-9]{64}/);
    assert.equal(await fs.readFile(JsonStore.defaultPath(restoredDir), 'utf8').then((text) => JSON.parse(text).version), CURRENT_STATE_VERSION);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('backup restore acceptance exercise boots a fresh restored control and runs new work', async () => {
  const root = await tempDir();
  const sourceDataDir = path.join(root, 'acceptance-source');
  const backupDir = path.join(root, 'acceptance-backup');
  const restoredDataDir = path.join(root, 'acceptance-restored');
  const token = 'backup-restore-acceptance-token';
  let running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: sourceDataDir,
    storeBackend: 'sqlite',
    taskLeaseMs: 15_000,
  });
  const fixedPort = running.port;
  const controlUrl = `http://127.0.0.1:${fixedPort}`;
  const client = new NadoClient({ controlUrl, token });
  let worker;
  let restorePromise = null;
  const progress = [];
  try {
    worker = await startWorker({
      id: 'backup-restore-acceptance-worker',
      controlUrl,
      token,
      dataDir: path.join(root, 'worker'),
      capabilities: ['code'],
      pollMs: 25,
      longPollMs: 0,
      reconnectBaseMs: 25,
      reconnectMaxMs: 100,
      reconnectJitterRatio: 0,
    });

    const result = await runBackupRestoreExercise(client, {
      workerId: 'backup-restore-acceptance-worker',
      sourceDataDir,
      backupDir,
      restoredDataDir,
      timeoutMs: 60_000,
      onProgress: (entry) => {
        progress.push(entry.phase);
        if (entry.phase !== 'backup_restore_now' || restorePromise) {
          return;
        }
        restorePromise = (async () => {
          await closeServerImmediately(running.server);
          await createControlBackup({
            dataDir: sourceDataDir,
            output: backupDir,
            backend: 'sqlite',
            offlineConfirmed: true,
          });
          await verifyControlBackup({ backupDir });
          await restoreControlBackup({
            backupDir,
            dataDir: restoredDataDir,
            offlineConfirmed: true,
          });
          running = await startControlServer({
            host: '127.0.0.1',
            port: fixedPort,
            token,
            dataDir: restoredDataDir,
            storeBackend: 'sqlite',
            taskLeaseMs: 15_000,
          });
        })();
      },
    });
    await restorePromise;

    assert.equal(result.ok, true, result.error);
    assert.equal(result.restoreReceipt.backend, 'sqlite');
    assert.match(result.restoreReceipt.id, /^restore_[0-9a-f-]{36}$/);
    assert.match(result.restoreReceipt.manifestSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(result.controlRestart.original.instanceId, result.controlRestart.restarted.instanceId);
    assert.equal(result.controlRestart.outageObserved, true);
    assert.ok(result.controlRestart.unavailableObservations.length >= 1);
    assert.ok(result.markerTask.id);
    assert.ok(result.postRestoreTask.id);
    assert.equal(JSON.stringify(result).includes(sourceDataDir), false);
    assert.equal(JSON.stringify(result).includes(backupDir), false);
    assert.equal(JSON.stringify(result).includes(restoredDataDir), false);
    assert.deepEqual(progress, [
      'backup_restore_now',
      'control_unreachable',
      'restored_control_started',
    ]);
    const status = await client.status();
    assert.deepEqual(status.storage.restoreReceipt, result.restoreReceipt);
  } finally {
    await Promise.allSettled(restorePromise ? [restorePromise] : []);
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    if (running.server.listening) {
      await closeServerImmediately(running.server);
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
