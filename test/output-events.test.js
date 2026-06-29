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
  let worker;

  try {
    worker = await startWorker({
      id: 'event-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
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
