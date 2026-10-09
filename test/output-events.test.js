import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-events-'));
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

async function collectUntilDone(stream, timeoutMs = 10_000) {
  const timeout = new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('Timed out waiting for event stream')), timeoutMs);
  });
  const collect = (async () => {
    const rows = [];
    for await (const item of stream) {
      rows.push(item);
      if (item.event === 'done') {
        break;
      }
    }
    return rows;
  })();
  return Promise.race([collect, timeout]);
}

test('workers stream stdout and stderr events while a task is still running', async () => {
  const root = await makeTempDir();
  const token = 'events-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });
  const workerClient = new NadoClient({ controlUrl, token });
  const addTaskEvent = workerClient.addTaskEvent.bind(workerClient);
  const retriedStdoutEventIds = [];
  let lostStdoutResponse = false;
  workerClient.addTaskEvent = async (taskId, event) => {
    const result = await addTaskEvent(taskId, event);
    if (event.type === 'stdout' && event.message.includes('phase-one')) {
      retriedStdoutEventIds.push(event.id);
      if (!lostStdoutResponse) {
        lostStdoutResponse = true;
        const error = new Error('simulated lost task-event response');
        error.status = 503;
        throw error;
      }
    }
    return result;
  };
  let worker;

  try {
    worker = await startWorker({
      id: 'event-worker',
      controlUrl,
      token,
      client: workerClient,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
      taskEventRetries: 2,
      taskEventRetryBaseMs: 1,
      taskEventRetryMaxMs: 1,
      reconnectJitterRatio: 0,
    });

    const created = await client.createTask({
      title: 'stream output',
      type: 'shell',
      workerId: 'event-worker',
      command: 'node -e "console.log(\'phase-one\'); setTimeout(()=>console.error(\'phase-two\'), 250); setTimeout(()=>{}, 900)"',
    });

    const withStdout = await waitForTask(
      client,
      created.task.id,
      (task) => task.status === 'running' && task.events.some((event) => event.type === 'stdout' && event.message.includes('phase-one')),
    );
    assert.equal(withStdout.status, 'running');
    const phaseOneEvents = withStdout.events.filter((event) => (
      event.type === 'stdout' && event.message.includes('phase-one')
    ));
    assert.equal(phaseOneEvents.length, 1);
    assert.match(phaseOneEvents[0].id, /^tev_[a-f0-9]{32}$/);

    const withStderr = await waitForTask(
      client,
      created.task.id,
      (task) => task.events.some((event) => event.type === 'stderr' && event.message.includes('phase-two')),
    );
    assert.ok(withStderr.events.some((event) => event.type === 'stderr'));

    const listedEvents = await client.listTaskEvents(created.task.id, { tail: 2 });
    assert.equal(listedEvents.taskId, created.task.id);
    assert.equal(listedEvents.events.length <= 2, true);
    assert.ok(listedEvents.events.some((event) => event.type === 'stdout' || event.type === 'stderr'));

    const done = await waitForTask(client, created.task.id, (task) => task.status === 'succeeded');
    assert.match(done.stdout, /phase-one/);
    assert.match(done.stderr, /phase-two/);
    assert.deepEqual(retriedStdoutEventIds, [phaseOneEvents[0].id, phaseOneEvents[0].id]);
    const orderedOutput = done.events.filter((event) => event.type === 'stdout' || event.type === 'stderr');
    assert.deepEqual(orderedOutput.map((event) => event.data.sequence), [2, 3]);
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task event SSE stream emits live output until terminal status', async () => {
  const root = await makeTempDir();
  const token = 'events-sse-token';
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
    const created = await client.createTask({
      title: 'sse task stream',
      type: 'shell',
      workerId: 'event-sse-worker',
      command: 'node -e "console.log(\'sse-one\'); setTimeout(()=>console.error(\'sse-two\'), 150)"',
    });

    const streamDone = collectUntilDone(client.streamTaskEvents(created.task.id));

    worker = await startWorker({
      id: 'event-sse-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
    });

    const rows = await streamDone;
    assert.ok(rows.some((row) => row.event === 'event' && row.data.type === 'stdout' && row.data.message.includes('sse-one')));
    assert.ok(rows.some((row) => row.event === 'event' && row.data.type === 'stderr' && row.data.message.includes('sse-two')));
    assert.ok(rows.some((row) => row.event === 'done' && row.data.status === 'succeeded'));
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('graceful Worker stop waits for child release evidence before completing', async () => {
  const root = await makeTempDir();
  const token = 'events-graceful-stop-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });
  const workerClient = new NadoClient({ controlUrl, token });
  const addWorkerEvent = workerClient.addWorkerEvent.bind(workerClient);
  let observeRelease;
  const releaseObserved = new Promise((resolve) => {
    observeRelease = resolve;
  });
  let allowRelease;
  const releaseAllowed = new Promise((resolve) => {
    allowRelease = resolve;
  });
  workerClient.addWorkerEvent = async (workerId, event) => {
    if (event.type === 'task_released') {
      observeRelease(event);
      await releaseAllowed;
    }
    return addWorkerEvent(workerId, event);
  };
  let worker;

  try {
    worker = await startWorker({
      id: 'graceful-stop-worker',
      controlUrl,
      token,
      client: workerClient,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 25,
      longPollMs: 0,
      workerEventRetries: 1,
    });
    const created = await client.createTask({
      title: 'graceful stop release boundary',
      type: 'shell',
      workerId: 'graceful-stop-worker',
      command: 'node -e "console.log(\'stop-ready\'); setInterval(() => {}, 1000)"',
    });
    await waitForTask(client, created.task.id, (task) => (
      task.status === 'running'
      && task.events.some((event) => event.type === 'stdout' && event.message.includes('stop-ready'))
    ));

    worker.stop();
    const releaseEvent = await releaseObserved;
    let stopped = false;
    void worker.done.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stopped, false);
    allowRelease();
    await worker.done;
    assert.equal(stopped, true);
    assert.equal(releaseEvent.data.taskId, created.task.id);

    const finalTask = await waitForTask(client, created.task.id, (task) => task.status === 'cancelled');
    assert.ok(finalTask.events.some((event) => (
      event.type === 'worker_process_released'
      && event.attemptId === releaseEvent.data.attemptId
    )));
  } finally {
    allowRelease?.();
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
