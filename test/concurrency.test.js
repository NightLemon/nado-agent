import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-concurrency-'));
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

test('worker maxConcurrency allows bounded parallel task execution', async () => {
  const root = await makeTempDir();
  const token = 'concurrency-token';
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
      id: 'parallel-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      maxConcurrency: 2,
      pollMs: 50,
    });

    const first = await client.createTask({
      title: 'parallel first',
      type: 'shell',
      workerId: 'parallel-worker',
      command: 'node -e "setTimeout(() => { console.log(\'first done\') }, 1200)"',
    });
    const second = await client.createTask({
      title: 'parallel second',
      type: 'shell',
      workerId: 'parallel-worker',
      command: 'node -e "setTimeout(() => { console.log(\'second done\') }, 1200)"',
    });

    await waitForTask(client, first.task.id, (task) => task.status === 'running');
    await waitForTask(client, second.task.id, (task) => task.status === 'running');
    const saturated = await waitForWorker(
      client,
      'parallel-worker',
      (item) => item.runningTasks === 2 && item.availableSlots === 0,
    );
    assert.equal(saturated.maxConcurrency, 2);
    assert.equal(saturated.currentTaskIds.length, 2);

    const third = await client.createTask({
      title: 'queued until a slot opens',
      type: 'shell',
      workerId: 'parallel-worker',
      command: 'node -e "console.log(\'third done\')"',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stillQueued = await client.getTask(third.task.id);
    assert.equal(stillQueued.task.status, 'queued');

    const thirdDone = await waitForTask(client, third.task.id, (task) => task.status === 'succeeded');
    assert.equal(thirdDone.assignedWorkerId, 'parallel-worker');

    await waitForTask(client, first.task.id, (task) => task.status === 'succeeded');
    await waitForTask(client, second.task.id, (task) => task.status === 'succeeded');
    const idle = await waitForWorker(
      client,
      'parallel-worker',
      (item) => item.runningTasks === 0 && item.availableSlots === 2,
    );
    assert.equal(idle.gatewayState, 'idle');

    const { session } = await client.createSession({
      title: 'serialized session',
      workerId: 'parallel-worker',
    });
    const sessionFirst = await client.createTask({
      title: 'session first',
      type: 'shell',
      sessionId: session.id,
      command: 'node -e "setTimeout(() => { require(\'fs\').writeFileSync(\'session.txt\', \'first\'); console.log(\'session first done\') }, 1200)"',
    });
    const sessionSecond = await client.createTask({
      title: 'session second',
      type: 'shell',
      sessionId: session.id,
      command: 'node -e "const fs=require(\'fs\'); const value=fs.readFileSync(\'session.txt\', \'utf8\'); fs.writeFileSync(\'session2.txt\', value+\':second\'); console.log(value)"',
    });

    await waitForTask(client, sessionFirst.task.id, (task) => task.status === 'running');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const queuedSessionTask = await client.getTask(sessionSecond.task.id);
    assert.equal(queuedSessionTask.task.status, 'queued');
    const sessionWorker = await client.getWorker('parallel-worker');
    assert.equal(sessionWorker.worker.availableSlots, 0);

    await waitForTask(client, sessionFirst.task.id, (task) => task.status === 'succeeded');
    const secondDone = await waitForTask(client, sessionSecond.task.id, (task) => task.status === 'succeeded');
    assert.equal(await fs.readFile(path.join(secondDone.workspace, 'session2.txt'), 'utf8'), 'first:second');
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stale worker heartbeat cannot resurrect completed current tasks', async () => {
  const root = await makeTempDir();
  const token = 'stale-heartbeat-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    await client.registerWorker({
      id: 'stale-heartbeat-worker',
      capabilities: ['shell'],
      maxConcurrency: 1,
    });
    const { task } = await client.createTask({
      title: 'stale heartbeat task',
      type: 'shell',
      workerId: 'stale-heartbeat-worker',
      command: 'echo done',
    });
    const claimed = await client.claimTask('stale-heartbeat-worker');
    assert.equal(claimed.task.id, task.id);
    await client.completeTask(task.id, {
      attemptId: claimed.task.currentAttemptId,
      status: 'succeeded',
      exitCode: 0,
      stdout: 'done\n',
      stderr: '',
    });

    await client.heartbeat('stale-heartbeat-worker', {
      observedState: 'running',
      currentTaskId: task.id,
      currentTaskIds: [task.id],
    });

    const { worker } = await client.getWorker('stale-heartbeat-worker');
    assert.equal(worker.gatewayState, 'idle');
    assert.equal(worker.runningTasks, 0);
    assert.deepEqual(worker.currentTaskIds, []);
    assert.equal(worker.currentTaskId, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task slots reserve weighted worker capacity', async () => {
  const root = await makeTempDir();
  const token = 'slot-token';
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
      id: 'slot-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['gpu'],
      maxConcurrency: 2,
      pollMs: 50,
    });

    const heavy = await client.createTask({
      title: 'heavy gpu task',
      type: 'shell',
      workerId: 'slot-worker',
      requiredCapabilities: ['gpu'],
      slots: 2,
      command: 'node -e "setTimeout(() => { console.log(\'heavy done\') }, 1200)"',
    });
    const light = await client.createTask({
      title: 'waits for weighted slot',
      type: 'shell',
      workerId: 'slot-worker',
      requiredCapabilities: ['gpu'],
      slots: 1,
      command: 'node -e "console.log(\'light done\')"',
    });

    await waitForTask(client, heavy.task.id, (task) => task.status === 'running');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const queuedLight = await client.getTask(light.task.id);
    assert.equal(queuedLight.task.status, 'queued');
    const saturated = await client.getWorker('slot-worker');
    assert.equal(saturated.worker.runningTasks, 1);
    assert.equal(saturated.worker.runningSlots, 2);
    assert.equal(saturated.worker.availableSlots, 0);

    await waitForTask(client, heavy.task.id, (task) => task.status === 'succeeded');
    const lightDone = await waitForTask(client, light.task.id, (task) => task.status === 'succeeded');
    assert.equal(lightDone.assignedWorkerId, 'slot-worker');
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
