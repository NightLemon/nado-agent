import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-sandbox-'));
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

test('isolated sandbox profile runs with minimal inherited environment', async () => {
  const root = await makeTempDir();
  const token = 'sandbox-token';
  const previousLeak = process.env.NADO_SANDBOX_LEAK_TEST;
  process.env.NADO_SANDBOX_LEAK_TEST = 'should-not-leak';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });
  const worker = await startWorker({
    id: 'sandbox-worker',
    controlUrl,
    token,
    dataDir: root,
    capabilities: ['code'],
    pollMs: 50,
  });

  try {
    const created = await client.createTask({
      title: 'isolated env',
      type: 'shell',
      workerId: 'sandbox-worker',
      sandboxProfile: 'isolated',
      env: {
        ALLOWED_VALUE: 'explicit-env',
      },
      command: 'node -e "const fs=require(\'fs\'); fs.writeFileSync(\'env.txt\', [process.env.NADO_SANDBOX_LEAK_TEST || \'\', process.env.ALLOWED_VALUE || \'\', process.env.NADO_WORKER_ID || \'\', process.env.NADO_SANDBOX_PROFILE || \'\'].join(\'|\'))"',
    });
    assert.equal(created.task.sandboxProfile, 'isolated');

    const done = await waitForTask(client, created.task.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(await fs.readFile(path.join(done.workspace, 'env.txt'), 'utf8'), '|explicit-env|sandbox-worker|isolated');
  } finally {
    if (previousLeak === undefined) {
      delete process.env.NADO_SANDBOX_LEAK_TEST;
    } else {
      process.env.NADO_SANDBOX_LEAK_TEST = previousLeak;
    }
    worker.stop();
    await worker.done.catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
