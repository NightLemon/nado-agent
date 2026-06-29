import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-task-mgmt-'));
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

test('gateway can cancel running tasks and requeue failed tasks to another worker', async () => {
  const root = await makeTempDir();
  const token = 'task-management-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });
  const workers = [];

  try {
    workers.push(await startWorker({
      id: 'bad-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
    }));
    workers.push(await startWorker({
      id: 'good-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
    }));

    const longTask = await client.createTask({
      title: 'cancel by task management',
      type: 'shell',
      workerId: 'good-worker',
      command: 'node -e "setTimeout(() => {}, 10000)"',
    });
    await waitForTask(client, longTask.task.id, (task) => task.status === 'running');
    const cancelled = await client.manageTask(longTask.task.id, 'cancel', {
      reason: 'test task cancel',
    });
    assert.equal(cancelled.task.status, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stillCancelled = await client.getTask(longTask.task.id);
    assert.equal(stillCancelled.task.status, 'cancelled');

    const retryTask = await client.createTask({
      title: 'retry elsewhere',
      type: 'shell',
      workerId: 'bad-worker',
      command: 'node -e "if (process.env.NADO_WORKER_ID === \'bad-worker\') process.exit(2); console.log(process.env.NADO_WORKER_ID)"',
    });
    const failed = await waitForTask(client, retryTask.task.id, (task) => task.status === 'failed');
    assert.equal(failed.assignedWorkerId, 'bad-worker');

    const requeued = await client.manageTask(retryTask.task.id, 'requeue', {
      workerId: 'good-worker',
      reason: 'try healthy worker',
    });
    assert.ok(['queued', 'running', 'succeeded'].includes(requeued.task.status));
    assert.equal(requeued.task.requestedWorkerId, 'good-worker');

    const succeeded = await waitForTask(client, retryTask.task.id, (task) => task.status === 'succeeded');
    assert.equal(succeeded.assignedWorkerId, 'good-worker');
    assert.match(succeeded.stdout, /good-worker/);
  } finally {
    for (const worker of workers) {
      worker.stop();
    }
    await Promise.allSettled(workers.map((worker) => worker.done));
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
