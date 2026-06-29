import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-env-'));
}

async function waitForTask(client, taskId, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { task } = await client.getTask(taskId);
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for task ${taskId}`);
}

async function waitForBatch(client, batchId, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { batch, tasks } = await client.getBatch(batchId);
    if (['succeeded', 'completed_with_errors'].includes(batch.status)) {
      return { batch, tasks };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for batch ${batchId}`);
}

test('task and batch env values are injected without overriding reserved NADO variables', async () => {
  const root = await makeTempDir();
  const token = 'env-token';
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
      id: 'env-worker',
      controlUrl,
      token,
      dataDir: root,
      pollMs: 50,
    });

    const taskCreated = await client.createTask({
      title: 'task env',
      type: 'shell',
      workerId: 'env-worker',
      env: {
        CUSTOM_VALUE: 'task-env',
        NADO_WORKER_ID: 'spoofed',
      },
      command: 'node -e "const fs=require(\'fs\'); fs.writeFileSync(\'env.txt\', process.env.CUSTOM_VALUE+\':\'+process.env.NADO_WORKER_ID)"',
    });
    assert.equal(taskCreated.task.env.CUSTOM_VALUE, 'task-env');
    const taskDone = await waitForTask(client, taskCreated.task.id);
    assert.equal(taskDone.status, 'succeeded');
    assert.equal(await fs.readFile(path.join(taskDone.workspace, 'env.txt'), 'utf8'), 'task-env:env-worker');

    const batchCreated = await client.createBatch({
      title: 'batch env',
      defaults: {
        workerId: 'env-worker',
        env: {
          SHARED_VALUE: 'shared',
          CHILD_VALUE: 'default-child',
        },
      },
      tasks: [
        {
          key: 'inherit',
          title: 'inherit env',
          command: 'node -e "const fs=require(\'fs\'); fs.writeFileSync(\'inherit.txt\', process.env.SHARED_VALUE+\':\'+process.env.CHILD_VALUE)"',
        },
        {
          key: 'override',
          title: 'override env',
          env: {
            CHILD_VALUE: 'override-child',
          },
          command: 'node -e "const fs=require(\'fs\'); fs.writeFileSync(\'override.txt\', process.env.SHARED_VALUE+\':\'+process.env.CHILD_VALUE)"',
        },
      ],
    });
    const inherited = batchCreated.tasks.find((task) => task.batchKey === 'inherit');
    const overridden = batchCreated.tasks.find((task) => task.batchKey === 'override');
    assert.deepEqual(inherited.env, { SHARED_VALUE: 'shared', CHILD_VALUE: 'default-child' });
    assert.deepEqual(overridden.env, { SHARED_VALUE: 'shared', CHILD_VALUE: 'override-child' });

    const batchDone = await waitForBatch(client, batchCreated.batch.id);
    assert.equal(batchDone.batch.status, 'succeeded');
    const inheritDone = batchDone.tasks.find((task) => task.batchKey === 'inherit');
    const overrideDone = batchDone.tasks.find((task) => task.batchKey === 'override');
    assert.equal(await fs.readFile(path.join(inheritDone.workspace, 'inherit.txt'), 'utf8'), 'shared:default-child');
    assert.equal(await fs.readFile(path.join(overrideDone.workspace, 'override.txt'), 'utf8'), 'shared:override-child');
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
