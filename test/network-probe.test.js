import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import {
  NETWORK_PROBE_MAX_BYTES,
  bandwidthBytesPerSecond,
  normalizeNetworkProbeBytes,
  normalizeNetworkProbeIntervalMs,
} from '../src/network-probe.js';

test('network probe configuration is bounded and bandwidth uses measured duration', () => {
  assert.equal(normalizeNetworkProbeBytes(undefined), 65_536);
  assert.equal(normalizeNetworkProbeIntervalMs(undefined), 300_000);
  assert.equal(normalizeNetworkProbeIntervalMs(0), 0);
  assert.equal(bandwidthBytesPerSecond(100_000, 200), 500_000);
  assert.throws(() => normalizeNetworkProbeBytes(1024), /at least/);
  assert.throws(() => normalizeNetworkProbeBytes(NETWORK_PROBE_MAX_BYTES + 1), /cannot exceed/);
  assert.throws(() => normalizeNetworkProbeIntervalMs(5_000), /at least/);
});

test('worker-scoped upload and download probes enforce identity integrity size and rate limits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-network-probe-'));
  const token = 'network-probe-admin';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
    networkProbeMinIntervalMs: 1_000,
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const admin = new NadoClient({ controlUrl, token });
  try {
    const workerA = await admin.createWorkerToken({ workerId: 'probe-a' });
    const workerB = await admin.createWorkerToken({ workerId: 'probe-b' });
    const clientA = new NadoClient({ controlUrl, token: workerA.token });
    const clientB = new NadoClient({ controlUrl, token: workerB.token });

    const download = await clientA.downloadWorkerNetworkProbe('probe-a', 8192);
    const upload = await clientA.uploadWorkerNetworkProbe('probe-a', 8192);
    assert.equal(download.bytes, 8192);
    assert.equal(upload.bytes, 8192);
    assert.match(download.sha256, /^[a-f0-9]{64}$/);
    assert.match(upload.sha256, /^[a-f0-9]{64}$/);

    await assert.rejects(
      () => clientA.downloadWorkerNetworkProbe('probe-b', 8192),
      /403.*not valid for worker/i,
    );
    await assert.rejects(
      () => clientA.downloadWorkerNetworkProbe('probe-a', 8192),
      /429.*rate limit/i,
    );
    await assert.rejects(
      () => clientB.downloadWorkerNetworkProbe('probe-b', NETWORK_PROBE_MAX_BYTES + 1),
      /413.*cannot exceed/i,
    );
    await assert.rejects(
      () => clientB.uploadWorkerNetworkProbe('probe-b', 1024),
      /400.*at least/i,
    );

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = await admin.createWorkerToken({
      workerId: 'probe-signed',
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    });
    const signedClient = new NadoClient({
      controlUrl,
      token: signed.token,
      workerId: 'probe-signed',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    });
    assert.equal((await signedClient.downloadWorkerNetworkProbe('probe-signed', 4096)).bytes, 4096);
    assert.equal((await signedClient.uploadWorkerNetworkProbe('probe-signed', 4096)).bytes, 4096);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
