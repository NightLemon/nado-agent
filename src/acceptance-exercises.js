import crypto from 'node:crypto';
import { sleep } from './utils.js';

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

async function waitFor(client, description, predicate, timeoutMs, intervalMs = 250) {
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt <= timeoutMs) {
    lastValue = await predicate();
    if (lastValue?.done) {
      return lastValue.value;
    }
    await sleep(intervalMs);
  }
  const detail = lastValue?.detail ? `; last=${lastValue.detail}` : '';
  throw new Error(`Timed out waiting for ${description}${detail}`);
}

async function waitForRunningTask(client, taskId, workerId, timeoutMs) {
  return waitFor(client, `task ${taskId} to run on ${workerId}`, async () => {
    const { task } = await client.getTask(taskId);
    if (task.status === 'running' && task.assignedWorkerId === workerId) {
      return { done: true, value: task };
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new Error(`Task ${taskId} became ${task.status} before a running attempt was observed`);
    }
    return {
      done: false,
      detail: `status=${task.status}, assignedWorker=${task.assignedWorkerId || '-'}`,
    };
  }, timeoutMs);
}

async function waitForTerminalTask(client, taskId, workerId, timeoutMs) {
  return waitFor(client, `task ${taskId} to complete on ${workerId}`, async () => {
    const { task } = await client.getTask(taskId);
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      return { done: true, value: task };
    }
    return {
      done: false,
      detail: `status=${task.status}, assignedWorker=${task.assignedWorkerId || '-'}`,
    };
  }, timeoutMs);
}

async function waitForControlRestart(client, originalInstanceId, timeoutMs, onProgress) {
  const startedAt = Date.now();
  const unavailable = [];
  let lastInstanceId = originalInstanceId;
  let restartedHealth = null;
  let reportedUnavailable = false;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const health = await client.health();
      lastInstanceId = health.runtime?.instanceId || null;
      if (lastInstanceId && lastInstanceId !== originalInstanceId) {
        restartedHealth = health;
        if (unavailable.length) {
          return {
            health,
            unavailable,
            observedAt: new Date().toISOString(),
          };
        }
      }
    } catch (error) {
      const observation = {
        at: new Date().toISOString(),
        error: String(error?.message || error).slice(0, 500),
      };
      unavailable.push(observation);
      if (!reportedUnavailable) {
        reportedUnavailable = true;
        onProgress?.({
          phase: 'control_unreachable',
          originalInstanceId,
          observedAt: observation.at,
          message: 'Control URL is unreachable; keep the VM service restart in progress',
        });
      }
    }
    await sleep(250);
  }

  if (restartedHealth && !unavailable.length) {
    throw new Error(
      `Control instance changed from ${originalInstanceId} to ${restartedHealth.runtime?.instanceId}, but no control outage was observed`,
    );
  }
  throw new Error(
    `Timed out waiting for control restart; originalInstance=${originalInstanceId}, lastInstance=${lastInstanceId || '-'}, outageObserved=${unavailable.length > 0}`,
  );
}

async function waitForRestartRecovery(client, taskId, workerId, attemptId, restartedAt, timeoutMs) {
  return waitFor(client, `Worker ${workerId} and task ${taskId} to recover after control restart`, async () => {
    const [{ worker }, { task }, status] = await Promise.all([
      client.getWorker(workerId),
      client.getTask(taskId),
      client.status(),
    ]);
    if (status.storage?.backend !== 'sqlite') {
      throw new Error(`Control store changed after restart: expected sqlite, got ${status.storage?.backend || '-'}`);
    }
    const durableAttempt = task.currentAttemptId
      || (task.attempts || []).find((attempt) => attempt.id === attemptId)?.id
      || null;
    if (durableAttempt !== attemptId) {
      throw new Error(`Task attempt changed after control restart: expected ${attemptId}, got ${durableAttempt || '-'}`);
    }
    if (task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(`VM-restart task became ${task.status}: ${task.error || 'unknown error'}`);
    }
    const workerLastSeenMs = Date.parse(worker.lastSeenAt || '');
    const restartedMs = Date.parse(restartedAt || '');
    const workerContactedRestartedControl = Number.isFinite(workerLastSeenMs)
      && Number.isFinite(restartedMs)
      && workerLastSeenMs >= restartedMs;
    if (
      worker.active
      && worker.adminState === 'enabled'
      && worker.gatewayState !== 'offline'
      && workerContactedRestartedControl
    ) {
      return {
        done: true,
        value: {
          worker,
          task,
          status,
          recoveredAt: new Date().toISOString(),
        },
      };
    }
    return {
      done: false,
      detail: `workerActive=${Boolean(worker.active)}, gatewayState=${worker.gatewayState || '-'}, workerLastSeenAt=${worker.lastSeenAt || '-'}, restartedAt=${restartedAt || '-'}, taskStatus=${task.status}, attempt=${durableAttempt || '-'}`,
    };
  }, timeoutMs);
}

async function waitForPartialArtifactUpload(client, taskId, workerId, attemptId, artifactPath, timeoutMs) {
  return waitFor(client, `partial upload of ${artifactPath} for task ${taskId}`, async () => {
    const [{ task }, { uploads }] = await Promise.all([
      client.getTask(taskId),
      client.listArtifactUploads(taskId),
    ]);
    const upload = (uploads || []).find((item) => item.path === artifactPath);
    if (
      upload
      && (upload.status === 'finalized' || Number(upload.committedBytes || 0) >= Number(upload.size || 0))
    ) {
      throw new Error(
        `Artifact upload completed before it could be interrupted; increase --artifact-bytes or reduce NADO_ARTIFACT_CHUNK_BYTES on Worker ${workerId}`,
      );
    }
    if (
      upload?.status === 'pending'
      && Number(upload.committedBytes) > 0
      && Number(upload.committedBytes) < Number(upload.size)
    ) {
      return { done: true, value: { task, upload, observedAt: new Date().toISOString() } };
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new Error(`Large-artifact task became ${task.status} before a partial upload was visible`);
    }
    if (task.currentAttemptId !== attemptId) {
      throw new Error(`Large-artifact attempt changed before upload: expected ${attemptId}, got ${task.currentAttemptId || '-'}`);
    }
    return {
      done: false,
      detail: `status=${task.status}, uploadStatus=${upload?.status || '-'}, committedBytes=${upload?.committedBytes || 0}`,
    };
  }, timeoutMs);
}

