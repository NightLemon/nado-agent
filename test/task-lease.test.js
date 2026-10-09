import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStore } from '../src/store.js';

async function makeStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-task-lease-'));
  const store = new JsonStore(JsonStore.defaultPath(root));
  await store.load();
  store.configureReliability({ taskLeaseMs: 5_000 });
  return { root, store };
}

test('HTTP claim snapshots keep attempt identity when cancellation races persistence', async () => {
  const { root, store } = await makeStore();
  let releaseSave;
  try {
    await store.upsertWorker({ id: 'claim-race-worker', capabilities: ['code'] });
    const task = await store.createTask({
      command: 'echo claim-race',
      workerId: 'claim-race-worker',
    });
    const originalSave = store.save.bind(store);
    let saveEntered;
    const entered = new Promise((resolve) => { saveEntered = resolve; });
    const saveGate = new Promise((resolve) => { releaseSave = resolve; });
    store.save = async () => {
      saveEntered();
      await saveGate;
      return originalSave();
    };

    const claimPromise = store.claimTask('claim-race-worker', { snapshotResult: true });
    await entered;
    const cancelPromise = store.manageTask(task.id, 'cancel', {
      reason: 'race claim response with cancellation',
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseSave();

    const claimed = await claimPromise;
    await cancelPromise;
    assert.equal(claimed.status, 'running');
    assert.match(claimed.currentAttemptId, /^attempt_/);
    assert.equal(claimed.lease.attemptId, claimed.currentAttemptId);
    assert.equal(claimed.attempts.at(-1).id, claimed.currentAttemptId);
    assert.equal(store.getTask(task.id).status, 'cancelled');
    assert.equal(store.getTask(task.id).currentAttemptId, null);
  } finally {
    releaseSave?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('heartbeats renew only a live lease for the current task attempt', async () => {
  const { root, store } = await makeStore();
  try {
    await store.upsertWorker({ id: 'lease-worker', capabilities: ['code'] });
    const task = await store.createTask({ command: 'echo lease', workerId: 'lease-worker' });
    const claimed = await store.claimTask('lease-worker');
    const firstExpiry = claimed.lease.expiresAt;
    assert.equal(store.taskRuntimeDiagnostics(claimed).state, 'running_healthy');
    const originalLease = claimed.lease;
    claimed.lease = null;
    assert.equal(store.taskRuntimeDiagnostics(claimed).state, 'lease_missing');
    claimed.lease = originalLease;

    store.state.workers['lease-worker'].lastSeenAt = new Date(Date.now() - 60_000).toISOString();
    const staleHeartbeat = store.taskRuntimeDiagnostics(claimed);
    assert.equal(staleHeartbeat.state, 'worker_heartbeat_stale');
    assert.equal(staleHeartbeat.nextAction.code, 'restore_worker_before_lease_expiry');

    claimed.lease.expiresAt = new Date(Date.now() + 100).toISOString();
    await store.heartbeat('lease-worker', {
      observedState: 'running',
      currentTaskIds: [task.id],
      taskLeases: [{ taskId: task.id, attemptId: claimed.currentAttemptId }],
    });
    assert.ok(Date.parse(claimed.lease.expiresAt) > Date.parse(firstExpiry) - 5_000);
    assert.equal(claimed.lease.attemptId, claimed.currentAttemptId);
    assert.equal(store.taskRuntimeDiagnostics(claimed).state, 'running_healthy');

    claimed.lease.expiresAt = new Date(Date.now() - 1).toISOString();
    const heartbeat = await store.heartbeat('lease-worker', {
      observedState: 'running',
      currentTaskIds: [task.id],
      taskLeases: [{ taskId: task.id, attemptId: claimed.currentAttemptId }],
    });
    assert.deepEqual(heartbeat.worker.currentTaskIds, []);
    assert.ok(Date.parse(claimed.lease.expiresAt) <= Date.now());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('expired leases are requeued with a new attempt and reject stale output', async () => {
  const { root, store } = await makeStore();
  try {
    await store.upsertWorker({ id: 'old-worker', capabilities: ['code'] });
    await store.upsertWorker({ id: 'new-worker', capabilities: ['code'] });
    const task = await store.createTask({
      command: 'echo recover',
      workerId: 'old-worker',
      maxAttempts: 2,
      retryBackoffMs: 0,
    });
    const oldClaim = await store.claimTask('old-worker');
    const oldAttemptId = oldClaim.currentAttemptId;
    oldClaim.lease.expiresAt = new Date(Date.now() - 1).toISOString();
    const expiredDiagnostics = store.taskRuntimeDiagnostics(oldClaim);
    assert.equal(expiredDiagnostics.state, 'lease_expired');
    assert.equal(expiredDiagnostics.needsAttention, true);
    assert.equal(expiredDiagnostics.nextAction.code, 'recover_expired_task');

    const expiredEvent = await store.addTaskEvent(task.id, {
      type: 'stdout',
      message: 'too late',
      attemptId: oldAttemptId,
      workerId: 'old-worker',
    });
    assert.equal(expiredEvent.type, 'expired_lease_event_ignored');
    assert.equal(expiredEvent.ignored, true);

    const recovered = await store.recoverOfflineTasks({
      action: 'requeue',
      includeExpiredLeases: true,
      minOfflineMs: 600_000,
      targetWorkerId: 'new-worker',
    });
    assert.equal(recovered.recovered.length, 1);
    assert.equal(recovered.recovered[0].lease, null);
    assert.equal(recovered.recovered[0].attempts[0].status, 'lease_expired');

    const newClaim = await store.claimTask('new-worker');
    assert.notEqual(newClaim.currentAttemptId, oldAttemptId);
    const stale = await store.completeTask(task.id, {
      status: 'succeeded',
      exitCode: 0,
      attemptId: oldAttemptId,
    });
    assert.equal(stale.status, 'running');
    assert.equal(stale.assignedWorkerId, 'new-worker');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('lease recovery stops after maxAttempts and idempotency keys deduplicate submission', async () => {
  const { root, store } = await makeStore();
  try {
    await store.upsertWorker({ id: 'only-worker', capabilities: ['code'] });
    const first = await store.createTask({
      command: 'echo once',
      workerId: 'only-worker',
      maxAttempts: 1,
      idempotencyKey: 'request-123',
    });
    const duplicate = await store.createTask({
      command: 'echo duplicate must not run',
      workerId: 'only-worker',
      idempotencyKey: 'request-123',
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(store.listTasks().length, 1);

    const claimed = await store.claimTask('only-worker');
    claimed.lease.expiresAt = new Date(Date.now() - 1).toISOString();
    const result = await store.recoverOfflineTasks({
      action: 'requeue',
      includeExpiredLeases: true,
      minOfflineMs: 600_000,
    });
    assert.equal(result.recovered.length, 0);
    assert.equal(result.exhausted.length, 1);
    assert.equal(result.exhausted[0].status, 'failed');
    assert.match(result.exhausted[0].error, /Maximum attempts exhausted/);
    assert.equal(result.exhausted[0].attempts[0].status, 'lease_expired');

    const delayed = await store.createTask({
      command: 'echo delayed',
      workerId: 'only-worker',
    });
    delayed.notBeforeAt = new Date(Date.now() + 30_000).toISOString();
    const delayedDiagnostics = store.taskRuntimeDiagnostics(delayed);
    assert.equal(delayedDiagnostics.state, 'retry_backoff');
    assert.equal(delayedDiagnostics.nextAction.code, 'wait_for_retry_backoff');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('automatic session recovery preserves workspace affinity and returns only to the original worker', async () => {
  const { root, store } = await makeStore();
  try {
    await store.upsertWorker({ id: 'session-worker', capabilities: ['code'] });
    await store.upsertWorker({ id: 'other-worker', capabilities: ['code'] });
    const session = await store.createSession({
      title: 'recoverable agent session',
      workerId: 'session-worker',
      requiredCapabilities: ['code'],
    });
    const task = await store.createTask({
      title: 'resume session task on its workspace owner',
      command: 'echo session-recovery',
      sessionId: session.id,
      maxAttempts: 2,
      retryBackoffMs: 0,
    });
    const firstClaim = await store.claimTask('session-worker');
    const firstAttemptId = firstClaim.currentAttemptId;
    const sessionState = store.getSession(session.id);
    sessionState.workspace = '/worker-local/sessions/recoverable-agent-session';
    firstClaim.lease.expiresAt = new Date(Date.now() - 1).toISOString();

    const result = await store.recoverOfflineTasks({
      action: 'requeue',
      includeExpiredLeases: true,
      minOfflineMs: 600_000,
      sessionRecovery: 'same-worker',
      reason: 'automatic same-worker session recovery test',
    });

    assert.equal(result.recovered.length, 1);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.recovered[0].status, 'queued');
    assert.equal(result.recovered[0].requestedWorkerId, 'session-worker');
    assert.equal(result.recovered[0].assignedWorkerId, null);
    assert.equal(result.recovered[0].attempts[0].status, 'lease_expired');
    assert.equal(sessionState.assignedWorkerId, 'session-worker');
    assert.equal(sessionState.requestedWorkerId, 'session-worker');
    assert.equal(sessionState.workspace, '/worker-local/sessions/recoverable-agent-session');
    assert.equal(sessionState.currentTaskId, null);
    assert.equal(
      result.recovered[0].events.at(-1).data.sessionWorkspacePreserved,
      true,
    );
    assert.equal(result.recovered[0].events.at(-1).attemptId, firstAttemptId);
    assert.equal(result.recovered[0].events.at(-1).data.previousAttemptId, firstAttemptId);
    assert.equal(store.taskRuntimeDiagnostics(result.recovered[0]).state, 'awaiting_session_claim');

    assert.equal(await store.claimTask('other-worker'), null);
    const recoveredClaim = await store.claimTask('session-worker');
    assert.equal(recoveredClaim.id, task.id);
    assert.notEqual(recoveredClaim.currentAttemptId, firstAttemptId);

    const stale = await store.completeTask(task.id, {
      status: 'succeeded',
      exitCode: 0,
      attemptId: firstAttemptId,
    });
    assert.equal(stale.status, 'running');
    assert.equal(stale.assignedWorkerId, 'session-worker');
    assert.equal(stale.currentAttemptId, recoveredClaim.currentAttemptId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
