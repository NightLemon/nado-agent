import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-offline-recovery-'));
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

test('gateway can discover and requeue tasks from offline workers', async () => {
  const root = await makeTempDir();
  const token = 'offline-recovery-token';
  const { server, store, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });
  let recoveryWorker;

  try {
    await client.registerWorker({
      id: 'lost-worker',
      capabilities: ['code'],
      maxConcurrency: 1,
      observedState: 'idle',
    });
    recoveryWorker = await startWorker({
      id: 'recovery-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
    });

    const created = await client.createTask({
      title: 'recover me from lost worker',
      type: 'shell',
      workerId: 'lost-worker',
      command: 'node -e "require(\'fs\').writeFileSync(\'recovered.txt\', process.env.NADO_WORKER_ID); console.log(process.env.NADO_WORKER_ID)"',
    });
    const claimed = await client.claimTask('lost-worker');
    assert.equal(claimed.task.id, created.task.id);
    assert.equal(claimed.task.status, 'running');

    store.state.workers['lost-worker'].lastSeenAt = new Date(Date.now() - 90_000).toISOString();
    await store.save();

    const listed = await client.listOfflineRunningTasks();
    assert.equal(listed.candidates.length, 1);
    assert.equal(listed.candidates[0].task.id, created.task.id);
    assert.equal(listed.candidates[0].worker.gatewayState, 'offline');

    const recovered = await client.recoverOfflineTasks({
      action: 'requeue',
      targetWorkerId: 'recovery-worker',
      reason: 'test offline recovery',
    });
    assert.equal(recovered.recovered.length, 1);
    assert.equal(recovered.skipped.length, 0);
    assert.ok(['queued', 'running', 'succeeded'].includes(recovered.recovered[0].status));
    assert.equal(recovered.recovered[0].requestedWorkerId, 'recovery-worker');

    const done = await waitForTask(client, created.task.id, (task) => task.status === 'succeeded');
    assert.equal(done.assignedWorkerId, 'recovery-worker');
    assert.match(done.stdout, /recovery-worker/);
    assert.equal(await fs.readFile(path.join(done.workspace, 'recovered.txt'), 'utf8'), 'recovery-worker');

    const lost = await client.getWorker('lost-worker');
    assert.equal(lost.worker.gatewayState, 'offline');
    assert.equal(lost.worker.currentTaskIds.length, 0);
  } finally {
    recoveryWorker?.stop();
    if (recoveryWorker) {
      await Promise.allSettled([recoveryWorker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('offline recovery ignores stale results from superseded task attempts', async () => {
  const root = await makeTempDir();
  const token = 'offline-stale-token';
  const { server, store, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    await client.registerWorker({
      id: 'lost-worker',
      capabilities: ['code'],
      maxConcurrency: 1,
      observedState: 'idle',
    });
    await client.registerWorker({
      id: 'recovery-worker',
      capabilities: ['code'],
      maxConcurrency: 1,
      observedState: 'idle',
    });

    const created = await client.createTask({
      title: 'recover with stale result guard',
      type: 'shell',
      workerId: 'lost-worker',
      command: 'echo stale guard',
    });
    const lostClaim = await client.claimTask('lost-worker');
    const lostAttemptId = lostClaim.task.currentAttemptId;
    assert.match(lostAttemptId, /^attempt_/);

    store.state.workers['lost-worker'].lastSeenAt = new Date(Date.now() - 90_000).toISOString();
    await store.save();

    const recovered = await client.recoverOfflineTasks({
      action: 'requeue',
      targetWorkerId: 'recovery-worker',
      reason: 'test stale attempt guard',
    });
    assert.equal(recovered.recovered.length, 1);
    assert.equal(recovered.recovered[0].currentAttemptId, null);

    const recoveryClaim = await client.claimTask('recovery-worker');
    const recoveryAttemptId = recoveryClaim.task.currentAttemptId;
    assert.match(recoveryAttemptId, /^attempt_/);
    assert.notEqual(recoveryAttemptId, lostAttemptId);

    const staleEvent = await client.addTaskEvent(created.task.id, {
      type: 'stdout',
      message: 'old worker output should not be stored',
      workerId: 'lost-worker',
      attemptId: lostAttemptId,
    });
    assert.equal(staleEvent.event.ignored, true);

    const afterStaleResult = await client.completeTask(created.task.id, {
      status: 'succeeded',
      exitCode: 0,
      stdout: 'old-worker',
      stderr: '',
      attemptId: lostAttemptId,
      artifacts: [
        {
          path: 'stale.txt',
          contentBase64: Buffer.from('stale').toString('base64'),
          size: 5,
        },
      ],
    });
    assert.equal(afterStaleResult.task.status, 'running');
    assert.equal(afterStaleResult.task.assignedWorkerId, 'recovery-worker');
    assert.equal(afterStaleResult.task.stdout, '');
    assert.equal(afterStaleResult.task.artifacts.length, 0);
    assert.ok(afterStaleResult.task.events.some((event) => event.type === 'stale_result_ignored'));
    assert.equal(afterStaleResult.task.events.some((event) => event.message === 'old worker output should not be stored'), false);

    const final = await client.completeTask(created.task.id, {
      status: 'succeeded',
      exitCode: 0,
      stdout: 'recovery-worker',
      stderr: '',
      attemptId: recoveryAttemptId,
      artifacts: [
        {
          path: 'fresh.txt',
          contentBase64: Buffer.from('fresh').toString('base64'),
          size: 5,
        },
      ],
    });
    assert.equal(final.task.status, 'succeeded');
    assert.equal(final.task.stdout, 'recovery-worker');
    assert.equal(final.task.assignedWorkerId, 'recovery-worker');
    assert.equal(final.task.currentAttemptId, null);
    assert.ok(final.task.artifacts.some((artifact) => artifact.path === 'fresh.txt'));
    assert.equal(final.task.artifacts.some((artifact) => artifact.path === 'stale.txt'), false);

    const lost = await client.getWorker('lost-worker');
    assert.equal(lost.worker.gatewayState, 'offline');
    assert.equal(lost.worker.currentTaskIds.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