async function waitForArtifactUploadStall(client, taskId, workerId, attemptId, uploadId, initialOffset, minStallMs, timeoutMs) {
  const startedAt = Date.now();
  let committedBytes = Number(initialOffset);
  let stableSince = Date.now();
  let lastDetail = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const [{ task }, { worker }, { uploads }] = await Promise.all([
      client.getTask(taskId),
      client.getWorker(workerId),
      client.listArtifactUploads(taskId),
    ]);
    const upload = (uploads || []).find((item) => item.id === uploadId);
    if (!upload) {
      throw new Error(`Artifact upload ${uploadId} disappeared during the disconnect drill`);
    }
    if (upload.status === 'finalized') {
      throw new Error('Artifact upload finalized before the requested network stall was observed');
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new Error(`Large-artifact task became ${task.status} during the disconnect drill`);
    }
    if (task.currentAttemptId !== attemptId) {
      throw new Error(`Large-artifact attempt changed during upload stall: expected ${attemptId}, got ${task.currentAttemptId || '-'}`);
    }
    const currentOffset = Number(upload.committedBytes || 0);
    if (currentOffset !== committedBytes) {
      committedBytes = currentOffset;
      stableSince = Date.now();
    }
    const stableMs = Date.now() - stableSince;
    const workerAgeMs = Number(worker.ageMs || 0);
    if (committedBytes > 0 && stableMs >= minStallMs && workerAgeMs >= minStallMs) {
      return {
        task,
        worker,
        upload,
        stableMs,
        observedAt: new Date().toISOString(),
      };
    }
    lastDetail = `workerAgeMs=${Math.round(workerAgeMs)}, committedBytes=${committedBytes}, stableMs=${stableMs}`;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for artifact upload and Worker heartbeat to stall; last=${lastDetail || '-'}`);
}

async function waitForArtifactUploadRecovery(client, taskId, workerId, attemptId, uploadId, afterTime, timeoutMs) {
  return waitFor(client, `artifact upload ${uploadId} and Worker ${workerId} to recover`, async () => {
    const [{ task }, { worker }, { uploads }] = await Promise.all([
      client.getTask(taskId),
      client.getWorker(workerId),
      client.listArtifactUploads(taskId),
    ]);
    const upload = (uploads || []).find((item) => item.id === uploadId);
    if (!upload) {
      throw new Error(`Artifact upload ${uploadId} disappeared after reconnect`);
    }
    const durableAttempt = task.currentAttemptId
      || (task.attempts || []).find((attempt) => attempt.id === attemptId)?.id
      || null;
    if (durableAttempt !== attemptId) {
      throw new Error(`Large-artifact attempt changed after reconnect: expected ${attemptId}, got ${durableAttempt || '-'}`);
    }
    if (task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(`Large-artifact task became ${task.status}: ${task.error || 'unknown error'}`);
    }
    const workerLastSeenMs = Date.parse(worker.lastSeenAt || '');
    const afterMs = Date.parse(afterTime || '');
    const reconnected = worker.active
      && Number.isFinite(workerLastSeenMs)
      && Number.isFinite(afterMs)
      && workerLastSeenMs >= afterMs;
    if (upload.status === 'finalized' && reconnected) {
      return {
        done: true,
        value: { task, worker, upload, recoveredAt: new Date().toISOString() },
      };
    }
    return {
      done: false,
      detail: `taskStatus=${task.status}, uploadStatus=${upload.status}, committedBytes=${upload.committedBytes}, workerActive=${Boolean(worker.active)}, workerLastSeenAt=${worker.lastSeenAt || '-'}`,
    };
  }, timeoutMs);
}

function repeatedByteSha256(size, byte) {
  const hash = crypto.createHash('sha256');
  const block = Buffer.alloc(Math.min(1024 * 1024, size), byte);
  let remaining = size;
  while (remaining > 0) {
    hash.update(remaining >= block.length ? block : block.subarray(0, remaining));
    remaining -= Math.min(remaining, block.length);
  }
  return hash.digest('hex');
}

function matchingInputRangeEvents(task, inputId, attemptId) {
  return (task.events || []).filter((event) => (
    event.type === 'input_download_range'
    && event.data?.inputId === inputId
    && event.data?.attemptId === attemptId
  ));
}

async function waitForInitialInputRange(client, taskId, workerId, attemptId, inputId, timeoutMs) {
  return waitFor(client, `Worker ${workerId} to request input ${inputId}`, async () => {
    const { task } = await client.getTask(taskId);
    const event = matchingInputRangeEvents(task, inputId, attemptId)
      .find((item) => Number(item.data?.offset) === 0);
    if (event) {
      return { done: true, value: { task, event } };
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new Error(`Large-input task became ${task.status} before its initial Range request was recorded`);
    }
    if (task.currentAttemptId !== attemptId) {
      throw new Error(`Large-input attempt changed before download: expected ${attemptId}, got ${task.currentAttemptId || '-'}`);
    }
    return { done: false, detail: `status=${task.status}, rangeEvents=${matchingInputRangeEvents(task, inputId, attemptId).length}` };
  }, timeoutMs);
}

async function waitForInputDownloadStall(client, taskId, workerId, attemptId, minStallMs, timeoutMs) {
  return waitFor(client, `Worker ${workerId} input download heartbeat gap`, async () => {
    const [{ task }, { worker }] = await Promise.all([
      client.getTask(taskId),
      client.getWorker(workerId),
    ]);
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new Error(`Large-input task became ${task.status} before a Worker heartbeat gap was observed`);
    }
    if (task.currentAttemptId !== attemptId) {
      throw new Error(`Large-input attempt changed during disconnect: expected ${attemptId}, got ${task.currentAttemptId || '-'}`);
    }
    if (Number(worker.ageMs || 0) >= minStallMs) {
      return {
        done: true,
        value: { task, worker, observedAt: new Date().toISOString() },
      };
    }
    return {
      done: false,
      detail: `taskStatus=${task.status}, workerAgeMs=${Math.round(Number(worker.ageMs || 0))}`,
    };
  }, timeoutMs);
}

async function waitForInputRangeResume(client, taskId, workerId, attemptId, inputId, afterTime, timeoutMs) {
  return waitFor(client, `Worker ${workerId} to resume input ${inputId} from a positive offset`, async () => {
    const [{ task }, { worker }] = await Promise.all([
      client.getTask(taskId),
      client.getWorker(workerId),
    ]);
    const afterMs = Date.parse(afterTime || '');
    const event = [...matchingInputRangeEvents(task, inputId, attemptId)].reverse().find((item) => (
      Number(item.data?.offset || 0) > 0
      && Date.parse(item.at || '') >= afterMs
    ));
    const durableAttempt = task.currentAttemptId
      || (task.attempts || []).find((attempt) => attempt.id === attemptId)?.id
      || null;
    if (durableAttempt !== attemptId) {
      throw new Error(`Large-input attempt changed after reconnect: expected ${attemptId}, got ${durableAttempt || '-'}`);
    }
    if (task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(`Large-input task became ${task.status}: ${task.error || 'unknown error'}`);
    }
    const workerLastSeenMs = Date.parse(worker.lastSeenAt || '');
    const reconnected = worker.active
      && Number.isFinite(afterMs)
      && Number.isFinite(workerLastSeenMs)
      && workerLastSeenMs >= afterMs;
    if (event && reconnected) {
      return {
        done: true,
        value: { task, worker, event, recoveredAt: new Date().toISOString() },
      };
    }
    return {
      done: false,
      detail: `taskStatus=${task.status}, resumeOffset=${event?.data?.offset || 0}, workerActive=${Boolean(worker.active)}, workerLastSeenAt=${worker.lastSeenAt || '-'}`,
    };
  }, timeoutMs);
}

async function waitForRestoredControl(client, taskId, workerId, originalReceiptId, restoredAfter, restartedAt, timeoutMs) {
  return waitFor(client, 'restored control state and home Worker reconnection', async () => {
    const [status, { task }, { worker }] = await Promise.all([
      client.status(),
      client.getTask(taskId),
      client.getWorker(workerId),
    ]);
    if (status.storage?.backend !== 'sqlite') {
      throw new Error(`Restored control must use SQLite; backend=${status.storage?.backend || '-'}`);
    }
    const receipt = status.storage?.restoreReceipt || null;
    const receiptIsNew = Boolean(
      receipt?.id
      && receipt.id !== originalReceiptId
      && Date.parse(receipt.restoredAt || '') >= Date.parse(restoredAfter || ''),
    );
    const workerLastSeenMs = Date.parse(worker.lastSeenAt || '');
    const restartedMs = Date.parse(restartedAt || '');
    const workerReconnected = worker.active
      && worker.adminState === 'enabled'
      && worker.gatewayState !== 'offline'
      && Number.isFinite(workerLastSeenMs)
      && Number.isFinite(restartedMs)
      && workerLastSeenMs >= restartedMs;
    if (receiptIsNew && workerReconnected && task.status === 'succeeded') {
      return {
        done: true,
        value: { status, task, worker, receipt, recoveredAt: new Date().toISOString() },
      };
    }
    return {
      done: false,
      detail: `receipt=${receipt?.id || '-'}, receiptIsNew=${receiptIsNew}, markerTask=${task.status}, workerActive=${Boolean(worker.active)}, workerLastSeenAt=${worker.lastSeenAt || '-'}`,
    };
  }, timeoutMs);
}

async function downloadRequiredArtifact(client, task, artifactPath) {
  const artifact = (task.artifacts || []).find((item) => item.path === artifactPath && !item.skipped);
  if (!artifact) {
    throw new Error(`Task ${task.id} did not return required artifact ${artifactPath}`);
  }
  const downloaded = await client.downloadArtifact(task.id, artifact.id);
  return { artifact, bytes: downloaded.bytes };
}

async function waitForHeartbeatGap(client, taskId, workerId, attemptId, minGapMs, timeoutMs) {
  return waitFor(client, `Worker ${workerId} heartbeat gap of ${minGapMs}ms`, async () => {
    const [{ worker }, { task }] = await Promise.all([
      client.getWorker(workerId),
      client.getTask(taskId),
    ]);
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new Error(`Short-disconnect task became ${task.status} before a heartbeat gap was observed`);
    }
    if (task.currentAttemptId !== attemptId) {
      throw new Error(`Task attempt changed before reconnect: expected ${attemptId}, got ${task.currentAttemptId || '-'}`);
    }
    if (Number(worker.ageMs || 0) >= minGapMs) {
      return { done: true, value: { worker, task, observedAt: new Date().toISOString() } };
    }
    return {
      done: false,
      detail: `workerAgeMs=${Math.round(Number(worker.ageMs || 0))}, taskStatus=${task.status}`,
    };
  }, timeoutMs);
}

async function waitForHeartbeatRecovery(client, taskId, workerId, attemptId, timeoutMs) {
  return waitFor(client, `Worker ${workerId} heartbeat recovery`, async () => {
    const [{ worker }, { task }] = await Promise.all([
      client.getWorker(workerId),
      client.getTask(taskId),
    ]);
    if (task.currentAttemptId !== attemptId) {
      throw new Error(`Task attempt changed during reconnect: expected ${attemptId}, got ${task.currentAttemptId || '-'}`);
    }
    const renewedAt = Date.parse(task.lease?.renewedAt || '');
    const lastSeenAt = Date.parse(worker.lastSeenAt || '');
    if (worker.active && Number.isFinite(lastSeenAt) && Number.isFinite(renewedAt) && Number(worker.ageMs || 0) < 3_000) {
      return { done: true, value: { worker, task, recoveredAt: new Date().toISOString() } };
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new Error(`Short-disconnect task became ${task.status} before heartbeat recovery was confirmed`);
    }
    return {
      done: false,
      detail: `workerAgeMs=${Math.round(Number(worker.ageMs || 0))}, active=${Boolean(worker.active)}, taskStatus=${task.status}`,
    };
  }, timeoutMs);
}

async function waitForTaskOutput(client, taskId, attemptId, marker, timeoutMs) {
  return waitFor(client, `task ${taskId} output marker ${marker}`, async () => {
    const { task } = await client.getTask(taskId);
    const event = (task.events || []).find((item) => item.type === 'stdout' && item.message?.includes(marker));
    if (event) {
      return { done: true, value: { task, event } };
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new Error(`Task became ${task.status} before emitting ${marker}`);
    }
    if (task.currentAttemptId !== attemptId) {
      throw new Error(`Task attempt changed before ${marker}: expected ${attemptId}, got ${task.currentAttemptId || '-'}`);
    }
    return { done: false, detail: `status=${task.status}, attempt=${task.currentAttemptId || '-'}` };
  }, timeoutMs);
}

async function waitForLeaseRecovery(client, taskId, firstAttemptId, timeoutMs) {
  return waitFor(client, `task ${taskId} lease recovery`, async () => {
    const { task } = await client.getTask(taskId);
    const recoveryEvent = [...(task.events || [])].reverse().find((event) => (
      event.type === 'lease_recovered'
      && event.data?.previousWorkerId
    ));
    const firstAttempt = (task.attempts || []).find((attempt) => attempt.id === firstAttemptId);
    if (recoveryEvent && firstAttempt?.status === 'lease_expired') {
      return { done: true, value: { task, recoveryEvent, firstAttempt, recoveredAt: recoveryEvent.at } };
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new Error(`Task became ${task.status} before its expired lease was recovered`);
    }
    return {
      done: false,
      detail: `status=${task.status}, firstAttemptStatus=${firstAttempt?.status || '-'}, leaseRecovered=${Boolean(recoveryEvent)}`,
    };
  }, timeoutMs);
}

async function waitForLongDisconnectOutcome(client, taskId, originalWorkerId, firstAttemptId, timeoutMs) {
  const rejectionTypes = new Set([
    'expired_lease_result_ignored',
    'stale_result_ignored',
    'late_result_ignored',
  ]);
  return waitFor(client, `task ${taskId} stale-result rejection and second-attempt completion`, async () => {
    const [{ task }, { worker }] = await Promise.all([
      client.getTask(taskId),
      client.getWorker(originalWorkerId),
    ]);
    const rejectionEvent = [...(task.events || [])].reverse().find((event) => (
      rejectionTypes.has(event.type)
      && event.data?.resultAttemptId === firstAttemptId
    ));
    if (task.status === 'succeeded' && rejectionEvent && worker.active) {
      return { done: true, value: { task, worker, rejectionEvent } };
    }
    if (task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(`Long-disconnect task ended ${task.status}: ${task.error || 'unknown error'}`);
    }
    return {
      done: false,
      detail: `status=${task.status}, attempts=${task.attempts?.length || 0}, staleRejected=${Boolean(rejectionEvent)}, originalWorkerActive=${Boolean(worker.active)}`,
    };
  }, timeoutMs);
}

async function waitForWorkerCancellation(client, workerId, taskId, timeoutMs) {
  return waitFor(client, `Worker ${workerId} to confirm cancellation of ${taskId}`, async () => {
    const [{ worker }, eventResult] = await Promise.all([
      client.getWorker(workerId),
      client.listWorkerEvents(workerId, { tail: 100 }),
    ]);
    const events = eventResult.events || [];
    const commandEvent = [...events].reverse().find((event) => (
      event.type === 'command_applied'
      && event.data?.action === 'cancel_current'
      && event.data?.taskId === taskId
    ));
    const releasedEvent = [...events].reverse().find((event) => (
      event.type === 'task_released'
      && event.data?.taskId === taskId
    ));
    // Worker event ingestion copies the corroborating task event before the POST
    // response is committed. Read the task only after observing Worker evidence so
    // one polling iteration cannot combine a newer Worker snapshot with an older
    // task snapshot at the timeout boundary.
    const { task } = await client.getTask(taskId);
    const durableCommandEvent = (task.events || []).find((event) => (
      event.type === 'worker_cancel_applied'
      && event.workerId === workerId
    ));
    const durableReleasedEvent = (task.events || []).find((event) => (
      event.type === 'worker_process_released'
      && event.workerId === workerId
      && event.attemptId === releasedEvent?.data?.attemptId
    ));
    const currentTaskIds = worker.currentTaskIds || (worker.currentTaskId ? [worker.currentTaskId] : []);
    if (commandEvent && releasedEvent && durableCommandEvent && durableReleasedEvent) {
      return {
        done: true,
        value: {
          worker,
          commandEvent,
          releasedEvent,
          durableCommandEvent,
          durableReleasedEvent,
        },
      };
    }
    return {
      done: false,
      detail: `commandConfirmed=${Boolean(commandEvent)}, processReleased=${Boolean(releasedEvent)}, durableCommand=${Boolean(durableCommandEvent)}, durableRelease=${Boolean(durableReleasedEvent)}, currentTaskIds=${currentTaskIds.join(',') || '-'}`,
    };
  }, timeoutMs);
}

export async function runRemoteCancellationExercise(client, options = {}) {
  const workerId = String(options.workerId || '').trim();
  if (!workerId) {
    throw new Error('Remote cancellation exercise requires a workerId');
  }
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs || 60_000));
  const startedAt = Date.now();
  let taskId = null;

  try {
    const { worker: initialWorker } = await client.getWorker(workerId);
    if (!initialWorker.active || initialWorker.adminState !== 'enabled' || initialWorker.gatewayState === 'offline') {
      throw new Error(`Worker ${workerId} is not active and enabled`);
    }

    const created = await client.createTask({
      title: 'nado cross-site remote cancellation exercise',
      type: 'shell',
      workerId,
      requireRoutable: true,
      keepWorkspace: false,
      timeoutMs: Math.max(timeoutMs * 3, 180_000),
      maxAttempts: 1,
      command: 'node -e "console.log(\'nado-remote-cancellation-ready\'); setInterval(() => {}, 1000)"',
    });
    taskId = created.task.id;
    const runningTask = await waitForRunningTask(client, taskId, workerId, timeoutMs);
    const attemptId = runningTask.currentAttemptId || null;
    const managed = await client.manageTask(taskId, 'cancel', {
      reason: 'Nado cross-site remote cancellation acceptance exercise',
    });
    if (managed.task.status !== 'cancelled') {
      throw new Error(`Cancellation API returned task status ${managed.task.status}`);
    }

    const confirmation = await waitForWorkerCancellation(
      client,
      workerId,
      taskId,
      timeoutMs,
    );
    const [{ task: finalTask }, taskEvents] = await Promise.all([
      client.getTask(taskId),
      client.listTaskEvents(taskId),
    ]);
    if (finalTask.status !== 'cancelled') {
      throw new Error(`Cancelled task did not remain terminal; status=${finalTask.status}`);
    }
    if (!(taskEvents.events || []).some((event) => event.type === 'cancelled')) {
      throw new Error('Cancelled task is missing its durable cancelled event');
    }

    return {
      version: 1,
      exercise: 'remoteCancellation',
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      attemptId,
      taskStatus: finalTask.status,
      workerGatewayState: confirmation.worker.gatewayState,
      workerCurrentTaskIds: confirmation.worker.currentTaskIds || [],
      commandEvent: {
        at: confirmation.commandEvent.at,
        type: confirmation.commandEvent.type,
        action: confirmation.commandEvent.data?.action || null,
        taskId: confirmation.commandEvent.data?.taskId || null,
      },
      processReleasedEvent: {
        at: confirmation.releasedEvent.at,
        type: confirmation.releasedEvent.type,
        taskId: confirmation.releasedEvent.data?.taskId || null,
        attemptId: confirmation.releasedEvent.data?.attemptId || null,
      },
      references: [
        `task:${taskId}`,
        `task:${taskId}:attempt:${attemptId || 'unknown'}`,
        `worker:${workerId}:event:${confirmation.commandEvent.at}`,
        `worker:${workerId}:event:${confirmation.releasedEvent.at}`,
      ],
    };
  } catch (error) {
    if (taskId) {
      try {
        const { task } = await client.getTask(taskId);
        if (!TERMINAL_TASK_STATUSES.has(task.status)) {
          await client.manageTask(taskId, 'cancel', {
            reason: 'Cleaning up failed remote cancellation acceptance exercise',
          });
        }
      } catch {
        // Preserve the exercise failure; best-effort cleanup is reported through task history.
      }
    }
    return {
      version: 1,
      exercise: 'remoteCancellation',
      ok: false,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      error: error.message,
      references: taskId ? [`task:${taskId}`] : [],
    };
  }
}

export async function runShortDisconnectExercise(client, options = {}) {
  const workerId = String(options.workerId || '').trim();
  if (!workerId) {
    throw new Error('Short disconnect exercise requires a workerId');
  }
  const timeoutMs = Math.max(30_000, Number(options.timeoutMs || 180_000));
  const minDisconnectMs = Math.max(2_000, Number(options.minDisconnectMs || 5_000));
  const taskDurationMs = Math.max(minDisconnectMs + 10_000, Number(options.taskDurationMs || 90_000));
  const startedAt = Date.now();
  let taskId = null;
  let attemptId = null;

  try {
    const { worker: initialWorker } = await client.getWorker(workerId);
    if (!initialWorker.active || initialWorker.adminState !== 'enabled' || initialWorker.gatewayState === 'offline') {
      throw new Error(`Worker ${workerId} is not active and enabled`);
    }

    const command = [
      "const fs=require('fs');",
      "const file='short-disconnect.txt';",
      "fs.appendFileSync(file,'execution\\n');",
      "console.log('nado-short-disconnect-ready');",
      `setTimeout(()=>{fs.appendFileSync(file,'completed\\n');console.log('nado-short-disconnect-complete');},${Math.floor(taskDurationMs)});`,
    ].join('');
    const created = await client.createTask({
      title: 'nado cross-site short disconnect exercise',
      type: 'shell',
      workerId,
      requireRoutable: true,
      keepWorkspace: false,
      timeoutMs: taskDurationMs + 30_000,
      maxAttempts: 1,
      artifactPolicy: { include: ['short-disconnect.txt'] },
      command: `node -e "${command}"`,
    });
    taskId = created.task.id;
    const runningTask = await waitForRunningTask(client, taskId, workerId, timeoutMs);
    attemptId = runningTask.currentAttemptId;
    const leaseDurationMs = Number(runningTask.lease?.durationMs || 0);
    if (!attemptId || !leaseDurationMs) {
      throw new Error('Running task is missing attempt or lease evidence');
    }
    if (leaseDurationMs <= minDisconnectMs + 5_000) {
      throw new Error(
        `Task lease ${leaseDurationMs}ms is too short for a ${minDisconnectMs}ms heartbeat gap; increase NADO_TASK_LEASE_MS`,
      );
    }

    options.onProgress?.({
      phase: 'disconnect_now',
      workerId,
      taskId,
      attemptId,
      minDisconnectMs,
      leaseDurationMs,
      message: `Disconnect the home Worker network now for at least ${minDisconnectMs}ms, but reconnect before the ${leaseDurationMs}ms lease expires`,
    });
    const gap = await waitForHeartbeatGap(
      client,
      taskId,
      workerId,
      attemptId,
      minDisconnectMs,
      timeoutMs,
    );
    const leaseExpiresAtDuringGap = gap.task.lease?.expiresAt || null;
    if (!leaseExpiresAtDuringGap || Date.parse(leaseExpiresAtDuringGap) <= Date.now()) {
      throw new Error('Task lease expired before the heartbeat gap could be recovered');
    }
    const gapObservation = await client.recordShortDisconnectObservation(taskId, {
      phase: 'gap',
      workerId,
      attemptId,
      minDisconnectMs,
    });

    options.onProgress?.({
      phase: 'disconnect_observed',
      workerId,
      taskId,
      attemptId,
      observedAgeMs: gap.worker.ageMs,
      leaseExpiresAt: leaseExpiresAtDuringGap,
      message: `Heartbeat gap observed (${Math.round(gap.worker.ageMs)}ms); reconnect the home Worker network now`,
    });
    const recovery = await waitForHeartbeatRecovery(
      client,
      taskId,
      workerId,
      attemptId,
      timeoutMs,
    );
    if (Date.parse(recovery.task.lease?.renewedAt || '') <= Date.parse(gap.task.lease?.renewedAt || '')) {
      throw new Error('Worker reappeared without renewing the same task attempt lease');
    }
    const recoveryObservation = await client.recordShortDisconnectObservation(taskId, {
      phase: 'recovered',
      workerId,
      attemptId,
      minDisconnectMs,
    });
    options.onProgress?.({
      phase: 'reconnected',
      workerId,
      taskId,
      attemptId,
      renewedAt: recovery.task.lease?.renewedAt || null,
      message: 'Worker heartbeat and same-attempt lease renewal recovered; waiting for task completion',
    });

    const finalTask = await waitForTerminalTask(client, taskId, workerId, timeoutMs);
    if (finalTask.status !== 'succeeded' || finalTask.assignedWorkerId !== workerId) {
      throw new Error(
        `Short-disconnect task ended status=${finalTask.status} on worker=${finalTask.assignedWorkerId || '-'}`,
      );
    }
    if (finalTask.attempts?.length !== 1 || finalTask.attempts[0]?.id !== attemptId) {
      throw new Error(`Short-disconnect task did not preserve its single attempt ${attemptId}`);
    }
    const resultArtifact = await downloadRequiredArtifact(client, finalTask, 'short-disconnect.txt');
    const lines = resultArtifact.bytes.toString('utf8').trim().split(/\r?\n/);
    if (lines.filter((line) => line === 'execution').length !== 1 || lines.filter((line) => line === 'completed').length !== 1) {
      throw new Error(`Short-disconnect task execution count is invalid: ${JSON.stringify(lines)}`);
    }

    return {
      version: 1,
      exercise: 'shortDisconnect',
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      attemptId,
      taskStatus: finalTask.status,
      attemptCount: finalTask.attempts.length,
      minDisconnectMs,
      observedGap: {
        observedAt: gapObservation.event.at,
        ageMs: gapObservation.event.data.workerAgeMs,
        lastSeenAt: gapObservation.event.data.workerLastSeenAt || null,
        leaseRenewedAt: gapObservation.event.data.leaseRenewedAt || null,
        leaseExpiresAt: gapObservation.event.data.leaseExpiresAt || null,
      },
      recovery: {
        recoveredAt: recoveryObservation.event.at,
        workerLastSeenAt: recoveryObservation.event.data.workerLastSeenAt || null,
        workerAgeMs: recoveryObservation.event.data.workerAgeMs,
        leaseRenewedAt: recoveryObservation.event.data.leaseRenewedAt || null,
        leaseExpiresAt: recoveryObservation.event.data.leaseExpiresAt || null,
      },
      artifact: {
        id: resultArtifact.artifact.id,
        path: resultArtifact.artifact.path,
        sha256: resultArtifact.artifact.sha256 || null,
        size: resultArtifact.bytes.length,
      },
      references: [
        `worker:${workerId}`,
        `task:${taskId}`,
        `task:${taskId}:attempt:${attemptId}`,
        `artifact:${taskId}:${resultArtifact.artifact.id}`,
      ],
    };
  } catch (error) {
    if (taskId) {
      try {
        const { task } = await client.getTask(taskId);
        if (!TERMINAL_TASK_STATUSES.has(task.status)) {
          await client.manageTask(taskId, 'cancel', {
            reason: 'Cleaning up failed short disconnect acceptance exercise',
          });
        }
      } catch {
        // Preserve the exercise failure; task history remains available for diagnosis.
      }
    }
    return {
      version: 1,
      exercise: 'shortDisconnect',
      ok: false,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      attemptId,
      error: error.message,
      references: taskId ? [`task:${taskId}`] : [],
    };
  }
}

export async function runLongDisconnectRecoveryExercise(client, options = {}) {
  const workerId = String(options.workerId || '').trim();
  if (!workerId) {
    throw new Error('Long disconnect recovery exercise requires a workerId');
  }
  const timeoutMs = Math.max(60_000, Number(options.timeoutMs || 300_000));
  const startedAt = Date.now();
  let taskId = null;
  let firstAttemptId = null;

  try {
    const [capabilities, workerResult] = await Promise.all([
      client.capabilities(),
      client.getWorker(workerId),
    ]);
    const automaticRecovery = capabilities.reliability?.automaticOfflineRecovery || {};
    const leaseDurationMs = Number(capabilities.reliability?.taskLeaseMs || 0);
    const scanIntervalMs = Number(automaticRecovery.scanIntervalMs || 0);
    if (!automaticRecovery.enabled || !leaseDurationMs || !scanIntervalMs) {
      throw new Error(
        'Long disconnect recovery exercise requires enabled automatic offline recovery, a task lease, and a recovery scan interval',
      );
    }
    const initialWorker = workerResult.worker;
    if (!initialWorker.active || initialWorker.adminState !== 'enabled' || initialWorker.gatewayState === 'offline') {
      throw new Error(`Worker ${workerId} is not active and enabled`);
    }
    const firstAttemptMs = Math.max(
      leaseDurationMs + scanIntervalMs + 15_000,
      Number(options.firstAttemptMs || 0),
    );
    const secondAttemptMs = Math.max(500, Number(options.secondAttemptMs || 1_000));
    const command = [
      "const fs=require('fs');",
      "const seq=Number(process.env.NADO_ATTEMPT_SEQ||0);",
      "const id=process.env.NADO_ATTEMPT_ID||'unknown';",
      "console.log('nado-long-disconnect-attempt-'+seq+'-ready');",
      `const delay=seq===1?${Math.floor(firstAttemptMs)}:${Math.floor(secondAttemptMs)};`,
      "setTimeout(()=>{const body=JSON.stringify({attemptId:id,attemptSeq:seq,workerId:process.env.NADO_WORKER_ID});fs.writeFileSync('long-disconnect.json',body);console.log('nado-long-disconnect-attempt-'+seq+'-complete');},delay);",
    ].join('');
    const created = await client.createTask({
      title: 'nado cross-site long disconnect recovery exercise',
      type: 'shell',
      workerId,
      requireRoutable: true,
      keepWorkspace: false,
      timeoutMs: firstAttemptMs + 30_000,
      maxAttempts: 2,
      retryBackoffMs: 0,
      maxRetryBackoffMs: 0,
      artifactPolicy: { include: ['long-disconnect.json'] },
      command: `node -e "${command}"`,
    });
    taskId = created.task.id;
    const runningTask = await waitForRunningTask(client, taskId, workerId, timeoutMs);
    firstAttemptId = runningTask.currentAttemptId;
    if (!firstAttemptId || Number(runningTask.lease?.durationMs || 0) !== leaseDurationMs) {
      throw new Error('Running task lease does not match the advertised control-plane lease policy');
    }
    await waitForTaskOutput(
      client,
      taskId,
      firstAttemptId,
      'nado-long-disconnect-attempt-1-ready',
      timeoutMs,
    );

    options.onProgress?.({
      phase: 'disconnect_until_requeued',
      workerId,
      taskId,
      attemptId: firstAttemptId,
      leaseDurationMs,
      scanIntervalMs,
      message: `Disconnect the original Worker network now and keep it disconnected until Nado reports lease recovery (about ${Math.ceil((leaseDurationMs + scanIntervalMs) / 1000)} seconds)`,
    });
    const recovery = await waitForLeaseRecovery(client, taskId, firstAttemptId, timeoutMs);
    options.onProgress?.({
      phase: 'lease_recovered',
      workerId,
      taskId,
      attemptId: firstAttemptId,
      recoveredAt: recovery.recoveredAt,
      message: 'The first attempt lease expired and the VM requeued the task; reconnect the original Worker now',
    });

    const outcome = await waitForLongDisconnectOutcome(
      client,
      taskId,
      workerId,
      firstAttemptId,
      timeoutMs,
    );
    const finalTask = outcome.task;
    if (finalTask.attempts?.length !== 2) {
      throw new Error(`Expected exactly two attempts, got ${finalTask.attempts?.length || 0}`);
    }
    const [firstAttempt, secondAttempt] = finalTask.attempts;
    if (firstAttempt.id !== firstAttemptId || firstAttempt.status !== 'lease_expired') {
      throw new Error('First attempt is missing durable lease_expired evidence');
    }
    if (secondAttempt.id === firstAttemptId || secondAttempt.status !== 'succeeded') {
      throw new Error('Second attempt did not complete successfully with a distinct identity');
    }
    const firstExecutionEvent = (finalTask.events || []).find((event) => (
      event.type === 'stdout'
      && event.message?.includes('nado-long-disconnect-attempt-1-ready')
    ));
    if (!firstExecutionEvent) {
      throw new Error('First attempt execution marker is missing from durable task events');
    }
    const artifact = await downloadRequiredArtifact(client, finalTask, 'long-disconnect.json');
    let payload;
    try {
      payload = JSON.parse(artifact.bytes.toString('utf8'));
    } catch {
      throw new Error('Long-disconnect result artifact is not valid JSON');
    }
    if (payload.attemptSeq !== 2 || payload.attemptId !== secondAttempt.id) {
      throw new Error('Final artifact does not identify the successful second attempt');
    }

    return {
      version: 1,
      exercise: 'longDisconnectRecovery',
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      leaseDurationMs,
      recoveryScanIntervalMs: scanIntervalMs,
      firstAttemptMs,
      attempts: finalTask.attempts.map((attempt) => ({
        id: attempt.id,
        seq: attempt.seq,
        workerId: attempt.workerId,
        status: attempt.status,
        claimedAt: attempt.claimedAt,
        completedAt: attempt.completedAt,
      })),
      recoveryEvent: {
        at: recovery.recoveryEvent.at,
        type: recovery.recoveryEvent.type,
        recoveryReason: recovery.recoveryEvent.data?.recoveryReason || null,
        previousWorkerId: recovery.recoveryEvent.data?.previousWorkerId || null,
      },
      staleResultRejection: {
        at: outcome.rejectionEvent.at,
        type: outcome.rejectionEvent.type,
        resultAttemptId: outcome.rejectionEvent.data?.resultAttemptId || null,
        currentAttemptId: outcome.rejectionEvent.data?.currentAttemptId || null,
      },
      finalWorkerId: finalTask.assignedWorkerId,
      originalWorkerReconnected: outcome.worker.active,
      artifact: {
        id: artifact.artifact.id,
        path: artifact.artifact.path,
        sha256: artifact.artifact.sha256 || null,
        size: artifact.bytes.length,
      },
      deliverySemantics: 'at-least-once',
      references: [
        `worker:${workerId}`,
        `task:${taskId}`,
        `task:${taskId}:attempt:${firstAttempt.id}`,
        `task:${taskId}:attempt:${secondAttempt.id}`,
        `artifact:${taskId}:${artifact.artifact.id}`,
      ],
    };
  } catch (error) {
    if (taskId) {
      try {
        const { task } = await client.getTask(taskId);
        if (!TERMINAL_TASK_STATUSES.has(task.status)) {
          await client.manageTask(taskId, 'cancel', {
            reason: 'Cleaning up failed long disconnect recovery acceptance exercise',
          });
        }
      } catch {
        // Preserve the exercise failure; durable task history remains available.
      }
    }
    return {
      version: 1,
      exercise: 'longDisconnectRecovery',
      ok: false,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      firstAttemptId,
      error: error.message,
      deliverySemantics: 'at-least-once',
      references: taskId ? [`task:${taskId}`] : [],
    };
  }
}

export async function runWorkerRestartRecoveryExercise(client, options = {}) {
  const workerId = String(options.workerId || '').trim();
  if (!workerId) {
    throw new Error('Worker restart recovery exercise requires a workerId');
  }
  const timeoutMs = Math.max(90_000, Number(options.timeoutMs || 300_000));
  const startedAt = Date.now();
  let taskId = null;
  let initialRuntime = null;
  let initialTokenId = null;
  let offlineObservation = null;

  try {
    const [{ worker: initialWorker }, initialEventsResult] = await Promise.all([
      client.getWorker(workerId),
      client.listWorkerEvents(workerId, { tail: 300 }),
    ]);
    initialRuntime = initialWorker.runtime || null;
    initialTokenId = initialWorker.identity?.workerTokenId || null;
    if (!initialWorker.active || initialWorker.adminState !== 'enabled' || initialWorker.gatewayState === 'offline') {
      throw new Error(`Worker ${workerId} is not active and enabled`);
    }
    if (!initialRuntime?.id || !Number.isFinite(Date.parse(initialRuntime.startedAt || ''))) {
      throw new Error('Worker runtime identity is missing; upgrade and restart the home Worker before this exercise');
    }
    if (
      initialWorker.identity?.type !== 'worker_token'
      || initialWorker.identity?.signed !== true
      || !initialTokenId
    ) {
      throw new Error('Worker restart recovery requires a signed worker-scoped identity');
    }
    const initialRuntimeEvent = (initialEventsResult.events || []).find((event) => (
      event.type === 'runtime_started'
      && event.data?.controlObserved === true
      && event.data?.runtimeId === initialRuntime.id
      && event.data?.workerTokenId === initialTokenId
    ));
    if (!initialRuntimeEvent) {
      throw new Error(`Worker ${workerId} is missing its control-observed runtime-start event`);
    }

    options.onProgress?.({
      phase: 'stop_worker_now',
      workerId,
      runtimeId: initialRuntime.id,
      message: `Stop the home Worker service ${workerId} now and keep it stopped until this command reports that offline state was observed`,
    });
    offlineObservation = await waitFor(client, `Worker ${workerId} to become control-observed offline`, async () => {
      const { worker } = await client.getWorker(workerId);
      if (worker.runtime?.id !== initialRuntime.id) {
        throw new Error('Worker restarted before the control plane observed the required offline interval');
      }
      if (worker.gatewayState === 'offline' && worker.active === false) {
        return {
          done: true,
          value: {
            observedAt: new Date().toISOString(),
            lastSeenAt: worker.lastSeenAt || null,
            ageMs: worker.ageMs,
            runtimeId: worker.runtime.id,
          },
        };
      }
      return {
        done: false,
        detail: `gatewayState=${worker.gatewayState}, ageMs=${worker.ageMs}, runtime=${worker.runtime?.id || '-'}`,
      };
    }, timeoutMs);

    options.onProgress?.({
      phase: 'start_worker_now',
      workerId,
      offlineObservation,
      message: `Control observed Worker ${workerId} offline; start the same installed Worker service now`,
    });
    const recovery = await waitFor(client, `Worker ${workerId} to reconnect as a new runtime`, async () => {
      const [{ worker }, eventsResult] = await Promise.all([
        client.getWorker(workerId),
        client.listWorkerEvents(workerId, { tail: 300 }),
      ]);
      const runtime = worker.runtime || {};
      const runtimeEvent = [...(eventsResult.events || [])].reverse().find((event) => (
        event.type === 'runtime_started'
        && event.data?.controlObserved === true
        && event.data?.runtimeId === runtime.id
        && event.data?.previousRuntimeId === initialRuntime.id
      )) || null;
      if (runtime.id && runtime.id !== initialRuntime.id) {
        if (worker.identity?.workerTokenId !== initialTokenId) {
          throw new Error(`Worker token changed across restart: expected ${initialTokenId}, got ${worker.identity?.workerTokenId || '-'}`);
        }
        if (
          worker.active
          && worker.gatewayState !== 'offline'
          && runtimeEvent
          && runtimeEvent.data?.workerTokenId === initialTokenId
          && runtimeEvent.data?.runtimeStartedAt === runtime.startedAt
          && Date.parse(runtimeEvent.at || '') >= Date.parse(offlineObservation.observedAt)
          && Date.parse(runtime.startedAt || '') > Date.parse(initialRuntime.startedAt)
        ) {
          return { done: true, value: { worker, runtimeEvent, reconnectedAt: new Date().toISOString() } };
        }
      }
      return {
        done: false,
        detail: `active=${Boolean(worker.active)}, gatewayState=${worker.gatewayState}, runtime=${runtime.id || '-'}, event=${runtimeEvent?.at || '-'}`,
      };
    }, timeoutMs);

    const command = [
      "const fs=require('fs');",
      "const body={workerId:process.env.NADO_WORKER_ID,runtimeId:process.env.NADO_WORKER_RUNTIME_ID,runtimeStartedAt:process.env.NADO_WORKER_RUNTIME_STARTED_AT,attemptId:process.env.NADO_ATTEMPT_ID,attemptSeq:Number(process.env.NADO_ATTEMPT_SEQ||0),executedAt:new Date().toISOString()};",
      "fs.writeFileSync('worker-restart-recovery.json',JSON.stringify(body));",
      "console.log('nado-worker-restart-probe-complete');",
    ].join('');
    const created = await client.createTask({
      title: 'nado cross-site Worker restart recovery exercise',
      type: 'shell',
      workerId,
      requireRoutable: true,
      keepWorkspace: false,
      timeoutMs,
      maxAttempts: 1,
      artifactPolicy: { include: ['worker-restart-recovery.json'] },
      command: `node -e "${command}"`,
    });
    taskId = created.task.id;
    const finalTask = await waitForTerminalTask(client, taskId, workerId, timeoutMs);
    if (finalTask.status !== 'succeeded' || finalTask.assignedWorkerId !== workerId) {
      throw new Error(`Worker-restart probe ended status=${finalTask.status} on worker=${finalTask.assignedWorkerId || '-'}`);
    }
    if (finalTask.attempts?.length !== 1 || finalTask.attempts[0]?.workerId !== workerId) {
      throw new Error('Worker-restart probe did not preserve one target-Worker attempt');
    }
    const resultArtifact = await downloadRequiredArtifact(client, finalTask, 'worker-restart-recovery.json');
    let payload;
    try {
      payload = JSON.parse(resultArtifact.bytes.toString('utf8'));
    } catch {
      throw new Error('Worker-restart probe artifact is not valid JSON');
    }
    if (
      payload.workerId !== workerId
      || payload.runtimeId !== recovery.worker.runtime.id
      || payload.runtimeStartedAt !== recovery.worker.runtime.startedAt
      || payload.attemptId !== finalTask.attempts[0].id
      || payload.attemptSeq !== 1
    ) {
      throw new Error(`Worker-restart probe artifact has invalid runtime/attempt identity: ${JSON.stringify(payload)}`);
    }
    const downloadedSha256 = crypto.createHash('sha256').update(resultArtifact.bytes).digest('hex');
    if (resultArtifact.artifact.sha256 && resultArtifact.artifact.sha256 !== downloadedSha256) {
      throw new Error('Worker-restart probe SHA-256 does not match its stored metadata');
    }

    return {
      version: 1,
      exercise: 'workerRestartRecovery',
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      tokenContinuity: {
        workerTokenId: initialTokenId,
        unchanged: true,
      },
      runtimeRestart: {
        original: initialRuntime,
        restarted: recovery.worker.runtime,
        eventAt: recovery.runtimeEvent.at,
        previousRuntimeId: recovery.runtimeEvent.data?.previousRuntimeId || null,
        previousLastSeenAt: recovery.runtimeEvent.data?.previousLastSeenAt || null,
      },
      offlineObservation,
      workerRecovery: {
        reconnectedAt: recovery.reconnectedAt,
        lastSeenAt: recovery.worker.lastSeenAt || null,
        gatewayState: recovery.worker.gatewayState,
      },
      taskId,
      attemptId: finalTask.attempts[0].id,
      taskStatus: finalTask.status,
      artifact: {
        id: resultArtifact.artifact.id,
        path: resultArtifact.artifact.path,
        sha256: downloadedSha256,
        size: resultArtifact.bytes.length,
        runtimeId: payload.runtimeId,
        runtimeStartedAt: payload.runtimeStartedAt,
      },
      references: [
        `worker:${workerId}`,
        `worker:${workerId}:runtime:${initialRuntime.id}`,
        `worker:${workerId}:runtime:${recovery.worker.runtime.id}`,
        `task:${taskId}`,
        `task:${taskId}:attempt:${finalTask.attempts[0].id}`,
        `artifact:${taskId}:${resultArtifact.artifact.id}`,
      ],
    };
  } catch (error) {
    if (taskId) {
      try {
        const { task } = await client.getTask(taskId);
        if (!TERMINAL_TASK_STATUSES.has(task.status)) {
          await client.manageTask(taskId, 'cancel', {
            reason: 'Cleaning up failed Worker restart recovery acceptance exercise',
          });
        }
      } catch {
        // Preserve the exercise failure and any durable Worker/runtime history.
      }
    }
    return {
      version: 1,
      exercise: 'workerRestartRecovery',
      ok: false,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      initialRuntime,
      initialTokenId,
      offlineObservation,
      error: error.message,
      references: taskId ? [`worker:${workerId}`, `task:${taskId}`] : [`worker:${workerId}`],
    };
  }
}

export async function runVmRestartRecoveryExercise(client, options = {}) {
  const workerId = String(options.workerId || '').trim();
  if (!workerId) {
    throw new Error('VM restart recovery exercise requires a workerId');
  }
  const timeoutMs = Math.max(30_000, Number(options.timeoutMs || 300_000));
  const taskDurationMs = Math.max(500, Number(options.taskDurationMs || 90_000));
  const startedAt = Date.now();
  let taskId = null;
  let attemptId = null;
  let originalRuntime = null;

  try {
    const [initialHealth, initialStatus, workerResult] = await Promise.all([
      client.health(),
      client.status(),
      client.getWorker(workerId),
    ]);
    originalRuntime = initialHealth.runtime || null;
    if (!originalRuntime?.instanceId) {
      throw new Error('Control health is missing runtime.instanceId; upgrade the VM control service first');
    }
    if (initialStatus.runtime?.instanceId !== originalRuntime.instanceId) {
      throw new Error('Control health and authenticated status report different runtime instances');
    }
    if (initialStatus.storage?.backend !== 'sqlite') {
      throw new Error(
        `VM restart recovery exercise requires the SQLite control store; current backend=${initialStatus.storage?.backend || '-'}`,
      );
    }
    const initialWorker = workerResult.worker;
    if (!initialWorker.active || initialWorker.adminState !== 'enabled' || initialWorker.gatewayState === 'offline') {
      throw new Error(`Worker ${workerId} is not active and enabled`);
    }

    const command = [
      "const fs=require('fs');",
      "const file='vm-restart-recovery.json';",
      "const attemptId=process.env.NADO_ATTEMPT_ID||'unknown';",
      "const attemptSeq=Number(process.env.NADO_ATTEMPT_SEQ||0);",
      "const workerId=process.env.NADO_WORKER_ID||'unknown';",
      "const body={attemptId,attemptSeq,workerId,executionCount:1,completionCount:0,startedAt:new Date().toISOString()};",
      "fs.writeFileSync(file,JSON.stringify(body));",
      "console.log('nado-vm-restart-ready');",
      `setTimeout(()=>{body.completionCount=1;body.completedAt=new Date().toISOString();fs.writeFileSync(file,JSON.stringify(body));console.log('nado-vm-restart-complete');},${Math.floor(taskDurationMs)});`,
    ].join('');
    const created = await client.createTask({
      title: 'nado cross-site VM restart recovery exercise',
      type: 'shell',
      workerId,
      requireRoutable: true,
      keepWorkspace: false,
      timeoutMs: taskDurationMs + timeoutMs,
      maxAttempts: 1,
      artifactPolicy: { include: ['vm-restart-recovery.json'] },
      command: `node -e "${command}"`,
    });
    taskId = created.task.id;
    const runningTask = await waitForRunningTask(client, taskId, workerId, timeoutMs);
    attemptId = runningTask.currentAttemptId;
    if (!attemptId || runningTask.attempts?.length !== 1) {
      throw new Error('Running VM-restart task is missing its single durable attempt identity');
    }
    await waitForTaskOutput(client, taskId, attemptId, 'nado-vm-restart-ready', timeoutMs);

    options.onProgress?.({
      phase: 'restart_control_now',
      workerId,
      taskId,
      attemptId,
      originalInstanceId: originalRuntime.instanceId,
      taskDurationMs,
      message: `Restart the VM control service now, keeping its SQLite data volume; do not restart Worker ${workerId}`,
    });
    const restart = await waitForControlRestart(
      client,
      originalRuntime.instanceId,
      timeoutMs,
      options.onProgress,
    );
    options.onProgress?.({
      phase: 'control_restarted',
      workerId,
      taskId,
      attemptId,
      originalInstanceId: originalRuntime.instanceId,
      restartedInstanceId: restart.health.runtime.instanceId,
      message: `Control restarted as ${restart.health.runtime.instanceId}; waiting for the home Worker and original task attempt`,
    });

    const recovery = await waitForRestartRecovery(
      client,
      taskId,
      workerId,
      attemptId,
      restart.health.runtime.startedAt,
      timeoutMs,
    );
    options.onProgress?.({
      phase: 'worker_reconnected',
      workerId,
      taskId,
      attemptId,
      recoveredAt: recovery.recoveredAt,
      message: 'Home Worker reconnected and the original SQLite-backed task attempt is still durable',
    });

    const finalTask = await waitForTerminalTask(client, taskId, workerId, timeoutMs);
    if (finalTask.status !== 'succeeded' || finalTask.assignedWorkerId !== workerId) {
      throw new Error(
        `VM-restart task ended status=${finalTask.status} on worker=${finalTask.assignedWorkerId || '-'}`,
      );
    }
    if (finalTask.attempts?.length !== 1 || finalTask.attempts[0]?.id !== attemptId) {
      throw new Error(`VM-restart task did not preserve its single attempt ${attemptId}`);
    }
    const resultArtifact = await downloadRequiredArtifact(client, finalTask, 'vm-restart-recovery.json');
    let payload;
    try {
      payload = JSON.parse(resultArtifact.bytes.toString('utf8'));
    } catch {
      throw new Error('VM-restart result artifact is not valid JSON');
    }
    if (
      payload.attemptId !== attemptId
      || payload.attemptSeq !== 1
      || payload.workerId !== workerId
      || payload.executionCount !== 1
      || payload.completionCount !== 1
    ) {
      throw new Error(`VM-restart result artifact has invalid execution identity/counts: ${JSON.stringify(payload)}`);
    }
    const downloadedSha256 = crypto.createHash('sha256').update(resultArtifact.bytes).digest('hex');
    if (resultArtifact.artifact.sha256 && resultArtifact.artifact.sha256 !== downloadedSha256) {
      throw new Error('VM-restart result artifact SHA-256 does not match its stored metadata');
    }

    return {
      version: 1,
      exercise: 'vmRestartRecovery',
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      attemptId,
      taskStatus: finalTask.status,
      attemptCount: finalTask.attempts.length,
      storage: recovery.status.storage,
      controlRestart: {
        original: originalRuntime,
        restarted: restart.health.runtime,
        outageObserved: true,
        unavailableObservations: restart.unavailable,
        recoveredAt: restart.observedAt,
      },
      workerRecovery: {
        recoveredAt: recovery.recoveredAt,
        gatewayState: recovery.worker.gatewayState,
        lastSeenAt: recovery.worker.lastSeenAt || null,
        ageMs: recovery.worker.ageMs,
      },
      artifact: {
        id: resultArtifact.artifact.id,
        path: resultArtifact.artifact.path,
        sha256: downloadedSha256,
        size: resultArtifact.bytes.length,
        executionCount: payload.executionCount,
        completionCount: payload.completionCount,
      },
      references: [
        `worker:${workerId}`,
        `control:${originalRuntime.instanceId}`,
        `control:${restart.health.runtime.instanceId}`,
        `task:${taskId}`,
        `task:${taskId}:attempt:${attemptId}`,
        `artifact:${taskId}:${resultArtifact.artifact.id}`,
      ],
    };
  } catch (error) {
    if (taskId) {
      try {
        const { task } = await client.getTask(taskId);
        if (!TERMINAL_TASK_STATUSES.has(task.status)) {
          await client.manageTask(taskId, 'cancel', {
            reason: 'Cleaning up failed VM restart recovery acceptance exercise',
          });
        }
      } catch {
        // Preserve the exercise failure; the control service may still be restarting.
      }
    }
    return {
      version: 1,
      exercise: 'vmRestartRecovery',
      ok: false,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      attemptId,
      originalRuntime,
      error: error.message,
      references: taskId ? [`worker:${workerId}`, `task:${taskId}`] : [`worker:${workerId}`],
    };
  }
}

export async function runLargeArtifactResumeExercise(client, options = {}) {
  const workerId = String(options.workerId || '').trim();
  if (!workerId) {
    throw new Error('Large artifact resume exercise requires a workerId');
  }
  const timeoutMs = Math.max(30_000, Number(options.timeoutMs || 300_000));
  const minStallMs = Math.max(2_000, Number(options.minStallMs || 5_000));
  const artifactBytes = Math.floor(Math.min(
    512 * 1024 * 1024,
    Math.max(128 * 1024, Number(options.artifactBytes || 64 * 1024 * 1024)),
  ));
  const artifactPath = 'large-artifact-resume.bin';
  const patternByte = crypto.randomBytes(1)[0];
  const expectedSha256 = repeatedByteSha256(artifactBytes, patternByte);
  const startedAt = Date.now();
  let taskId = null;
  let attemptId = null;
  let uploadId = null;

  try {
    const [capabilities, workerResult] = await Promise.all([
      client.capabilities(),
      client.getWorker(workerId),
    ]);
    if (!capabilities.features?.resumableArtifactUploads) {
      throw new Error('Control plane does not advertise resumable artifact uploads');
    }
    const initialWorker = workerResult.worker;
    if (!initialWorker.active || initialWorker.adminState !== 'enabled' || initialWorker.gatewayState === 'offline') {
      throw new Error(`Worker ${workerId} is not active and enabled`);
    }

    const command = [
      "const fs=require('fs');",
      `const total=${Math.floor(artifactBytes)};`,
      `const block=Buffer.alloc(Math.min(1048576,total),${patternByte});`,
      `const fd=fs.openSync('${artifactPath}','w');`,
      "let written=0;",
      "while(written<total){const length=Math.min(block.length,total-written);fs.writeSync(fd,block,0,length,written);written+=length;}",
      "fs.closeSync(fd);",
      "console.log('nado-large-artifact-ready');",
    ].join('');
    const created = await client.createTask({
      title: 'nado cross-site large artifact resume exercise',
      type: 'shell',
      workerId,
      requireRoutable: true,
      keepWorkspace: false,
      timeoutMs: timeoutMs + 120_000,
      maxAttempts: 1,
      artifactPolicy: { include: [artifactPath] },
      command: `node -e "${command}"`,
    });
    taskId = created.task.id;
    const runningTask = await waitForRunningTask(client, taskId, workerId, timeoutMs);
    attemptId = runningTask.currentAttemptId;
    if (!attemptId || runningTask.attempts?.length !== 1) {
      throw new Error('Large-artifact task is missing its single durable attempt identity');
    }
    await waitForTaskOutput(client, taskId, attemptId, 'nado-large-artifact-ready', timeoutMs);
    const partial = await waitForPartialArtifactUpload(
      client,
      taskId,
      workerId,
      attemptId,
      artifactPath,
      timeoutMs,
    );
    uploadId = partial.upload.id;
    options.onProgress?.({
      phase: 'disconnect_worker_network',
      workerId,
      taskId,
      attemptId,
      uploadId,
      committedBytes: partial.upload.committedBytes,
      totalBytes: partial.upload.size,
      minStallMs,
      message: `Disconnect the home Worker network now; ${partial.upload.committedBytes}/${partial.upload.size} artifact bytes are durably committed`,
    });

    const stall = await waitForArtifactUploadStall(
      client,
      taskId,
      workerId,
      attemptId,
      uploadId,
      partial.upload.committedBytes,
      minStallMs,
      timeoutMs,
    );
    options.onProgress?.({
      phase: 'artifact_stall_observed',
      workerId,
      taskId,
      attemptId,
      uploadId,
      committedBytes: stall.upload.committedBytes,
      stableMs: stall.stableMs,
      workerAgeMs: stall.worker.ageMs,
      message: `Artifact offset and Worker heartbeat have stalled for ${Math.round(stall.stableMs)}ms; reconnect the home Worker now`,
    });

    const recovery = await waitForArtifactUploadRecovery(
      client,
      taskId,
      workerId,
      attemptId,
      uploadId,
      stall.observedAt,
      timeoutMs,
    );
    if (Number(recovery.upload.committedBytes) !== artifactBytes) {
      throw new Error(`Finalized upload has ${recovery.upload.committedBytes}/${artifactBytes} committed bytes`);
    }
    options.onProgress?.({
      phase: 'artifact_upload_resumed',
      workerId,
      taskId,
      attemptId,
      uploadId,
      committedBytes: recovery.upload.committedBytes,
      recoveredAt: recovery.recoveredAt,
      message: 'Worker reconnected and finalized the same resumable artifact upload; waiting for task completion',
    });

    const finalTask = await waitForTerminalTask(client, taskId, workerId, timeoutMs);
    if (finalTask.status !== 'succeeded' || finalTask.assignedWorkerId !== workerId) {
      throw new Error(
        `Large-artifact task ended status=${finalTask.status} on worker=${finalTask.assignedWorkerId || '-'}`,
      );
    }
    if (finalTask.attempts?.length !== 1 || finalTask.attempts[0]?.id !== attemptId) {
      throw new Error(`Large-artifact task did not preserve its single attempt ${attemptId}`);
    }
    const resultArtifact = await downloadRequiredArtifact(client, finalTask, artifactPath);
    const downloadedSha256 = crypto.createHash('sha256').update(resultArtifact.bytes).digest('hex');
    if (
      resultArtifact.bytes.length !== artifactBytes
      || downloadedSha256 !== expectedSha256
      || recovery.upload.sha256 !== expectedSha256
      || (resultArtifact.artifact.sha256 && resultArtifact.artifact.sha256 !== expectedSha256)
      || resultArtifact.artifact.uploadId !== uploadId
    ) {
      throw new Error('Resumed artifact size, SHA-256, or upload identity does not match the deterministic Worker source');
    }

    return {
      version: 1,
      exercise: 'largeArtifactResume',
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      attemptId,
      attemptCount: finalTask.attempts.length,
      upload: {
        id: uploadId,
        path: artifactPath,
        size: artifactBytes,
        sha256: expectedSha256,
        firstObservedOffset: partial.upload.committedBytes,
        stalledOffset: stall.upload.committedBytes,
        stalledForMs: stall.stableMs,
        finalizedOffset: recovery.upload.committedBytes,
      },
      disconnect: {
        observedAt: stall.observedAt,
        workerAgeMs: stall.worker.ageMs,
        workerLastSeenAt: stall.worker.lastSeenAt || null,
      },
      recovery: {
        recoveredAt: recovery.recoveredAt,
        workerLastSeenAt: recovery.worker.lastSeenAt || null,
        workerAgeMs: recovery.worker.ageMs,
      },
      artifact: {
        id: resultArtifact.artifact.id,
        uploadId: resultArtifact.artifact.uploadId,
        path: resultArtifact.artifact.path,
        size: resultArtifact.bytes.length,
        sha256: downloadedSha256,
      },
      references: [
        `worker:${workerId}`,
        `task:${taskId}`,
        `task:${taskId}:attempt:${attemptId}`,
        `upload:${taskId}:${uploadId}`,
        `artifact:${taskId}:${resultArtifact.artifact.id}`,
      ],
    };
  } catch (error) {
    if (taskId) {
      try {
        const { task } = await client.getTask(taskId);
        if (!TERMINAL_TASK_STATUSES.has(task.status)) {
          await client.manageTask(taskId, 'cancel', {
            reason: 'Cleaning up failed large artifact resume acceptance exercise',
          });
        }
      } catch {
        // Preserve the exercise failure; the Worker link may still be disconnected.
      }
    }
    return {
      version: 1,
      exercise: 'largeArtifactResume',
      ok: false,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      attemptId,
      uploadId,
      error: error.message,
      references: taskId ? [`worker:${workerId}`, `task:${taskId}`] : [`worker:${workerId}`],
    };
  }
}

export async function runLargeInputResumeExercise(client, options = {}) {
  const workerId = String(options.workerId || '').trim();
  if (!workerId) {
    throw new Error('Large input resume exercise requires a workerId');
  }
  const timeoutMs = Math.max(30_000, Number(options.timeoutMs || 300_000));
  const minStallMs = Math.max(2_000, Number(options.minStallMs || 5_000));
  const inputBytes = Math.floor(Math.min(
    512 * 1024 * 1024,
    Math.max(128 * 1024, Number(options.inputBytes || 64 * 1024 * 1024)),
  ));
  const inputPath = 'large-input-resume.bin';
  const resultPath = 'large-input-resume.json';
  const patternByte = crypto.randomBytes(1)[0];
  const expectedSha256 = repeatedByteSha256(inputBytes, patternByte);
  const startedAt = Date.now();
  let taskId = null;
  let attemptId = null;
  let inputId = null;

  try {
    const [capabilities, workerResult] = await Promise.all([
      client.capabilities(),
      client.getWorker(workerId),
    ]);
    if (!capabilities.features?.resumableTaskInputUploads || !capabilities.features?.rangedTaskInputDownloads) {
      throw new Error('Control plane does not advertise resumable input uploads and ranged Worker downloads');
    }
    if (!capabilities.features?.inputDownloadRangeEvents) {
      throw new Error('Control plane does not advertise durable input download Range events');
    }
    const initialWorker = workerResult.worker;
    if (!initialWorker.active || initialWorker.adminState !== 'enabled' || initialWorker.gatewayState === 'offline') {
      throw new Error(`Worker ${workerId} is not active and enabled`);
    }

    const command = [
      "const fs=require('fs');",
      "const crypto=require('crypto');",
      `const file='${inputPath}';`,
      "const fd=fs.openSync(file,'r');",
      "const hash=crypto.createHash('sha256');",
      "const block=Buffer.alloc(1048576);",
      "let size=0;let read=0;",
      "while((read=fs.readSync(fd,block,0,block.length,null))>0){hash.update(block.subarray(0,read));size+=read;}",
      "fs.closeSync(fd);",
      "const body={sha256:hash.digest('hex'),size,attemptId:process.env.NADO_ATTEMPT_ID,attemptSeq:Number(process.env.NADO_ATTEMPT_SEQ||0),workerId:process.env.NADO_WORKER_ID};",
      `fs.writeFileSync('${resultPath}',JSON.stringify(body));`,
      "console.log('nado-large-input-complete');",
    ].join('');
    const created = await client.createTask({
      title: 'nado cross-site large input resume exercise',
      type: 'shell',
      workerId,
      requireRoutable: true,
      keepWorkspace: false,
      timeoutMs: timeoutMs + 120_000,
      maxAttempts: 1,
      artifactPolicy: { include: [resultPath] },
      inputFiles: [{
        path: inputPath,
        size: inputBytes,
        transfer: 'chunked',
        digestMode: 'server',
      }],
      command: `node -e "${command}"`,
    });
    taskId = created.task.id;
    inputId = created.task.inputFiles?.[0]?.inputUploadId || null;
    if (created.task.status !== 'uploading_inputs' || !inputId) {
      throw new Error('Large-input task did not enter uploading_inputs with a resumable input ID');
    }

    options.onProgress?.({
      phase: 'staging_input',
      workerId,
      taskId,
      inputId,
      inputBytes,
      message: `Uploading deterministic ${inputBytes}-byte input to the VM control store before Worker download`,
    });
    const chunkBytes = 4 * 1024 * 1024;
    const block = Buffer.alloc(Math.min(chunkBytes, inputBytes), patternByte);
    let offset = 0;
    while (offset < inputBytes) {
      const length = Math.min(block.length, inputBytes - offset);
      const uploaded = await client.uploadTaskInputChunk(
        taskId,
        inputId,
        offset,
        length === block.length ? block : block.subarray(0, length),
      );
      offset = Number(uploaded.upload.committedBytes);
    }
    const finalized = await client.finalizeTaskInputUpload(taskId, inputId);
    if (
      finalized.upload.status !== 'finalized'
      || finalized.upload.committedBytes !== inputBytes
      || finalized.upload.sha256 !== expectedSha256
    ) {
      throw new Error('VM-staged input size or SHA-256 does not match the deterministic source');
    }

    const runningTask = await waitForRunningTask(client, taskId, workerId, timeoutMs);
    attemptId = runningTask.currentAttemptId;
    if (!attemptId || runningTask.attempts?.length !== 1) {
      throw new Error('Large-input task is missing its single durable attempt identity');
    }
    const leaseDurationMs = Number(runningTask.lease?.durationMs || 0);
    if (!leaseDurationMs || leaseDurationMs <= minStallMs + 5_000) {
      throw new Error(
        `Task lease ${leaseDurationMs || 0}ms is too short for a ${minStallMs}ms input download interruption`,
      );
    }
    const initialRange = await waitForInitialInputRange(
      client,
      taskId,
      workerId,
      attemptId,
      inputId,
      timeoutMs,
    );
    options.onProgress?.({
      phase: 'disconnect_worker_network',
      workerId,
      taskId,
      attemptId,
      inputId,
      inputBytes,
      minStallMs,
      initialRangeAt: initialRange.event.at,
      message: `Disconnect the home Worker network now while it is downloading ${inputBytes} input bytes from offset 0`,
    });

    const stall = await waitForInputDownloadStall(
      client,
      taskId,
      workerId,
      attemptId,
      minStallMs,
      timeoutMs,
    );
    options.onProgress?.({
      phase: 'input_download_stall_observed',
      workerId,
      taskId,
      attemptId,
      inputId,
      workerAgeMs: stall.worker.ageMs,
      message: `Worker heartbeat has been absent for ${Math.round(stall.worker.ageMs)}ms; reconnect the home Worker now`,
    });

    const resume = await waitForInputRangeResume(
      client,
      taskId,
      workerId,
      attemptId,
      inputId,
      stall.observedAt,
      timeoutMs,
    );
    const resumeOffset = Number(resume.event.data?.offset || 0);
    if (resumeOffset <= 0 || resumeOffset >= inputBytes) {
      throw new Error(`Worker resumed input at invalid offset ${resumeOffset}/${inputBytes}`);
    }
    options.onProgress?.({
      phase: 'input_download_resumed',
      workerId,
      taskId,
      attemptId,
      inputId,
      resumeOffset,
      recoveredAt: resume.recoveredAt,
      message: `Worker reconnected and requested the same input from persisted offset ${resumeOffset}; waiting for hash verification`,
    });

    const finalTask = await waitForTerminalTask(client, taskId, workerId, timeoutMs);
    if (finalTask.status !== 'succeeded' || finalTask.assignedWorkerId !== workerId) {
      throw new Error(
        `Large-input task ended status=${finalTask.status} on worker=${finalTask.assignedWorkerId || '-'}`,
      );
    }
    if (finalTask.attempts?.length !== 1 || finalTask.attempts[0]?.id !== attemptId) {
      throw new Error(`Large-input task did not preserve its single attempt ${attemptId}`);
    }
    const resultArtifact = await downloadRequiredArtifact(client, finalTask, resultPath);
    let payload;
    try {
      payload = JSON.parse(resultArtifact.bytes.toString('utf8'));
    } catch {
      throw new Error('Large-input result artifact is not valid JSON');
    }
    if (
      payload.sha256 !== expectedSha256
      || payload.size !== inputBytes
      || payload.attemptId !== attemptId
      || payload.attemptSeq !== 1
      || payload.workerId !== workerId
    ) {
      throw new Error(`Worker input verification result is invalid: ${JSON.stringify(payload)}`);
    }

    return {
      version: 1,
      exercise: 'largeInputResume',
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      attemptId,
      attemptCount: finalTask.attempts.length,
      input: {
        id: inputId,
        path: inputPath,
        size: inputBytes,
        sha256: expectedSha256,
        initialOffset: Number(initialRange.event.data?.offset || 0),
        resumedOffset: resumeOffset,
      },
      disconnect: {
        observedAt: stall.observedAt,
        workerAgeMs: stall.worker.ageMs,
        workerLastSeenAt: stall.worker.lastSeenAt || null,
      },
      recovery: {
        recoveredAt: resume.recoveredAt,
        workerLastSeenAt: resume.worker.lastSeenAt || null,
        workerAgeMs: resume.worker.ageMs,
        rangeEventAt: resume.event.at,
      },
      artifact: {
        id: resultArtifact.artifact.id,
        path: resultArtifact.artifact.path,
        sha256: resultArtifact.artifact.sha256 || crypto.createHash('sha256').update(resultArtifact.bytes).digest('hex'),
        size: resultArtifact.bytes.length,
      },
      references: [
        `worker:${workerId}`,
        `task:${taskId}`,
        `task:${taskId}:attempt:${attemptId}`,
        `input:${taskId}:${inputId}`,
        `artifact:${taskId}:${resultArtifact.artifact.id}`,
      ],
    };
  } catch (error) {
    if (taskId) {
      try {
        const { task } = await client.getTask(taskId);
        if (!TERMINAL_TASK_STATUSES.has(task.status)) {
          await client.manageTask(taskId, 'cancel', {
            reason: 'Cleaning up failed large input resume acceptance exercise',
          });
        }
      } catch {
        // Preserve the exercise failure; the Worker link may still be disconnected.
      }
    }
    return {
      version: 1,
      exercise: 'largeInputResume',
      ok: false,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      taskId,
      attemptId,
      inputId,
      error: error.message,
      references: taskId ? [`worker:${workerId}`, `task:${taskId}`] : [`worker:${workerId}`],
    };
  }
}

export async function runBackupRestoreExercise(client, options = {}) {
  const workerId = String(options.workerId || '').trim();
  if (!workerId) {
    throw new Error('Backup restore exercise requires a workerId');
  }
  const sourceDataDir = String(options.sourceDataDir || '').trim();
  const backupDir = String(options.backupDir || '').trim();
  const restoredDataDir = String(options.restoredDataDir || '').trim();
  if (!sourceDataDir || !backupDir || !restoredDataDir) {
    throw new Error('Backup restore exercise requires sourceDataDir, backupDir, and restoredDataDir');
  }
  const timeoutMs = Math.max(60_000, Number(options.timeoutMs || 600_000));
  const marker = crypto.randomBytes(16).toString('hex');
  const startedAt = Date.now();
  let markerTaskId = null;
  let postRestoreTaskId = null;
  let originalRuntime = null;

  try {
    const [initialHealth, initialStatus, capabilities, workerResult] = await Promise.all([
      client.health(),
      client.status(),
      client.capabilities(),
      client.getWorker(workerId),
    ]);
    originalRuntime = initialHealth.runtime || null;
    if (!originalRuntime?.instanceId || initialStatus.runtime?.instanceId !== originalRuntime.instanceId) {
      throw new Error('Control health/status do not expose one consistent runtime instance identity');
    }
    if (initialStatus.storage?.backend !== 'sqlite') {
      throw new Error(`Backup restore exercise requires SQLite; backend=${initialStatus.storage?.backend || '-'}`);
    }
    if (!capabilities.features?.verifiedOfflineBackupRestore || !capabilities.features?.verifiedRestoreReceipts) {
      throw new Error('Control plane does not advertise verified backup/restore receipts');
    }
    const initialWorker = workerResult.worker;
    if (!initialWorker.active || initialWorker.adminState !== 'enabled' || initialWorker.gatewayState === 'offline') {
      throw new Error(`Worker ${workerId} is not active and enabled`);
    }

    const markerPath = 'backup-restore-marker.json';
    const markerCommand = [
      "const fs=require('fs');",
      `const body={marker:'${marker}',attemptId:process.env.NADO_ATTEMPT_ID,workerId:process.env.NADO_WORKER_ID};`,
      `fs.writeFileSync('${markerPath}',JSON.stringify(body));`,
      "console.log('nado-backup-marker-complete');",
    ].join('');
    const createdMarker = await client.createTask({
      title: 'nado backup restore pre-backup marker',
      type: 'shell',
      workerId,
      requireRoutable: true,
      keepWorkspace: false,
      maxAttempts: 1,
      artifactPolicy: { include: [markerPath] },
      command: `node -e "${markerCommand}"`,
    });
    markerTaskId = createdMarker.task.id;
    const markerTask = await waitForTerminalTask(client, markerTaskId, workerId, timeoutMs);
    if (markerTask.status !== 'succeeded' || markerTask.attempts?.length !== 1) {
      throw new Error(`Pre-backup marker task ended ${markerTask.status}`);
    }
    const markerArtifact = await downloadRequiredArtifact(client, markerTask, markerPath);
    let markerPayload;
    try {
      markerPayload = JSON.parse(markerArtifact.bytes.toString('utf8'));
    } catch {
      throw new Error('Pre-backup marker artifact is not valid JSON');
    }
    if (
      markerPayload.marker !== marker
      || markerPayload.workerId !== workerId
      || markerPayload.attemptId !== markerTask.attempts[0].id
    ) {
      throw new Error('Pre-backup marker artifact identity is invalid');
    }
    const markerSha256 = crypto.createHash('sha256').update(markerArtifact.bytes).digest('hex');
    const restoreRequestedAt = new Date().toISOString();
    options.onProgress?.({
      phase: 'backup_restore_now',
      workerId,
      markerTaskId,
      originalInstanceId: originalRuntime.instanceId,
      sourceDataDir,
      backupDir,
      restoredDataDir,
      message: `Stop the VM control service now; create and verify an offline SQLite backup from ${sourceDataDir} into ${backupDir}, restore it into the new path ${restoredDataDir}, then restart control on the same URL using only the restored path`,
    });

    const restart = await waitForControlRestart(
      client,
      originalRuntime.instanceId,
      timeoutMs,
      options.onProgress,
    );
    options.onProgress?.({
      phase: 'restored_control_started',
      workerId,
      markerTaskId,
      originalInstanceId: originalRuntime.instanceId,
      restartedInstanceId: restart.health.runtime.instanceId,
      message: `A new control instance ${restart.health.runtime.instanceId} is online; validating its restore receipt, marker history, and Worker heartbeat`,
    });
    const recovery = await waitForRestoredControl(
      client,
      markerTaskId,
      workerId,
      initialStatus.storage?.restoreReceipt?.id || null,
      restoreRequestedAt,
      restart.health.runtime.startedAt,
      timeoutMs,
    );
    if (!/^[a-f0-9]{64}$/.test(recovery.receipt.manifestSha256 || '')) {
      throw new Error('Restored control receipt is missing a verified backup manifest SHA-256');
    }
    const restoredMarkerArtifact = await downloadRequiredArtifact(client, recovery.task, markerPath);
    const restoredMarkerSha256 = crypto.createHash('sha256').update(restoredMarkerArtifact.bytes).digest('hex');
    if (restoredMarkerSha256 !== markerSha256 || restoredMarkerArtifact.bytes.toString('utf8') !== markerArtifact.bytes.toString('utf8')) {
      throw new Error('Restored pre-backup artifact bytes do not match the source control state');
    }

    const postPath = 'backup-restore-post.json';
    const postCommand = [
      "const fs=require('fs');",
      `const body={receiptId:'${recovery.receipt.id}',marker:'${marker}',attemptId:process.env.NADO_ATTEMPT_ID,workerId:process.env.NADO_WORKER_ID};`,
      `fs.writeFileSync('${postPath}',JSON.stringify(body));`,
    ].join('');
    const createdPost = await client.createTask({
      title: 'nado backup restore post-restore write probe',
      type: 'shell',
      workerId,
      requireRoutable: true,
      keepWorkspace: false,
      maxAttempts: 1,
      artifactPolicy: { include: [postPath] },
      command: `node -e "${postCommand}"`,
    });
    postRestoreTaskId = createdPost.task.id;
    const postTask = await waitForTerminalTask(client, postRestoreTaskId, workerId, timeoutMs);
    if (postTask.status !== 'succeeded' || postTask.attempts?.length !== 1) {
      throw new Error(`Post-restore write probe ended ${postTask.status}`);
    }
    const postArtifact = await downloadRequiredArtifact(client, postTask, postPath);
    let postPayload;
    try {
      postPayload = JSON.parse(postArtifact.bytes.toString('utf8'));
    } catch {
      throw new Error('Post-restore write probe artifact is not valid JSON');
    }
    if (
      postPayload.receiptId !== recovery.receipt.id
      || postPayload.marker !== marker
      || postPayload.workerId !== workerId
      || postPayload.attemptId !== postTask.attempts[0].id
    ) {
      throw new Error('Post-restore write probe identity is invalid');
    }

    return {
      version: 1,
      exercise: 'backupRestore',
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      controlRestart: {
        original: originalRuntime,
        restarted: restart.health.runtime,
        outageObserved: true,
        unavailableObservations: restart.unavailable,
      },
      restoreReceipt: recovery.receipt,
      workerRecovery: {
        recoveredAt: recovery.recoveredAt,
        lastSeenAt: recovery.worker.lastSeenAt || null,
        ageMs: recovery.worker.ageMs,
      },
      markerTask: {
        id: markerTaskId,
        attemptId: markerTask.attempts[0].id,
        artifactId: restoredMarkerArtifact.artifact.id,
        artifactSha256: restoredMarkerSha256,
      },
      postRestoreTask: {
        id: postRestoreTaskId,
        attemptId: postTask.attempts[0].id,
        artifactId: postArtifact.artifact.id,
        artifactSha256: crypto.createHash('sha256').update(postArtifact.bytes).digest('hex'),
      },
      references: [
        `worker:${workerId}`,
        `control:${originalRuntime.instanceId}`,
        `control:${restart.health.runtime.instanceId}`,
        `restore:${recovery.receipt.id}`,
        `backup-manifest-sha256:${recovery.receipt.manifestSha256}`,
        `task:${markerTaskId}`,
        `artifact:${markerTaskId}:${restoredMarkerArtifact.artifact.id}`,
        `task:${postRestoreTaskId}`,
        `artifact:${postRestoreTaskId}:${postArtifact.artifact.id}`,
      ],
    };
  } catch (error) {
    if (postRestoreTaskId) {
      try {
        const { task } = await client.getTask(postRestoreTaskId);
        if (!TERMINAL_TASK_STATUSES.has(task.status)) {
          await client.manageTask(postRestoreTaskId, 'cancel', {
            reason: 'Cleaning up failed backup restore acceptance exercise',
          });
        }
      } catch {
        // Preserve the exercise failure; the control service may still be offline.
      }
    }
    return {
      version: 1,
      exercise: 'backupRestore',
      ok: false,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      markerTaskId,
      postRestoreTaskId,
      originalRuntime,
      error: error.message,
      references: [
        `worker:${workerId}`,
        ...(markerTaskId ? [`task:${markerTaskId}`] : []),
        ...(postRestoreTaskId ? [`task:${postRestoreTaskId}`] : []),
      ],
    };
  }
}

export async function runAgentCollaborationExercise(client, options = {}) {
  const workerId = String(options.workerId || '').trim();
  if (!workerId) {
    throw new Error('Agent collaboration exercise requires a workerId');
  }
  const timeoutMs = Math.max(30_000, Number(options.timeoutMs || 180_000));
  const startedAt = Date.now();
  const taskIds = [];
  let sessionId = null;
  let sessionClosed = false;

  try {
    const { worker } = await client.getWorker(workerId);
    if (!worker.active || worker.adminState !== 'enabled' || worker.gatewayState === 'offline') {
      throw new Error(`Worker ${workerId} is not active and enabled`);
    }
    const agent = worker.readiness?.agent || {};
    if (!agent.realTerminalAgent || !agent.readyForAgentTasks || agent.selfTest?.status !== 'succeeded') {
      throw new Error(
        `Worker ${workerId} does not have a verified real terminal Agent; run doctor --agent-self-test first`,
      );
    }

    const marker = `NADO-COLLAB-${crypto.randomUUID()}`;
    const { session } = await client.createSession({
      title: `Nado cross-site Agent collaboration ${marker.slice(-8)}`,
      workerId,
      requiredCapabilities: ['agent'],
    });
    sessionId = session.id;

    const firstCreated = await client.createTask({
      title: 'Nado Agent collaboration plan',
      type: 'agent',
      sessionId,
      requireRoutable: true,
      timeoutMs,
      maxAttempts: 1,
      artifactPolicy: { include: ['agent-plan.md'] },
      prompt: [
        'This is a Nado cross-site acceptance exercise on the current Worker.',
        'Inspect the current workspace/runtime briefly, then create UTF-8 file agent-plan.md.',
        'The file must contain the following two exact lines plus one short useful execution plan:',
        'NADO_AGENT_COLLABORATION_PLAN',
        marker,
        'Do not only describe the file; create it in the current workspace.',
      ].join('\n'),
    });
    taskIds.push(firstCreated.task.id);
    const firstTask = await waitForTerminalTask(client, firstCreated.task.id, workerId, timeoutMs);
    if (firstTask.status !== 'succeeded' || firstTask.assignedWorkerId !== workerId) {
      throw new Error(
        `First Agent turn ended status=${firstTask.status} on worker=${firstTask.assignedWorkerId || '-'}`,
      );
    }
    const plan = await downloadRequiredArtifact(client, firstTask, 'agent-plan.md');
    const planText = plan.bytes.toString('utf8');
    if (!planText.includes('NADO_AGENT_COLLABORATION_PLAN') || !planText.includes(marker)) {
      throw new Error('First Agent turn artifact is missing the required collaboration marker');
    }

    const secondCreated = await client.createTask({
      title: 'Nado Agent collaboration review and handoff',
      type: 'agent',
      sessionId,
      requireRoutable: true,
      timeoutMs,
      maxAttempts: 1,
      artifactPolicy: {
        include: ['agent-final.md', '.nado-session/transcript.md'],
      },
      prompt: [
        'Continue the same Nado acceptance session.',
        'Read agent-plan.md created by the previous Agent turn and review the prior transcript.',
        'Create UTF-8 file agent-final.md containing the exact line NADO_AGENT_COLLABORATION_OK,',
        'then copy the exact NADO-COLLAB marker from agent-plan.md into the file and add a short review.',
        'Do not only describe the file; create it in the current workspace.',
      ].join('\n'),
    });
    taskIds.push(secondCreated.task.id);
    const secondTask = await waitForTerminalTask(client, secondCreated.task.id, workerId, timeoutMs);
    if (secondTask.status !== 'succeeded' || secondTask.assignedWorkerId !== workerId) {
      throw new Error(
        `Second Agent turn ended status=${secondTask.status} on worker=${secondTask.assignedWorkerId || '-'}`,
      );
    }
    const final = await downloadRequiredArtifact(client, secondTask, 'agent-final.md');
    const transcript = await downloadRequiredArtifact(client, secondTask, '.nado-session/transcript.md');
    const finalText = final.bytes.toString('utf8');
    const transcriptText = transcript.bytes.toString('utf8');
    if (!finalText.includes('NADO_AGENT_COLLABORATION_OK') || !finalText.includes(marker)) {
      throw new Error('Second Agent turn did not carry the prior plan marker into agent-final.md');
    }
    if (!transcriptText.includes('NADO_AGENT_COLLABORATION_PLAN')) {
      throw new Error('Session transcript does not contain the first Agent turn prompt');
    }

    const closed = await client.closeSession(sessionId);
    sessionClosed = closed.session?.status === 'closed';
    if (!sessionClosed) {
      throw new Error(`Agent collaboration session did not close cleanly; status=${closed.session?.status || 'unknown'}`);
    }

    return {
      version: 1,
      exercise: 'agentCollaboration',
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      sessionId,
      sessionStatus: 'closed',
      taskIds,
      tasks: [firstTask, secondTask].map((task) => ({
        id: task.id,
        status: task.status,
        assignedWorkerId: task.assignedWorkerId,
        attemptId: task.attempts?.at(-1)?.id || null,
      })),
      artifacts: [
        { taskId: firstTask.id, id: plan.artifact.id, path: plan.artifact.path, sha256: plan.artifact.sha256, size: plan.bytes.length },
        { taskId: secondTask.id, id: final.artifact.id, path: final.artifact.path, sha256: final.artifact.sha256, size: final.bytes.length },
        { taskId: secondTask.id, id: transcript.artifact.id, path: transcript.artifact.path, sha256: transcript.artifact.sha256, size: transcript.bytes.length },
      ],
      markerSha256: crypto.createHash('sha256').update(marker).digest('hex'),
      references: [
        `worker:${workerId}`,
        `session:${sessionId}`,
        `task:${firstTask.id}`,
        `task:${secondTask.id}`,
        `artifact:${firstTask.id}:${plan.artifact.id}`,
        `artifact:${secondTask.id}:${final.artifact.id}`,
        `artifact:${secondTask.id}:${transcript.artifact.id}`,
      ],
    };
  } catch (error) {
    for (const taskId of taskIds) {
      try {
        const { task } = await client.getTask(taskId);
        if (!TERMINAL_TASK_STATUSES.has(task.status)) {
          await client.manageTask(taskId, 'cancel', {
            reason: 'Cleaning up failed Agent collaboration acceptance exercise',
          });
        }
      } catch {
        // Preserve the exercise failure; task history remains available for diagnosis.
      }
    }
    if (sessionId && !sessionClosed) {
      try {
        await client.closeSession(sessionId);
      } catch {
        // Preserve the original exercise failure.
      }
    }
    return {
      version: 1,
      exercise: 'agentCollaboration',
      ok: false,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workerId,
      sessionId,
      taskIds,
      error: error.message,
      references: [
        ...(sessionId ? [`session:${sessionId}`] : []),
        ...taskIds.map((taskId) => `task:${taskId}`),
      ],
    };
  }
}
