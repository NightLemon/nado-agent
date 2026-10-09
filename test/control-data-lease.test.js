import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONTROL_DATA_LEASE_DIRECTORY,
  acquireControlDataLease,
} from '../src/control-data-lease.js';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { JsonStore } from '../src/store.js';

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('Control data-directory lease rejects concurrent instances and releases on close', async () => {
  const root = await temporaryDirectory('nado-control-lease-server-');
  const options = {
    host: '127.0.0.1',
    port: 0,
    token: 'lease-test-admin',
    dataDir: root,
    storeBackend: 'json',
    controlDataLeaseTimeoutMs: 5_000,
    controlDataLeaseHeartbeatMs: 1_000,
  };
  let first;
  let replacement;
  try {
    first = await startControlServer(options);
    const client = new NadoClient({
      controlUrl: `http://127.0.0.1:${first.port}`,
      token: options.token,
    });
    const status = await client.status();
    assert.equal(status.storage.dataLease.status, 'owned');
    assert.equal(status.storage.dataLease.writeFencing, true);
    const capabilities = await client.capabilities();
    assert.equal(capabilities.storage.singleWriterLease.status, 'owned');
    await assert.rejects(
      startControlServer(options),
      (error) => error.code === 'NADO_CONTROL_DATA_DIR_LOCKED'
        && error.details?.owner?.controlInstanceId === first.controlRuntime.instanceId,
    );
    await closeServer(first.server);
    first = null;

    replacement = await startControlServer(options);
    assert.notEqual(replacement.controlRuntime.instanceId, null);
  } finally {
    if (first) {
      await closeServer(first.server);
    }
    if (replacement) {
      await closeServer(replacement.server);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a stale lease can be reclaimed and fences the old store snapshot', async () => {
  const root = await temporaryDirectory('nado-control-lease-stale-');
  let first;
  let replacement;
  try {
    first = await acquireControlDataLease(root, {
      controlInstanceId: 'control_old',
      timeoutMs: 5_000,
      heartbeatMs: 4_999,
    });
    const store = new JsonStore(path.join(root, 'control-state.json'));
    store.setWriteFence(first);
    await store.load();
    await store.save();

    const heartbeat = path.join(
      root,
      CONTROL_DATA_LEASE_DIRECTORY,
      `heartbeat-${first.leaseId}`,
    );
    const stale = new Date(Date.now() - 10_000);
    await fs.utimes(heartbeat, stale, stale);
    replacement = await acquireControlDataLease(root, {
      controlInstanceId: 'control_new',
      timeoutMs: 5_000,
      heartbeatMs: 1_000,
    });

    await assert.rejects(
      store.save(),
      (error) => error.code === 'NADO_CONTROL_DATA_LEASE_LOST',
    );
    await first.release();
    await replacement.assertOwned();
    assert.equal((await fs.stat(path.join(root, CONTROL_DATA_LEASE_DIRECTORY))).isDirectory(), true);
  } finally {
    await first?.release().catch(() => {});
    await replacement?.release().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});
