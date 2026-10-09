import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { runLargeInputResumeExercise } from '../src/acceptance-exercises.js';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { downloadTaskInputFile, startWorker } from '../src/worker-client.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-input-transfer-'));
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

async function bodyBytes(body) {
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test('large task input upload survives SQLite restart and queues only after finalization', async () => {
  const root = await tempRoot();
  const dataDir = path.join(root, 'control');
  const token = 'input-restart-token';
  let running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir,
    storeBackend: 'sqlite',
  });
  let client = new NadoClient({ controlUrl: `http://127.0.0.1:${running.port}`, token });
  let worker;
  try {
    await client.registerWorker({ id: 'input-worker', capabilities: ['code'] });
    const capabilities = await client.capabilities();
    assert.equal(capabilities.features.resumableTaskInputUploads, true);
    assert.equal(capabilities.features.rangedTaskInputDownloads, true);
    assert.match(capabilities.endpoints.tasks.inputDownload, /Range/);
    const bytes = Buffer.alloc(300_000, 73);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const created = await client.createTask({
      workerId: 'input-worker',
      command: "node -e \"const fs=require('fs');const c=require('crypto');fs.writeFileSync('digest.txt',c.createHash('sha256').update(fs.readFileSync('payload.bin')).digest('hex'))\"",
      artifactPolicy: { include: ['digest.txt'] },
      inputFiles: [{
        path: 'payload.bin',
        size: bytes.length,
        transfer: 'chunked',
        digestMode: 'server',
      }],
    });
    assert.equal(created.task.status, 'uploading_inputs');
    assert.equal(created.task.inputFiles[0].contentBase64, undefined);
    assert.equal((await client.claimTask('input-worker')).task, null);
    const uploadId = created.task.inputFiles[0].inputUploadId;
    const first = bytes.subarray(0, 100_000);
    await client.uploadTaskInputChunk(created.task.id, uploadId, 0, first);
    await assert.rejects(
      () => client.uploadTaskInputChunk(created.task.id, uploadId, 0, first),
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
    const resumed = await client.getTaskInputUpload(created.task.id, uploadId);
    assert.equal(resumed.upload.committedBytes, first.length);
    await client.uploadTaskInputChunk(created.task.id, uploadId, first.length, bytes.subarray(first.length));
    const finalized = await client.finalizeTaskInputUpload(created.task.id, uploadId);
    assert.equal(finalized.upload.status, 'finalized');
    assert.equal(finalized.upload.sha256, sha256);
    assert.equal(finalized.task.inputFiles[0].sha256, sha256);
    assert.equal(finalized.task.status, 'queued');

    worker = await startWorker({
      id: 'input-worker',
      controlUrl: client.controlUrl,
      token,
      dataDir: root,
      pollMs: 25,
    });
    const task = await waitForTask(client, created.task.id);
    assert.equal(task.status, 'succeeded');
    const artifact = task.artifacts.find((item) => item.path === 'digest.txt');
    assert.ok(artifact);
    const downloaded = await client.downloadArtifact(task.id, artifact.id);
    assert.equal(downloaded.bytes.toString('utf8'), sha256);
    const pruned = await client.pruneTaskHistory({ keep: 0 });
    assert.equal(pruned.prunedCount, 1);
    assert.equal(running.store.state.inputUploads[uploadId], undefined);
    await assert.rejects(
      () => fs.access(path.join(dataDir, 'inputs', created.task.id)),
      (error) => error.code === 'ENOENT',
    );
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await closeServer(running.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('worker input downloader resumes a partially streamed range and verifies SHA-256', async () => {
  const root = await tempRoot();
  try {
    const bytes = Buffer.from('resume-worker-input-after-disconnect');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const offsets = [];
    let call = 0;
    const client = {
      async streamTaskInput(taskId, inputId, attemptId, offset) {
        offsets.push(offset);
        call += 1;
        async function* body() {
          if (call === 1) {
            yield bytes.subarray(offset, offset + 9);
            throw new Error('simulated WAN disconnect');
          }
          yield bytes.subarray(offset);
        }
        return {
          body: body(),
          status: 206,
          range: `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
          size: bytes.length,
          sha256,
        };
      },
    };
    const target = path.join(root, 'workspace', 'input.bin');
    await downloadTaskInputFile(client, {
      id: 'task-download',
      currentAttemptId: 'attempt-download',
    }, {
      path: 'input.bin',
      inputUploadId: 'input-download',
      size: bytes.length,
      sha256,
    }, target, {
      maxRetries: 3,
      retryBaseMs: 1,
      retryMaxMs: 5,
    });
    assert.deepEqual(offsets, [0, 9]);
    assert.deepEqual(await fs.readFile(target), bytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI automatically switches a large local input to the resumable task-input path', async () => {
  const root = await tempRoot();
  const token = 'cli-large-input-token';
  const running = await startControlServer({ host: '127.0.0.1', port: 0, token, dataDir: path.join(root, 'control') });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  const admin = new NadoClient({ controlUrl, token });
  let worker;
  try {
    worker = await startWorker({ id: 'cli-input-worker', controlUrl, token, dataDir: root, pollMs: 25 });
    const inputPath = path.join(root, 'large.dat');
    await fs.writeFile(inputPath, Buffer.alloc(300_000, 19));
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'submit',
      '--control',
      controlUrl,
      '--worker',
      'cli-input-worker',
      '--title',
      'cli resumable input',
      '--file',
      inputPath,
      '--wait',
      '--command',
      "node -e \"const fs=require('fs');fs.writeFileSync('size.txt',String(fs.statSync('large.dat').size))\"",
    ], {
      env: {
        ...process.env,
        NADO_TOKEN: token,
        NADO_INPUT_INLINE_MAX_BYTES: '1024',
        NADO_INPUT_CHUNK_BYTES: '65536',
      },
      timeout: 15_000,
    });
    assert.match(stdout, /waitStatus=succeeded/);
    const task = (await admin.listTasks()).tasks.find((item) => item.title === 'cli resumable input');
    assert.ok(task.inputFiles[0].inputUploadId);
    assert.equal(task.inputFiles[0].contentBase64, undefined);
    assert.equal(task.inputFiles[0].ready, true);
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await closeServer(running.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task input ranges enforce assigned worker and current attempt ownership', async () => {
  const root = await tempRoot();
  const token = 'input-owner-token';
  const running = await startControlServer({ host: '127.0.0.1', port: 0, token, dataDir: path.join(root, 'control') });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  const admin = new NadoClient({ controlUrl, token });
  try {
    const ownerToken = await admin.createWorkerToken({ workerId: 'input-owner' });
    const otherToken = await admin.createWorkerToken({ workerId: 'input-other' });
    const owner = new NadoClient({ controlUrl, token: ownerToken.token });
    const other = new NadoClient({ controlUrl, token: otherToken.token });
    await owner.registerWorker({ id: 'input-owner', capabilities: ['code'] });
    await other.registerWorker({ id: 'input-other', capabilities: ['code'] });
    const bytes = Buffer.from('range-protected-input');
    const created = await admin.createTask({
      workerId: 'input-owner',
      command: 'echo input',
      retryBackoffMs: 0,
      inputFiles: [{
        path: 'protected.bin',
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        transfer: 'chunked',
      }],
    });
    const uploadId = created.task.inputFiles[0].inputUploadId;
    await admin.uploadTaskInputChunk(created.task.id, uploadId, 0, bytes);
    await admin.finalizeTaskInputUpload(created.task.id, uploadId);
    const claimed = await owner.claimTask('input-owner');
    await assert.rejects(
      () => other.streamTaskInput(created.task.id, uploadId, claimed.task.currentAttemptId, 0),
      (error) => error.status === 403,
    );
    await assert.rejects(
      () => owner.streamTaskInput(created.task.id, uploadId, claimed.task.currentAttemptId, bytes.length),
      (error) => error.status === 416,
    );
    assert.equal(
      (await admin.listTaskEvents(created.task.id)).events.some((event) => event.data?.offset === bytes.length),
      false,
    );
    const ranged = await owner.streamTaskInput(created.task.id, uploadId, claimed.task.currentAttemptId, 6);
    assert.equal(ranged.status, 206);
    assert.deepEqual(await bodyBytes(ranged.body), bytes.subarray(6));
    const rangeEvent = (await admin.listTaskEvents(created.task.id)).events.find((event) => (
      event.type === 'input_download_range' && event.data?.offset === 6
    ));
    assert.equal(rangeEvent.data.inputId, uploadId);
    assert.equal(rangeEvent.data.attemptId, claimed.task.currentAttemptId);
    assert.equal(rangeEvent.data.resumed, true);

    running.store.state.workers['input-owner'].lastSeenAt = new Date(Date.now() - 90_000).toISOString();
    await running.store.save();
    await admin.recoverOfflineTasks({ action: 'requeue', targetWorkerId: 'input-other' });
    const newClaim = await other.claimTask('input-other');
    await assert.rejects(
      () => admin.streamTaskInput(created.task.id, uploadId, claimed.task.currentAttemptId, 0),
      (error) => error.status === 409,
    );
    const fresh = await other.streamTaskInput(created.task.id, uploadId, newClaim.task.currentAttemptId, 0);
    assert.deepEqual(await bodyBytes(fresh.body), bytes);
  } finally {
    await closeServer(running.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('large input acceptance exercise resumes the real Worker Range download after transport loss', async () => {
  const root = await tempRoot();
  const token = 'large-input-exercise-token';
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
  const baseStreamTaskInput = workerClient.streamTaskInput.bind(workerClient);
  let networkDown = false;
  let firstStream = true;
  let releaseInterruptedStream = null;
  workerClient.request = (...args) => (
    networkDown ? Promise.reject(new TypeError('simulated Worker network outage')) : baseRequest(...args)
  );
  workerClient.requestRaw = (...args) => (
    networkDown ? Promise.reject(new TypeError('simulated Worker network outage')) : baseRequestRaw(...args)
  );
  workerClient.streamTaskInput = async (...args) => {
    if (networkDown) {
      throw new TypeError('simulated Worker network outage');
    }
    const response = await baseStreamTaskInput(...args);
    if (!firstStream) {
      return response;
    }
    firstStream = false;
    const originalBody = response.body;
    return {
      ...response,
      body: (async function* interruptedBody() {
        const iterator = originalBody[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done) {
          throw new Error('Expected a non-empty first input range');
        }
        const value = Buffer.from(first.value);
        yield value.subarray(0, Math.min(value.length, 64 * 1024));
        networkDown = true;
        await new Promise((resolve) => {
          releaseInterruptedStream = resolve;
        });
        await iterator.return?.();
        throw new Error('simulated interrupted input response body');
      })(),
    };
  };
  let worker;
  const progress = [];
  try {
    worker = await startWorker({
      id: 'large-input-exercise-worker',
      controlUrl,
      token,
      client: workerClient,
      dataDir: path.join(root, 'worker'),
      capabilities: ['code'],
      inputDownloadRetries: 100,
      pollMs: 25,
      longPollMs: 0,
      reconnectBaseMs: 25,
      reconnectMaxMs: 100,
      reconnectJitterRatio: 0,
      completionRetries: 100,
      completionRetryBaseMs: 25,
      completionRetryMaxMs: 100,
    });

    const result = await runLargeInputResumeExercise(admin, {
      workerId: 'large-input-exercise-worker',
      inputBytes: 512 * 1024,
      minStallMs: 2_000,
      timeoutMs: 30_000,
      onProgress: (entry) => {
        progress.push(entry.phase);
        if (entry.phase === 'input_download_stall_observed') {
          networkDown = false;
          releaseInterruptedStream?.();
          releaseInterruptedStream = null;
        }
      },
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.attemptCount, 1);
    assert.equal(result.input.initialOffset, 0);
    assert.ok(result.input.resumedOffset > 0);
    assert.ok(result.input.resumedOffset < result.input.size);
    assert.equal(result.input.size, 512 * 1024);
    assert.deepEqual(progress, [
      'staging_input',
      'disconnect_worker_network',
      'input_download_stall_observed',
      'input_download_resumed',
    ]);
  } finally {
    networkDown = false;
    releaseInterruptedStream?.();
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await closeServer(running.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});
