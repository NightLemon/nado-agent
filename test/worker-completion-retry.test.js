import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runVmRestartRecoveryExercise } from '../src/acceptance-exercises.js';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function closeServerImmediately(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function waitUntil(check, timeoutMs = 10_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await check();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for condition; last=${JSON.stringify(last)}`);
}

test('worker preserves a completed result while the control plane restarts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-completion-retry-'));
  const dataDir = path.join(root, 'control');
  const countFile = path.join(root, 'execution-count.txt');
  const scriptFile = path.join(root, 'delayed-result.mjs');
  const token = 'completion-retry-token';
  await fs.writeFile(scriptFile, [
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(countFile)}, 'run\\n');`,
    "await new Promise((resolve) => setTimeout(resolve, 700));",
    "console.log('result-produced-during-control-outage');",
  ].join('\n'));

  let running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir,
    storeBackend: 'sqlite',
    taskLeaseMs: 10_000,
  });
  const fixedPort = running.port;
  const controlUrl = `http://127.0.0.1:${fixedPort}`;
  let client = new NadoClient({ controlUrl, token });
  const logs = [];
  let worker;

  try {
    worker = await startWorker({
      id: 'completion-retry-worker',
      controlUrl,
      token,
      dataDir: path.join(root, 'worker'),
      capabilities: ['code'],
      pollMs: 25,
      longPollMs: 0,
      reconnectBaseMs: 25,
      reconnectMaxMs: 100,
      reconnectJitterRatio: 0,
      completionRetries: 40,
      completionRetryBaseMs: 25,
      completionRetryMaxMs: 100,
      onLog: (line) => logs.push(line),
    });
    const created = await client.createTask({
      title: 'complete while gateway is restarting',
      type: 'shell',
      workerId: 'completion-retry-worker',
      command: `node "${scriptFile}"`,
    });

    await waitUntil(async () => {
      const { task } = await client.getTask(created.task.id);
      return task.status === 'running' ? task : null;
    });
    await waitUntil(async () => {
      try {
        return (await fs.readFile(countFile, 'utf8')).trim() === 'run';
      } catch (error) {
        if (error.code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    });
    await closeServerImmediately(running.server);

    await waitUntil(() => logs.some((line) => line.includes('completion delivery failed')));

    running = await startControlServer({
      host: '127.0.0.1',
      port: fixedPort,
      token,
      dataDir,
      storeBackend: 'sqlite',
      taskLeaseMs: 10_000,
    });
    client = new NadoClient({ controlUrl, token });

    const completed = await waitUntil(async () => {
      const { task } = await client.getTask(created.task.id);
      return task.status === 'succeeded' ? task : null;
    });
    assert.match(completed.stdout, /result-produced-during-control-outage/);
    assert.equal((await fs.readFile(countFile, 'utf8')).trim().split(/\r?\n/).length, 1);
    assert.equal(completed.attempts.length, 1);
    await waitUntil(() => logs.some((line) => line.includes('completion delivery recovered')));
  } finally {
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

test('VM restart acceptance exercise survives a real SQLite control restart on the same port', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-vm-restart-exercise-'));
  const dataDir = path.join(root, 'control');
  const token = 'vm-restart-exercise-token';
  let running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir,
    storeBackend: 'sqlite',
    taskLeaseMs: 10_000,
  });
  const fixedPort = running.port;
  const controlUrl = `http://127.0.0.1:${fixedPort}`;
  const client = new NadoClient({ controlUrl, token });
  const progress = [];
  let restartPromise = null;
  let worker;

  try {
    worker = await startWorker({
      id: 'vm-restart-exercise-worker',
      controlUrl,
      token,
      dataDir: path.join(root, 'worker'),
      capabilities: ['code'],
      pollMs: 25,
      longPollMs: 0,
      reconnectBaseMs: 25,
      reconnectMaxMs: 100,
      reconnectJitterRatio: 0,
      completionRetries: 40,
      completionRetryBaseMs: 25,
      completionRetryMaxMs: 100,
    });

    const result = await runVmRestartRecoveryExercise(client, {
      workerId: 'vm-restart-exercise-worker',
      timeoutMs: 30_000,
      taskDurationMs: 1_200,
      onProgress: (entry) => {
        progress.push(entry.phase);
        if (entry.phase !== 'restart_control_now' || restartPromise) {
          return;
        }
        restartPromise = (async () => {
          await closeServerImmediately(running.server);
          await new Promise((resolve) => setTimeout(resolve, 600));
          running = await startControlServer({
            host: '127.0.0.1',
            port: fixedPort,
            token,
            dataDir,
            storeBackend: 'sqlite',
            taskLeaseMs: 10_000,
          });
        })();
      },
    });
    await restartPromise;

    assert.equal(result.ok, true, result.error);
    assert.equal(result.storage.backend, 'sqlite');
    assert.equal(result.attemptCount, 1);
    assert.equal(result.artifact.executionCount, 1);
    assert.equal(result.artifact.completionCount, 1);
    assert.notEqual(
      result.controlRestart.original.instanceId,
      result.controlRestart.restarted.instanceId,
    );
    assert.ok(result.controlRestart.unavailableObservations.length >= 1);
    assert.deepEqual(progress, [
      'restart_control_now',
      'control_unreachable',
      'control_restarted',
      'worker_reconnected',
    ]);
  } finally {
    await Promise.allSettled(restartPromise ? [restartPromise] : []);
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
