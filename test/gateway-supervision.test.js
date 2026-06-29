import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-gateway-'));
}

async function waitForTask(client, taskId, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  let lastTask = null;
  while (Date.now() - started < timeoutMs) {
    const { task } = await client.getTask(taskId);
    lastTask = task;
    if (predicate(task)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for task ${taskId}; last=${JSON.stringify(lastTask)}`);
}

async function waitForWorker(client, workerId, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  let lastWorker = null;
  while (Date.now() - started < timeoutMs) {
    const { worker } = await client.getWorker(workerId);
    lastWorker = worker;
    if (predicate(worker)) {
      return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for worker ${workerId}; last=${JSON.stringify(lastWorker)}`);
}

test('gateway supervises worker state, pause/resume, and cancel-current management', async () => {
  const root = await makeTempDir();
  const token = 'supervision-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });
  let worker;

  try {
    worker = await startWorker({
      id: 'managed-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
    });

    await waitForWorker(client, 'managed-worker', (item) => item.gatewayState === 'idle');

    const pause = await client.manageWorker('managed-worker', 'pause', 'test pause');
    assert.equal(pause.worker.adminState, 'paused');
    await waitForWorker(client, 'managed-worker', (item) => item.gatewayState === 'paused');

    const pausedTask = await client.createTask({
      title: 'must wait while paused',
      type: 'shell',
      workerId: 'managed-worker',
      command: 'node -e "console.log(\'should run after resume\')"',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await client.getTask(pausedTask.task.id)).task.status, 'queued');

    await client.manageWorker('managed-worker', 'resume', 'test resume');
    const resumed = await waitForTask(
      client,
      pausedTask.task.id,
      (task) => task.status === 'succeeded',
    );
    assert.equal(resumed.assignedWorkerId, 'managed-worker');

    const longTask = await client.createTask({
      title: 'cancel me',
      type: 'shell',
      workerId: 'managed-worker',
      command: 'node -e "setTimeout(() => {}, 10000)"',
    });
    await waitForTask(client, longTask.task.id, (task) => task.status === 'running');
    const runningWorker = await waitForWorker(
      client,
      'managed-worker',
      (item) => item.gatewayState === 'running' && item.currentTaskId === longTask.task.id,
    );
    assert.equal(runningWorker.currentTaskId, longTask.task.id);

    await client.manageWorker('managed-worker', 'cancel_current', 'test cancel');
    const cancelled = await waitForTask(
      client,
      longTask.task.id,
      (task) => task.status === 'cancelled',
    );
    assert.match(cancelled.error, /cancelled/i);
    await waitForWorker(client, 'managed-worker', (item) => item.currentTaskId === null);

    const shutdown = await client.manageWorker('managed-worker', 'shutdown', 'test shutdown');
    assert.equal(shutdown.worker.adminState, 'shutdown_requested');
    assert.equal(shutdown.command.action, 'shutdown');
    await waitForWorker(client, 'managed-worker', (item) => item.gatewayState === 'shutdown_requested');
    await Promise.race([
      worker.done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('worker did not stop after shutdown')), 5_000)),
    ]);

    const forgotten = await client.forgetWorker('managed-worker', 'test retire worker');
    assert.equal(forgotten.worker.id, 'managed-worker');
    assert.equal(forgotten.worker.gatewayState, 'shutdown_requested');
    assert.equal((await client.listWorkers()).workers.some((item) => item.id === 'managed-worker'), false);
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
