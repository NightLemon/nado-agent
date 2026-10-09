import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  normalizeRetryPolicy,
  retryPolicyMatch,
} from '../src/retry-policy.js';
import { JsonStore } from '../src/store.js';
import { runTask } from '../src/task-runner.js';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

async function makeStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-retry-policy-'));
  const store = new JsonStore(JsonStore.defaultPath(root));
  await store.load();
  return { root, store };
}

test('retry policy normalization is explicit and rejects unsafe classes', () => {
  assert.deepEqual(normalizeRetryPolicy({
    failureKinds: ['timeout', 'worker_error', 'timeout'],
    exitCodes: [75, '124', 75],
  }, { strict: true }), {
    failureKinds: ['timeout', 'worker_error'],
    exitCodes: [75, 124],
  });
  assert.equal(retryPolicyMatch({ exitCodes: [75] }, {
    failureKind: 'nonzero_exit',
    exitCode: 75,
  }).matched, true);
  assert.equal(retryPolicyMatch({ exitCodes: [1] }, {
    failureKind: 'configuration_error',
    exitCode: 1,
  }).matched, false);
  assert.throws(
    () => normalizeRetryPolicy({ failureKinds: ['configuration_error'] }, { strict: true }),
    /Unsupported retry failure kind/,
  );
  assert.throws(
    () => normalizeRetryPolicy({ exitCodes: [0] }, { strict: true }),
    /positive integer/,
  );
});

test('a matching process failure is requeued with backoff metadata and a new attempt', async () => {
  const { root, store } = await makeStore();
  try {
    await store.upsertWorker({ id: 'retry-worker', capabilities: ['code'] });
    const created = await store.createTask({
      title: 'transient exit',
      command: 'exit 75',
      workerId: 'retry-worker',
      maxAttempts: 2,
      retryBackoffMs: 0,
      retryPolicy: { exitCodes: [75] },
    });
    const first = await store.claimTask('retry-worker');
    const firstAttemptId = first.currentAttemptId;
    const requeued = await store.completeTask(created.id, {
      attemptId: firstAttemptId,
      status: 'failed',
      exitCode: 75,
      failureKind: 'nonzero_exit',
      stderr: 'temporary failure',
    });

    assert.equal(requeued.status, 'queued');
    assert.equal(requeued.currentAttemptId, null);
    assert.equal(requeued.assignedWorkerId, null);
    assert.equal(requeued.requestedWorkerId, 'retry-worker');
    assert.equal(requeued.attempts[0].status, 'retryable_failure');
    assert.equal(requeued.attempts[0].exitCode, 75);
    assert.equal(requeued.attempts[0].failureKind, 'nonzero_exit');
    assert.ok(requeued.events.some((event) => event.type === 'retry_scheduled'));
    assert.ok(store.getWorker('retry-worker').events.some((event) => event.type === 'task_retry_scheduled'));

    const second = await store.claimTask('retry-worker');
    assert.notEqual(second.currentAttemptId, firstAttemptId);
    const succeeded = await store.completeTask(created.id, {
      attemptId: second.currentAttemptId,
      status: 'succeeded',
      exitCode: 0,
      stdout: 'recovered',
    });
    assert.equal(succeeded.status, 'succeeded');
    assert.equal(succeeded.attemptSeq, 2);
    assert.equal(succeeded.failureKind, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retry exhaustion is terminal and non-matching failures are not repeated', async () => {
  const { root, store } = await makeStore();
  try {
    await store.upsertWorker({ id: 'policy-worker', capabilities: ['code'] });
    const exhaustedTask = await store.createTask({
      command: 'timeout',
      workerId: 'policy-worker',
      maxAttempts: 1,
      retryPolicy: { failureKinds: ['timeout'] },
    });
    const exhaustedClaim = await store.claimTask('policy-worker');
    const exhausted = await store.completeTask(exhaustedTask.id, {
      attemptId: exhaustedClaim.currentAttemptId,
      status: 'failed',
      exitCode: 124,
      failureKind: 'timeout',
    });
    assert.equal(exhausted.status, 'failed');
    assert.equal(exhausted.failureKind, 'timeout');
    assert.ok(exhausted.events.some((event) => event.type === 'retry_exhausted'));

    const nonMatchingTask = await store.createTask({
      command: 'exit 2',
      workerId: 'policy-worker',
      maxAttempts: 3,
      retryPolicy: { exitCodes: [75] },
    });
    const nonMatchingClaim = await store.claimTask('policy-worker');
    const nonMatching = await store.completeTask(nonMatchingTask.id, {
      attemptId: nonMatchingClaim.currentAttemptId,
      status: 'failed',
      exitCode: 2,
      failureKind: 'nonzero_exit',
    });
    assert.equal(nonMatching.status, 'failed');
    assert.equal(nonMatching.attemptSeq, 1);
    assert.equal(nonMatching.events.some((event) => event.type === 'retry_scheduled'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task runner classifies non-zero command exits for retry policy matching', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-retry-runner-'));
  try {
    const result = await runTask({
      id: 'retry-runner-task',
      title: 'classified failure',
      type: 'shell',
      command: 'node -e "process.exit(75)"',
    }, {
      dataDir: root,
      workerId: 'runner-worker',
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
      cleanupWorkspaces: false,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 75);
    assert.equal(result.failureKind, 'nonzero_exit');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('live gateway and Worker retry an opted-in transient exit and then succeed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-retry-live-'));
  const token = 'retry-live-token';
  const running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  const client = new NadoClient({ controlUrl, token });
  let worker;
  try {
    worker = await startWorker({
      id: 'retry-live-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 25,
      longPollMs: 0,
    });
    const command = 'node -e "const fs=require(\'fs\');if(!fs.existsSync(\'attempt.txt\')){fs.writeFileSync(\'attempt.txt\',\'1\');process.exit(75)}console.log(\'recovered on second attempt\')"';
    const cli = await execFileAsync(process.execPath, [
      cliPath,
      'submit',
      '--control', controlUrl,
      '--worker', 'retry-live-worker',
      '--title', 'live transient retry',
      '--command', command,
      '--max-attempts', '2',
      '--retry-exit-code', '75',
      '--retry-backoff-ms', '0',
      '--wait',
      '--wait-timeout', '10000',
    ], {
      env: { ...process.env, NADO_TOKEN: token },
      timeout: 15_000,
    });
    assert.match(cli.stdout, /retryPolicy=.*75/);
    assert.match(cli.stdout, /waitStatus=succeeded/);
    const taskId = cli.stdout.match(/submitted (task_[^\s]+)/)?.[1];
    assert.ok(taskId);
    const { task } = await client.getTask(taskId);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.attemptSeq, 2);
    assert.equal(task.attempts[0].status, 'retryable_failure');
    assert.equal(task.attempts[0].exitCode, 75);
    assert.match(task.stdout, /recovered on second attempt/);
    assert.ok(task.events.some((event) => event.type === 'retry_scheduled'));
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => running.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
