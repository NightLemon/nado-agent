import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-priority-'));
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

test('higher priority queued tasks are claimed first', async () => {
  const root = await makeTempDir();
  const token = 'priority-token';
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
    const low = await client.createTask({
      title: 'low priority task',
      type: 'shell',
      priority: 0,
      command: 'node -e "console.log(\'low\')"',
    });
    const high = await client.createTask({
      title: 'high priority task',
      type: 'shell',
      priority: 50,
      command: 'node -e "setTimeout(() => { console.log(\'high\') }, 600)"',
    });

    worker = await startWorker({
      id: 'priority-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      maxConcurrency: 1,
      pollMs: 50,
    });

    const highRunning = await waitForTask(client, high.task.id, (task) => task.status === 'running' || task.status === 'succeeded');
    const lowBeforeHighDone = await client.getTask(low.task.id);
    assert.equal(highRunning.assignedWorkerId || highRunning.requestedWorkerId, 'priority-worker');
    assert.equal(lowBeforeHighDone.task.status, 'queued');

    const highDone = await waitForTask(client, high.task.id, (task) => task.status === 'succeeded');
    const lowDone = await waitForTask(client, low.task.id, (task) => task.status === 'succeeded');
    assert.match(highDone.stdout, /high/);
    assert.match(lowDone.stdout, /low/);
    assert.ok(Date.parse(highDone.startedAt) <= Date.parse(lowDone.startedAt));
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
