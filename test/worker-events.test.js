import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-worker-events-'));
}

async function waitForTask(client, taskId, predicate, timeoutMs = 8_000) {
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
  assert.fail(`Timed out waiting for task ${taskId}; last status ${lastTask?.status}`);
}

async function waitForWorkerEvent(client, workerId, predicate, timeoutMs = 8_000) {
  const started = Date.now();
  let lastEvents = [];
  while (Date.now() - started < timeoutMs) {
    const listed = await client.listWorkerEvents(workerId, { tail: 100 });
    lastEvents = listed.events || [];
    if (lastEvents.some(predicate)) {
      return listed;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for worker event; last events=${JSON.stringify(lastEvents)}`);
}

async function runCli(args, env) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    timeout: 8_000,
  });
  return stdout;
}

test('worker runtime events are durable and visible from HTTP client and CLI', async () => {
  const root = await makeTempDir();
  const token = 'worker-events-token';
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

    await waitForWorkerEvent(
      client,
      'event-worker',
      (event) => event.type === 'registered' && event.message.includes('event-worker'),
    );

    const created = await client.createTask({
      title: 'worker event task',
      type: 'shell',
      workerId: 'event-worker',
      command: 'node -e "console.log(\'worker-event-ok\')"',
    });
    const done = await waitForTask(client, created.task.id, (task) => task.status === 'succeeded');
    assert.equal(done.assignedWorkerId, 'event-worker');

    const listed = await waitForWorkerEvent(
      client,
      'event-worker',
      (event) => event.type === 'task_completed' && event.data?.taskId === created.task.id,
    );
    assert.equal(listed.worker.id, 'event-worker');
    assert.ok(listed.events.some((event) => event.type === 'task_claimed' && event.data?.taskId === created.task.id));
    assert.ok(listed.events.some((event) => event.type === 'task_completed' && event.level === 'info'));

    const snapshot = await client.status();
    const statusWorker = snapshot.workers.items.find((item) => item.id === 'event-worker');
    assert.ok(statusWorker);
    assert.equal(statusWorker.events, undefined);
    assert.ok(statusWorker.eventCount >= listed.events.length);
    assert.ok(statusWorker.lastEventAt);

    const statusTask = snapshot.tasks.items.find((item) => item.id === created.task.id);
    assert.ok(statusTask);
    assert.equal(statusTask.stdout, undefined);
    assert.equal(statusTask.stderr, undefined);
    assert.equal(statusTask.events, undefined);
    assert.equal(statusTask.artifacts, undefined);
    assert.ok(statusTask.eventCount >= done.events.length);
    assert.equal(statusTask.stdoutBytes, Buffer.byteLength(done.stdout, 'utf8'));
    assert.equal(statusTask.artifactCount, done.artifacts.length);

    const tailed = await client.listWorkerEvents('event-worker', { tail: 1 });
    assert.equal(tailed.events.length, 1);

    const logsOut = await runCli([
      'worker',
      'logs',
      '--control',
      controlUrl,
      '--id',
      'event-worker',
      '--tail',
      '20',
    ], { NADO_TOKEN: token });
    assert.match(logsOut, /event-worker/);
    assert.match(logsOut, /task_completed|completed/);
  } finally {
    if (worker) {
      worker.stop();
      await worker.done;
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
