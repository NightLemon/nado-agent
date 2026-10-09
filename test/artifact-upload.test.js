import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { runLargeArtifactResumeExercise } from '../src/acceptance-exercises.js';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';
import { JsonStore } from '../src/store.js';

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-artifact-upload-'));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function waitForTask(client, taskId, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { task } = await client.getTask(taskId);
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for task ${taskId}`);
}

test('chunked artifact uploads resume after restart and reject conflicting offsets', async () => {
  const root = await tempRoot();
  const dataDir = path.join(root, 'control');
  const token = 'chunk-restart-token';
  let running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir,
    storeBackend: 'sqlite',
  });
  let client = new NadoClient({ controlUrl: `http://127.0.0.1:${running.port}`, token });
  try {
    const capabilities = await client.capabilities();
    assert.equal(capabilities.features.resumableArtifactUploads, true);
    assert.equal(capabilities.features.streamingArtifactUploadWrites, true);
    assert.match(capabilities.endpoints.tasks.artifactUploadChunk, /chunks/);
    await client.registerWorker({ id: 'chunk-worker', capabilities: ['code'] });
    const created = await client.createTask({ workerId: 'chunk-worker', command: 'echo chunk' });
    const claimed = await client.claimTask('chunk-worker');
    const bytes = Buffer.from('resumable-cross-site-artifact');
    const descriptor = {
      path: 'large/result.bin',
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
    const { upload } = await client.createArtifactUpload(created.task.id, descriptor, claimed.task.currentAttemptId);
    const first = bytes.subarray(0, 9);
    const firstResult = await client.uploadArtifactChunk(
      created.task.id,
      upload.id,
      claimed.task.currentAttemptId,
      0,
      first,
    );
    assert.equal(firstResult.upload.committedBytes, first.length);
    const listed = await client.listArtifactUploads(created.task.id);
    assert.equal(listed.uploads.length, 1);
    assert.equal(listed.uploads[0].id, upload.id);
    assert.equal(listed.uploads[0].committedBytes, first.length);
    assert.equal(listed.uploads[0].tempPath, undefined);
    assert.equal(listed.uploads[0].storagePath, undefined);
    const scopedToken = await client.createWorkerToken({ workerId: 'chunk-worker' });
    const scopedClient = new NadoClient({ controlUrl: client.controlUrl, token: scopedToken.token });
    await assert.rejects(
      () => scopedClient.listArtifactUploads(created.task.id),
      /403: Worker tokens cannot call control-plane admin APIs/,
    );
    await assert.rejects(
      () => client.uploadArtifactChunk(created.task.id, upload.id, claimed.task.currentAttemptId, 0, first),
      (error) => error.status === 409 && error.expectedOffset === first.length,
    );

    await closeServer(running.server);
    running = await startControlServer({
      host: '127.0.0.1',
      port: 0,
      token,
      dataDir,
      storeBackend: 'sqlite',
    });
    client = new NadoClient({ controlUrl: `http://127.0.0.1:${running.port}`, token });
    const resumed = await client.getArtifactUpload(created.task.id, upload.id, claimed.task.currentAttemptId);
    assert.equal(resumed.upload.committedBytes, first.length);
    assert.equal((await client.listArtifactUploads(created.task.id)).uploads[0].committedBytes, first.length);

    await client.uploadArtifactChunk(
      created.task.id,
      upload.id,
      claimed.task.currentAttemptId,
      first.length,
      bytes.subarray(first.length),
    );
    const finalized = await client.finalizeArtifactUpload(created.task.id, upload.id, claimed.task.currentAttemptId);
    assert.equal(finalized.upload.status, 'finalized');
    await client.completeTask(created.task.id, {
      attemptId: claimed.task.currentAttemptId,
      status: 'succeeded',
      exitCode: 0,
      artifacts: [{ uploadId: upload.id }],
    });
    const { task } = await client.getTask(created.task.id);
    assert.equal(task.artifacts[0].path, descriptor.path);
    const downloaded = await client.downloadArtifact(task.id, task.artifacts[0].id);
    assert.deepEqual(downloaded.bytes, bytes);
  } finally {
    await closeServer(running.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an interrupted chunk is rolled back to the last committed offset', async () => {
  const root = await tempRoot();
  const store = new JsonStore(JsonStore.defaultPath(root));
  await store.load();
  try {
    await store.upsertWorker({ id: 'interrupt-worker', capabilities: ['code'] });
    const task = await store.createTask({ workerId: 'interrupt-worker', command: 'echo interrupted' });
    const claimed = await store.claimTask('interrupt-worker');
    const bytes = Buffer.from('complete-after-interruption');
    const upload = await store.createArtifactUpload(task.id, {
      workerId: 'interrupt-worker',
      attemptId: claimed.currentAttemptId,
      path: 'interrupt.bin',
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    async function* interrupted() {
      yield bytes.subarray(0, 7);
      throw new Error('simulated connection loss');
    }
    await assert.rejects(
      () => store.appendArtifactUpload(task.id, upload.id, {
        workerId: 'interrupt-worker',
        attemptId: claimed.currentAttemptId,
        offset: 0,
        chunkSha256: crypto.createHash('sha256').update(bytes.subarray(0, 7)).digest('hex'),
        stream: interrupted(),
      }),
      /simulated connection loss/,
    );
    assert.equal(store.state.artifactUploads[upload.id].committedBytes, 0);
    assert.equal((await fs.stat(store.state.artifactUploads[upload.id].tempPath)).size, 0);
    await store.appendArtifactUpload(task.id, upload.id, {
      workerId: 'interrupt-worker',
      attemptId: claimed.currentAttemptId,
      offset: 0,
      chunkSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      stream: Readable.from([bytes]),
    });
    const finalized = await store.finalizeArtifactUpload(task.id, upload.id, {
      workerId: 'interrupt-worker',
      attemptId: claimed.currentAttemptId,
    });
    assert.equal(finalized.status, 'finalized');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('signed chunk requests bind the signature body digest to streamed bytes', async () => {
  const root = await tempRoot();
  const token = 'signed-chunk-admin';
  const running = await startControlServer({ host: '127.0.0.1', port: 0, token, dataDir: path.join(root, 'control') });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  const admin = new NadoClient({ controlUrl, token });
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const issued = await admin.createWorkerToken({ workerId: 'signed-chunk-worker', publicKey: publicKeyPem });
    const worker = new NadoClient({
      controlUrl,
      token: issued.token,
      workerId: 'signed-chunk-worker',
      privateKeyPem,
    });
    await worker.registerWorker({ id: 'signed-chunk-worker', capabilities: ['code'] });
    const created = await admin.createTask({ workerId: 'signed-chunk-worker', command: 'echo signed' });
    const claimed = await worker.claimTask('signed-chunk-worker');
    const bytes = Buffer.from('signed-stream-body');
    const descriptor = {
      path: 'signed.bin',
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
    const { upload } = await worker.createArtifactUpload(created.task.id, descriptor, claimed.task.currentAttemptId);
    const chunkPath = `/api/tasks/${encodeURIComponent(created.task.id)}/artifact-uploads/${encodeURIComponent(upload.id)}/chunks?offset=0`;
    const signedForDifferentBytes = Buffer.from('different-content');
    const tampered = await fetch(`${controlUrl}${chunkPath}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${issued.token}`,
        'content-type': 'application/octet-stream',
        'x-nado-attempt-id': claimed.task.currentAttemptId,
        'x-nado-chunk-sha256': crypto.createHash('sha256').update(bytes).digest('hex'),
        ...worker.signingHeaders('PATCH', chunkPath, signedForDifferentBytes),
      },
      body: bytes,
    });
    assert.equal(tampered.status, 401);
    assert.match(await tampered.text(), /body SHA-256 mismatch/);
    const status = await worker.getArtifactUpload(created.task.id, upload.id, claimed.task.currentAttemptId);
    assert.equal(status.upload.committedBytes, 0);
    await worker.uploadArtifactChunk(created.task.id, upload.id, claimed.task.currentAttemptId, 0, bytes);
    const finalized = await worker.finalizeArtifactUpload(created.task.id, upload.id, claimed.task.currentAttemptId);
    assert.equal(finalized.upload.status, 'finalized');
  } finally {
    await closeServer(running.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('artifact uploads enforce worker ownership and reset after whole-file checksum failure', async () => {
  const root = await tempRoot();
  const token = 'chunk-security-token';
  const running = await startControlServer({ host: '127.0.0.1', port: 0, token, dataDir: path.join(root, 'control') });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  const admin = new NadoClient({ controlUrl, token });
  try {
    const ownerToken = await admin.createWorkerToken({ workerId: 'owner-worker' });
    const otherToken = await admin.createWorkerToken({ workerId: 'other-worker' });
    const owner = new NadoClient({ controlUrl, token: ownerToken.token });
    const other = new NadoClient({ controlUrl, token: otherToken.token });
    await owner.registerWorker({ id: 'owner-worker', capabilities: ['code'] });
    await other.registerWorker({ id: 'other-worker', capabilities: ['code'] });
    const created = await admin.createTask({
      workerId: 'owner-worker',
      command: 'echo owner',
      retryBackoffMs: 0,
    });
    const claimed = await owner.claimTask('owner-worker');
    const bytes = Buffer.from('actual bytes');
    const wrongDigest = crypto.createHash('sha256').update('different bytes').digest('hex');
    await assert.rejects(
      () => other.createArtifactUpload(created.task.id, {
        path: 'denied.bin',
        size: bytes.length,
        sha256: wrongDigest,
      }, claimed.task.currentAttemptId),
      (error) => error.status === 403,
    );
    const { upload } = await owner.createArtifactUpload(created.task.id, {
      path: 'bad-checksum.bin',
      size: bytes.length,
      sha256: wrongDigest,
    }, claimed.task.currentAttemptId);
    await owner.uploadArtifactChunk(created.task.id, upload.id, claimed.task.currentAttemptId, 0, bytes);
    await assert.rejects(
      () => owner.finalizeArtifactUpload(created.task.id, upload.id, claimed.task.currentAttemptId),
      (error) => error.status === 422 && error.expectedOffset === 0,
    );
    const status = await owner.getArtifactUpload(created.task.id, upload.id, claimed.task.currentAttemptId);
    assert.equal(status.upload.committedBytes, 0);
    assert.equal(status.upload.status, 'pending');

    running.store.state.workers['owner-worker'].lastSeenAt = new Date(Date.now() - 90_000).toISOString();
    await running.store.save();
    const recovered = await admin.recoverOfflineTasks({
      action: 'requeue',
      targetWorkerId: 'other-worker',
      reason: 'test stale artifact upload attempt',
    });
    assert.equal(recovered.recovered.length, 1);
    const newClaim = await other.claimTask('other-worker');
    assert.notEqual(newClaim.task.currentAttemptId, claimed.task.currentAttemptId);
    await assert.rejects(
      () => owner.getArtifactUpload(created.task.id, upload.id, claimed.task.currentAttemptId),
      (error) => error.status === 403,
    );
    await assert.rejects(
      () => other.getArtifactUpload(created.task.id, upload.id, newClaim.task.currentAttemptId),
      (error) => error.status === 409,
    );
  } finally {
    await closeServer(running.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('worker automatically uploads large artifacts in chunks before workspace cleanup', async () => {
  const root = await tempRoot();
  const token = 'chunk-worker-token';
  const running = await startControlServer({ host: '127.0.0.1', port: 0, token, dataDir: path.join(root, 'control') });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  const client = new NadoClient({ controlUrl, token });
  let worker;
  try {
    worker = await startWorker({
      id: 'large-artifact-worker',
      controlUrl,
      token,
      dataDir: root,
      cleanupWorkspaces: true,
      maxInlineArtifactBytes: 1024,
      artifactChunkBytes: 64 * 1024,
      pollMs: 25,
    });
    const created = await client.createTask({
      workerId: 'large-artifact-worker',
      artifactPolicy: { include: ['large.bin'] },
      command: "node -e \"require('fs').writeFileSync('large.bin', Buffer.alloc(300000, 37))\"",
    });
    const task = await waitForTask(client, created.task.id);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.workspaceCleaned, true);
    await assert.rejects(() => fs.access(task.workspace), (error) => error.code === 'ENOENT');
    const artifact = task.artifacts.find((item) => item.path === 'large.bin');
    assert.ok(artifact?.uploadId);
    assert.equal(artifact.size, 300000);
    const downloaded = await client.downloadArtifact(task.id, artifact.id);
    assert.equal(downloaded.bytes.length, 300000);
    assert.ok(downloaded.bytes.every((value) => value === 37));
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await closeServer(running.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('large artifact acceptance exercise resumes the real Worker upload after a transport stall', async () => {
  const root = await tempRoot();
  const token = 'large-artifact-exercise-token';
  const running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
    taskLeaseMs: 15_000,
  });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  const admin = new NadoClient({ controlUrl, token });
  const workerClient = new NadoClient({ controlUrl, token });
  const baseRequest = workerClient.request.bind(workerClient);
  const baseRequestRaw = workerClient.requestRaw.bind(workerClient);
  const baseUploadArtifactChunk = workerClient.uploadArtifactChunk.bind(workerClient);
  let networkDown = false;
  let committedChunks = 0;
  let releaseFirstChunk = null;
  workerClient.request = (...args) => (
    networkDown ? Promise.reject(new TypeError('simulated Worker network outage')) : baseRequest(...args)
  );
  workerClient.requestRaw = (...args) => (
    networkDown ? Promise.reject(new TypeError('simulated Worker network outage')) : baseRequestRaw(...args)
  );
  workerClient.uploadArtifactChunk = async (...args) => {
    const result = await baseUploadArtifactChunk(...args);
    committedChunks += 1;
    if (committedChunks === 1) {
      networkDown = true;
      await new Promise((resolve) => {
        releaseFirstChunk = resolve;
      });
    }
    return result;
  };
  let worker;
  const progress = [];
  try {
    worker = await startWorker({
      id: 'large-artifact-exercise-worker',
      controlUrl,
      token,
      client: workerClient,
      dataDir: path.join(root, 'worker'),
      capabilities: ['code'],
      maxInlineArtifactBytes: 1024,
      artifactChunkBytes: 64 * 1024,
      artifactUploadRetries: 100,
      pollMs: 25,
      longPollMs: 0,
      reconnectBaseMs: 25,
      reconnectMaxMs: 100,
      reconnectJitterRatio: 0,
      completionRetries: 100,
      completionRetryBaseMs: 25,
      completionRetryMaxMs: 100,
    });

    const result = await runLargeArtifactResumeExercise(admin, {
      workerId: 'large-artifact-exercise-worker',
      artifactBytes: 512 * 1024,
      minStallMs: 2_000,
      timeoutMs: 30_000,
      onProgress: (entry) => {
        progress.push(entry.phase);
        if (entry.phase === 'artifact_stall_observed') {
          networkDown = false;
          releaseFirstChunk?.();
          releaseFirstChunk = null;
        }
      },
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.attemptCount, 1);
    assert.equal(result.upload.firstObservedOffset, 64 * 1024);
    assert.equal(result.upload.stalledOffset, 64 * 1024);
    assert.equal(result.upload.finalizedOffset, 512 * 1024);
    assert.equal(result.artifact.sha256, result.upload.sha256);
    assert.ok(committedChunks > 1);
    assert.deepEqual(progress, [
      'disconnect_worker_network',
      'artifact_stall_observed',
      'artifact_upload_resumed',
    ]);
  } finally {
    networkDown = false;
    releaseFirstChunk?.();
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await closeServer(running.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});
