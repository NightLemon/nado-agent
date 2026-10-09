import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { NadoClient } from './http-client.js';
import { runTask } from './task-runner.js';
import { collectInventory } from './inventory.js';
import { getRuntimeBuildInfo } from './runtime-build.js';
import { collectWorkerMetrics, createHostUsageSampler } from './worker-metrics.js';
import {
  measureControlBandwidth,
  normalizeNetworkProbeBytes,
  normalizeNetworkProbeIntervalMs,
} from './network-probe.js';
import { sleep } from './utils.js';
import { probeControlClock } from './clock-skew.js';

function normalizeConcurrency(value) {
  return Math.max(1, Number(value || 1));
}

function normalizeCredentialRotationIntervalMs(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.max(1_000, Math.floor(parsed));
}

export function reconnectDelay(attempt, options = {}) {
  const baseMs = Math.max(100, Number(options.baseMs || 1_000));
  const maxMs = Math.max(baseMs, Number(options.maxMs || 30_000));
  const jitterRatio = Math.min(1, Math.max(0, Number(options.jitterRatio ?? 0.2)));
  const sequence = Math.max(0, Math.floor(Number(attempt || 1)) - 1);
  const exponentialMs = Math.min(maxMs, baseMs * (2 ** Math.min(sequence, 20)));
  const random = typeof options.random === 'function' ? options.random() : Math.random();
  const jitter = 1 + ((Math.min(1, Math.max(0, random)) * 2) - 1) * jitterRatio;
  return Math.max(100, Math.round(exponentialMs * jitter));
}

function retryableCompletionDeliveryError(error) {
  const status = Number(error?.status || 0);
  return !status || status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

const COMPLETION_REJECTION_EVENTS = new Set([
  'late_result_ignored',
  'expired_lease_result_ignored',
  'stale_result_ignored',
]);

const COMPLETION_ACCEPTANCE_EVENTS = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'retry_scheduled',
]);

function completionEventMatchesAttempt(event, attemptId) {
  return event?.data?.resultAttemptId === attemptId || event?.data?.attemptId === attemptId;
}

export async function reportTaskCompletionWithRetry(client, task, result, options = {}) {
  const maxRetries = Math.max(1, Number(
    options.maxRetries || process.env.NADO_WORKER_COMPLETION_RETRIES || 16,
  ));
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await client.completeTask(task.id, {
        ...result,
        attemptId: task.currentAttemptId,
      });
      const gatewayTask = response.task;
      const matchingEvents = (gatewayTask?.events || [])
        .filter((event) => completionEventMatchesAttempt(event, task.currentAttemptId));
      const latestEvent = matchingEvents.at(-1) || null;
      // A response can be lost after the gateway commits the result. In that case the retry
      // receives late_result_ignored, but the earlier terminal/retry event proves this attempt
      // was already accepted. This makes completion delivery idempotent from the Worker's view.
      const acceptedPreviously = matchingEvents.some((event) => COMPLETION_ACCEPTANCE_EVENTS.has(event.type));
      const accepted = acceptedPreviously || !COMPLETION_REJECTION_EVENTS.has(latestEvent?.type);
      return {
        response,
        attempts: attempt,
        accepted,
        rejectionEvent: accepted ? null : latestEvent || null,
      };
    } catch (error) {
      lastError = error;
      if (!retryableCompletionDeliveryError(error) || attempt === maxRetries) {
        error.deliveryAttempts = attempt;
        throw error;
      }
      const retryMs = reconnectDelay(attempt, {
        baseMs: options.retryBaseMs || process.env.NADO_WORKER_COMPLETION_RETRY_BASE_MS || 250,
        maxMs: options.retryMaxMs || process.env.NADO_WORKER_COMPLETION_RETRY_MAX_MS || 5_000,
        jitterRatio: options.jitterRatio,
      });
      options.onRetry?.({ attempt, maxRetries, retryMs, error });
      await sleep(retryMs);
    }
  }
  throw lastError || new Error(`Task completion delivery failed for ${task.id}`);
}

export async function reportWorkerEventWithRetry(client, workerId, input, options = {}) {
  const event = {
    ...input,
    id: String(input?.id || '').trim()
      || `wev_${crypto.randomBytes(16).toString('hex')}`,
  };
  const maxRetries = Math.max(1, Number(
    options.maxRetries || process.env.NADO_WORKER_EVENT_RETRIES || 8,
  ));
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await client.addWorkerEvent(workerId, event);
      return { response, attempts: attempt, eventId: event.id };
    } catch (error) {
      lastError = error;
      if (!retryableCompletionDeliveryError(error) || attempt === maxRetries) {
        error.deliveryAttempts = attempt;
        throw error;
      }
      const retryMs = reconnectDelay(attempt, {
        baseMs: options.retryBaseMs || process.env.NADO_WORKER_EVENT_RETRY_BASE_MS || 250,
        maxMs: options.retryMaxMs || process.env.NADO_WORKER_EVENT_RETRY_MAX_MS || 5_000,
        jitterRatio: options.jitterRatio,
      });
      options.onRetry?.({ attempt, maxRetries, retryMs, error, eventId: event.id });
      await sleep(retryMs);
    }
  }
  throw lastError || new Error(`Worker event delivery failed for ${workerId}`);
}

export async function reportTaskEventWithRetry(client, task, input, options = {}) {
  const event = {
    ...input,
    id: String(input?.id || '').trim()
      || `tev_${crypto.randomBytes(16).toString('hex')}`,
  };
  const maxRetries = Math.max(1, Number(
    options.maxRetries || process.env.NADO_TASK_EVENT_RETRIES || 8,
  ));
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await client.addTaskEvent(task.id, event);
      return {
        response,
        attempts: attempt,
        eventId: event.id,
        accepted: !response.event?.ignored,
      };
    } catch (error) {
      lastError = error;
      if (!retryableCompletionDeliveryError(error) || attempt === maxRetries) {
        error.deliveryAttempts = attempt;
        throw error;
      }
      const retryMs = reconnectDelay(attempt, {
        baseMs: options.retryBaseMs || process.env.NADO_TASK_EVENT_RETRY_BASE_MS || 250,
        maxMs: options.retryMaxMs || process.env.NADO_TASK_EVENT_RETRY_MAX_MS || 5_000,
        jitterRatio: options.jitterRatio,
      });
      options.onRetry?.({ attempt, maxRetries, retryMs, error, eventId: event.id });
      await sleep(retryMs);
    }
  }
  throw lastError || new Error(`Task event delivery failed for ${task.id}`);
}

export function createOrderedTaskEventReporter(client, task, options = {}) {
  const workerId = String(options.workerId || task.assignedWorkerId || '').trim() || null;
  const configuredMaxPending = Number(
    options.maxPending ?? process.env.NADO_TASK_EVENT_MAX_PENDING ?? 256,
  );
  const maxPending = Number.isFinite(configuredMaxPending)
    ? Math.max(1, Math.min(10_000, Math.floor(configuredMaxPending)))
    : 256;
  let sequence = 0;
  let pendingCount = 0;
  let tail = Promise.resolve();
  let gap = null;
  let deliveryUnavailable = false;

  const recordGap = (entry) => {
    gap ??= {
      firstSequence: entry.sequence,
      lastSequence: entry.sequence,
      eventCount: 0,
      byteCount: 0,
      reasons: new Set(),
    };
    gap.lastSequence = entry.sequence;
    gap.eventCount += 1;
    gap.byteCount += Buffer.byteLength(String(entry.message || ''), 'utf8');
    gap.reasons.add(entry.reason);
  };

  const send = (input = {}) => {
    sequence += 1;
    const event = {
      ...input,
      id: String(input.id || '').trim() || `tev_${crypto.randomBytes(16).toString('hex')}`,
      workerId: input.workerId || workerId,
      attemptId: input.attemptId || task.currentAttemptId || null,
      data: {
        ...(input.data || {}),
        sequence,
      },
    };
    if (pendingCount >= maxPending) {
      recordGap({ sequence, message: event.message, reason: 'queue_full' });
      return Promise.resolve({ delivered: false, dropped: true, eventId: event.id });
    }
    pendingCount += 1;
    const delivery = tail.then(async () => {
      try {
        if (deliveryUnavailable) {
          recordGap({
            sequence: event.data.sequence,
            message: event.message,
            reason: 'delivery_short_circuited',
          });
          return { delivered: false, shortCircuited: true, eventId: event.id };
        }
        const result = await reportTaskEventWithRetry(client, task, event, {
          maxRetries: options.maxRetries,
          retryBaseMs: options.retryBaseMs,
          retryMaxMs: options.retryMaxMs,
          jitterRatio: options.jitterRatio,
          onRetry: options.onRetry,
        });
        if (!result.accepted) {
          deliveryUnavailable = true;
          recordGap({ sequence: event.data.sequence, message: event.message, reason: 'rejected' });
        }
        return { ...result, delivered: result.accepted };
      } catch (error) {
        deliveryUnavailable = true;
        recordGap({ sequence: event.data.sequence, message: event.message, reason: 'delivery_failed' });
        return { delivered: false, error, eventId: event.id };
      } finally {
        pendingCount -= 1;
      }
    });
    tail = delivery.then(() => undefined);
    return delivery;
  };

  const flush = async () => {
    await tail;
    if (!gap) {
      return { delivered: true, gap: null };
    }
    const summary = gap;
    gap = null;
    const event = {
      id: `tev_${crypto.randomBytes(16).toString('hex')}`,
      type: 'output_delivery_gap',
      message: `Worker could not persist ${summary.eventCount} live task event(s); terminal output remains in the task result`,
      workerId,
      attemptId: task.currentAttemptId || null,
      data: {
        sequence: sequence + 1,
        firstMissingSequence: summary.firstSequence,
        lastMissingSequence: summary.lastSequence,
        missingEventCount: summary.eventCount,
        missingByteCount: summary.byteCount,
        reasons: [...summary.reasons].sort(),
      },
    };
    sequence += 1;
    try {
      const delivery = await reportTaskEventWithRetry(client, task, event, {
        maxRetries: options.maxRetries,
        retryBaseMs: options.retryBaseMs,
        retryMaxMs: options.retryMaxMs,
        jitterRatio: options.jitterRatio,
        onRetry: options.onRetry,
      });
      return { delivered: delivery.accepted, gap: event, delivery };
    } catch (error) {
      return { delivered: false, gap: event, error };
    }
  };

  return {
    send,
    flush,
    get pendingCount() {
      return pendingCount;
    },
  };
}

export async function uploadArtifactFile(client, task, artifact, options = {}) {
  const chunkBytes = Math.max(64 * 1024, Math.min(
    16 * 1024 * 1024,
    Number(options.chunkBytes || process.env.NADO_ARTIFACT_CHUNK_BYTES || 4 * 1024 * 1024),
  ));
  const maxRetries = Math.max(1, Number(options.maxRetries || 8));
  const created = await client.createArtifactUpload(task.id, artifact, task.currentAttemptId);
  const uploadId = created.upload.id;
  let offset = Number(created.upload.committedBytes || 0);
  const handle = await fs.open(artifact.localPath, 'r');
  try {
    while (offset < artifact.size) {
      const length = Math.min(chunkBytes, artifact.size - offset);
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(bytes, 0, length, offset);
      if (bytesRead !== length) {
        throw new Error(`Artifact changed or ended during upload: ${artifact.path}`);
      }
      let delivered = false;
      let lastError = null;
      for (let attempt = 1; attempt <= maxRetries && !delivered; attempt += 1) {
        try {
          const response = await client.uploadArtifactChunk(
            task.id,
            uploadId,
            task.currentAttemptId,
            offset,
            bytes,
          );
          offset = Number(response.upload.committedBytes);
          delivered = true;
        } catch (error) {
          lastError = error;
          if ([400, 403, 404, 413, 422].includes(error.status)) {
            throw error;
          }
          try {
            const status = await client.getArtifactUpload(task.id, uploadId, task.currentAttemptId);
            const committed = Number(status.upload.committedBytes || 0);
            if (committed !== offset) {
              offset = committed;
              delivered = true;
              break;
            }
          } catch (statusError) {
            if ([400, 403, 404, 413, 422].includes(statusError.status)) {
              throw statusError;
            }
          }
          if (attempt < maxRetries) {
            await sleep(reconnectDelay(attempt, {
              baseMs: options.retryBaseMs || 250,
              maxMs: options.retryMaxMs || 5_000,
            }));
          }
        }
      }
      if (!delivered) {
        throw lastError || new Error(`Artifact chunk upload failed: ${artifact.path}`);
      }
    }
  } finally {
    await handle.close();
  }

  let finalized;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      finalized = await client.finalizeArtifactUpload(task.id, uploadId, task.currentAttemptId);
      break;
    } catch (error) {
      if ([400, 403, 404, 413, 422].includes(error.status) || attempt === maxRetries) {
        throw error;
      }
      await sleep(reconnectDelay(attempt, {
        baseMs: options.retryBaseMs || 250,
        maxMs: options.retryMaxMs || 5_000,
      }));
    }
  }
  return {
    path: artifact.path,
    size: artifact.size,
    sha256: artifact.sha256,
    uploadId: finalized.upload.id,
  };
}

async function prepareArtifactsForCompletion(client, task, artifacts, options = {}) {
  const prepared = [];
  for (const artifact of artifacts || []) {
    if (artifact.localPath && !artifact.skipped) {
      prepared.push(await uploadArtifactFile(client, task, artifact, options));
    } else {
      const { localPath, transfer, ...inlineArtifact } = artifact;
      prepared.push(inlineArtifact);
    }
  }
  return prepared;
}

async function fileSize(file) {
  try {
    return (await fs.stat(file)).size;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function downloadTaskInputFile(client, task, input, target, options = {}) {
  const inputId = input.inputUploadId || input.sourceArtifactId;
  if (!inputId) {
    throw new Error(`Remote task input has no download reference: ${input.path}`);
  }
  const expectedSize = Number(input.size || 0);
  const expectedSha256 = String(input.sha256 || '').toLowerCase();
  const part = `${target}.nado-input.part`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  let offset = await fileSize(part);
  if (offset > expectedSize) {
    await fs.truncate(part, 0);
    offset = 0;
  }
  if (!offset && expectedSize === 0) {
    await fs.writeFile(part, Buffer.alloc(0));
  }
  const maxRetries = Math.max(1, Number(options.maxRetries || 8));
  let failures = 0;
  while (offset < expectedSize) {
    try {
      const response = await client.streamTaskInput(
        task.id,
        inputId,
        task.currentAttemptId,
        offset,
        { signal: options.signal },
      );
      if (response.size !== expectedSize || (response.sha256 && response.sha256 !== expectedSha256)) {
        throw new Error(`Task input metadata changed during download: ${input.path}`);
      }
      const rangeStart = Number(response.range?.match(/^bytes (\d+)-/)?.[1] ?? offset);
      if (rangeStart !== offset) {
        throw new Error(`Task input range mismatch: expected ${offset}, received ${rangeStart}`);
      }
      const handle = await fs.open(part, 'a');
      let received = 0;
      try {
        for await (const value of response.body) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          await handle.write(chunk);
          received += chunk.length;
        }
      } finally {
        await handle.close();
      }
      const nextOffset = await fileSize(part);
      if (nextOffset <= offset && expectedSize > offset) {
        throw new Error(`Task input download made no progress: ${input.path}`);
      }
      if (nextOffset > expectedSize) {
        await fs.truncate(part, offset);
        throw new Error(`Task input download exceeded declared size: ${input.path}`);
      }
      offset = nextOffset;
      failures = 0;
    } catch (error) {
      offset = await fileSize(part);
      failures += 1;
      if (options.signal?.aborted || [400, 401, 403, 404, 416].includes(error.status) || failures >= maxRetries) {
        throw error;
      }
      await sleep(reconnectDelay(failures, {
        baseMs: options.retryBaseMs || 250,
        maxMs: options.retryMaxMs || 5_000,
      }));
    }
  }
  const actualSha256 = await sha256File(part);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || actualSha256 !== expectedSha256) {
    await fs.rm(part, { force: true });
    throw new Error(`Task input SHA-256 mismatch after download: ${input.path}`);
  }
  await fs.rm(target, { force: true });
  await fs.rename(part, target);
  return target;
}

export async function startWorker(options) {
  const client = options.client || new NadoClient({
    controlUrl: options.controlUrl,
    token: options.token,
    workerId: options.privateKeyPem ? options.id : null,
    privateKeyPem: options.privateKeyPem || null,
  });

  const startupClock = await probeControlClock(client);
  if (startupClock.clock.status === 'failed') {
    const error = new Error(
      `Control/Worker clock skew is unsafe for signed requests: offset=${startupClock.clock.offsetMs}ms, uncertainty=${startupClock.clock.uncertaintyMs}ms, allowed=${startupClock.clock.maxClockSkewMs}ms. Synchronize NTP/Windows Time before starting the Worker.`,
    );
    error.code = 'NADO_WORKER_CLOCK_SKEW';
    error.clock = startupClock.clock;
    throw error;
  }

  let inventory = await collectInventory(options.capabilities || []);
  const build = options.buildInfo || await getRuntimeBuildInfo();
  const maxConcurrency = normalizeConcurrency(options.maxConcurrency);
  const runtime = {
    id: options.runtimeId || `wrun_${crypto.randomBytes(16).toString('hex')}`,
    startedAt: options.runtimeStartedAt || new Date().toISOString(),
    pid: process.pid,
    build,
  };
  const worker = {
    id: options.id,
    name: options.name || options.id,
    host: os.hostname(),
    capabilities: inventory.inferredCapabilities,
    labels: options.labels || {},
    agentCommandConfigured: Boolean(options.agentCommand),
    agentPreset: options.agentPreset || null,
    credentialRotationConfigured: typeof options.rotateCredentials === 'function',
    maxConcurrency,
    inventory,
    runtime,
  };

  await client.registerWorker(worker);

  const emitLog = (type, message, details = {}) => {
    options.onLog?.(message);
    const event = {
      id: details.id || `wev_${crypto.randomBytes(16).toString('hex')}`,
      type,
      level: details.level || 'info',
      message,
      data: details.data,
    };
    const delivery = details.retry
      ? reportWorkerEventWithRetry(client, worker.id, event, {
        maxRetries: options.workerEventRetries,
        retryBaseMs: options.workerEventRetryBaseMs || options.reconnectBaseMs,
        retryMaxMs: options.workerEventRetryMaxMs || options.reconnectMaxMs,
        jitterRatio: options.reconnectJitterRatio,
      })
      : client.addWorkerEvent(worker.id, event);
    return delivery.catch(() => null);
  };

  emitLog('registered', `registered ${worker.id} (${worker.capabilities.join(',') || 'no capabilities'}; maxConcurrency=${maxConcurrency})`, {
    data: {
      capabilities: worker.capabilities,
      labels: worker.labels,
      inventory,
      maxConcurrency,
      runtime,
    },
  });

  let stopped = false;
  let adminState = 'enabled';
  let consecutiveErrors = 0;
  let controlHealth = {
    roundTripMs: null,
    lastSuccessAt: null,
    lastErrorAt: null,
  };
  const networkProbeBytes = normalizeNetworkProbeBytes(
    options.networkProbeBytes ?? process.env.NADO_NETWORK_PROBE_BYTES,
  );
  const networkProbeIntervalMs = normalizeNetworkProbeIntervalMs(
    options.networkProbeIntervalMs ?? process.env.NADO_NETWORK_PROBE_INTERVAL_MS,
  );
  let nextNetworkProbeAt = 0;
  let networkBandwidth = {
    available: false,
    error: networkProbeIntervalMs ? 'not_measured' : 'disabled',
  };
  const hostUsageSampler = options.hostUsageSampler || createHostUsageSampler();
  const runningTasks = new Map();
  let claimController = null;
  const deferredCredentialRotationCommands = new Set();
  const credentialRotationIntervalMs = normalizeCredentialRotationIntervalMs(
    options.credentialRotationIntervalMs,
  );
  let nextCredentialRotationAt = credentialRotationIntervalMs
    ? Date.now() + credentialRotationIntervalMs
    : Number.POSITIVE_INFINITY;

  const stop = () => {
    stopped = true;
    claimController?.abort();
    for (const running of runningTasks.values()) {
      running.controller.abort();
    }
  };

  const handleCommands = async (commands = []) => {
    for (const command of commands) {
      try {
        if (command.action === 'pause') {
          adminState = 'paused';
        } else if (command.action === 'resume') {
          adminState = 'enabled';
        } else if (command.action === 'drain') {
          adminState = 'draining';
        } else if (command.action === 'shutdown') {
          adminState = 'shutdown_requested';
          stopped = true;
        } else if (command.action === 'cancel_current') {
          if (command.taskId) {
            runningTasks.get(command.taskId)?.controller.abort();
          } else {
            for (const running of runningTasks.values()) {
              running.controller.abort();
            }
          }
        } else if (command.action === 'rotate_token') {
          const rotation = await rotateCredentials({ force: true });
          if (!rotation.performed && rotation.reason === 'worker_busy') {
            if (!deferredCredentialRotationCommands.has(command.id)) {
              deferredCredentialRotationCommands.add(command.id);
              emitLog('worker_token_rotation_deferred', 'Credential rotation deferred until running tasks finish', {
                data: { commandId: command.id, runningTaskIds: [...runningTasks.keys()] },
              });
            }
            continue;
          }
          if (!rotation.performed) {
            throw new Error(rotation.reason || 'Worker credential rotation is not configured');
          }
          deferredCredentialRotationCommands.delete(command.id);
          if (!rotation.result?.verification?.passed) {
            throw new Error(rotation.result?.verification?.reason || 'Credential rotated, but predecessor rejection was not verified');
          }
          command.result = {
            workerTokenId: rotation.result.identity.workerTokenId,
            previousTokenId: rotation.result.identity.lastTokenRotation?.fromTokenId || null,
            confirmedAt: rotation.result.identity.lastTokenRotation?.confirmedAt || null,
            verification: rotation.result.verification,
          };
        }
        await client.acknowledgeCommand(
          worker.id,
          command.id,
          'completed',
          `applied ${command.action}`,
          command.result || null,
        );
        emitLog('command_applied', `management command ${command.action} applied`, {
          data: {
            commandId: command.id,
            action: command.action,
            taskId: command.taskId || null,
          },
        });
      } catch (error) {
        await client.acknowledgeCommand(worker.id, command.id, 'failed', error.message);
        emitLog('command_failed', `management command ${command.action} failed: ${error.message}`, {
          level: 'error',
          data: {
            commandId: command.id,
            action: command.action,
          },
        });
      }
    }
  };

  const heartbeat = async () => {
    const currentTaskIds = [...runningTasks.keys()];
    const taskLeases = [...runningTasks.values()].map(({ task }) => ({
      taskId: task.id,
      attemptId: task.currentAttemptId,
    }));
    const observedState = currentTaskIds.length ? 'running' : adminState === 'enabled' ? 'idle' : adminState;
    const metrics = await collectWorkerMetrics({
      dataDir: options.dataDir,
      hostUsageSampler,
      control: {
        ...controlHealth,
        consecutiveErrors,
        bandwidth: networkBandwidth,
      },
    });
    const startedAt = performance.now();
    try {
      const result = await client.heartbeat(worker.id, {
        observedState,
        currentTaskId: currentTaskIds[0] || null,
        currentTaskIds,
        taskLeases,
        maxConcurrency,
        metrics,
        inventory,
        runtime,
      });
      controlHealth = {
        roundTripMs: Math.round((performance.now() - startedAt) * 10) / 10,
        lastSuccessAt: new Date().toISOString(),
        lastErrorAt: controlHealth.lastErrorAt,
      };
      adminState = result.worker.adminState || adminState;
      await handleCommands(result.commands);
      return result.worker;
    } catch (error) {
      controlHealth.lastErrorAt = new Date().toISOString();
      throw error;
    }
  };

  const probeNetwork = async () => {
    if (!networkProbeIntervalMs || Date.now() < nextNetworkProbeAt) {
      return;
    }
    nextNetworkProbeAt = Date.now() + networkProbeIntervalMs;
    try {
      networkBandwidth = await measureControlBandwidth(client, worker.id, {
        bytes: networkProbeBytes,
        timeoutMs: options.networkProbeTimeoutMs,
      });
    } catch (error) {
      networkBandwidth = {
        ...networkBandwidth,
        available: false,
        error: error.message,
        lastErrorAt: new Date().toISOString(),
      };
      emitLog('network_probe_failed', `network bandwidth probe failed: ${error.message}`, {
        level: 'warn',
      });
    }
  };

  const rotateCredentials = async ({ force = false } = {}) => {
    if (
      typeof options.rotateCredentials !== 'function'
    ) {
      return { performed: false, reason: 'credential_rotation_not_configured' };
    }
    if (runningTasks.size) {
      return { performed: false, reason: 'worker_busy' };
    }
    if (!force && (!credentialRotationIntervalMs || Date.now() < nextCredentialRotationAt)) {
      return { performed: false, reason: 'not_due' };
    }
    const result = await options.rotateCredentials({
      client,
      workerId: worker.id,
      dataDir: options.dataDir,
      verifyPreviousToken: force,
    });
    if (result?.identity?.workerToken) {
      client.token = result.identity.workerToken;
    }
    nextCredentialRotationAt = credentialRotationIntervalMs
      ? Date.now() + credentialRotationIntervalMs
      : Number.POSITIVE_INFINITY;
    emitLog('worker_token_rotated', `Worker credential rotated to ${result?.identity?.workerTokenId || 'new token'}`, {
      data: {
        workerTokenId: result?.identity?.workerTokenId || null,
        recovered: Boolean(result?.recovered),
        verification: result?.verification || null,
        nextRotationAt: Number.isFinite(nextCredentialRotationAt)
          ? new Date(nextCredentialRotationAt).toISOString()
          : null,
      },
    });
    return { performed: true, result };
  };

  const startClaimedTask = (task) => {
    const controller = new AbortController();
    runningTasks.set(task.id, { task, controller });
    emitLog('task_claimed', `claimed ${task.id}: ${task.title}`, {
      data: {
        taskId: task.id,
        attemptId: task.currentAttemptId,
      },
    });

    const promise = (async () => {
      let completionResult;
      const taskEventReporter = createOrderedTaskEventReporter(client, task, {
        workerId: worker.id,
        maxPending: options.taskEventMaxPending,
        maxRetries: options.taskEventRetries,
        retryBaseMs: options.taskEventRetryBaseMs || options.reconnectBaseMs,
        retryMaxMs: options.taskEventRetryMaxMs || options.reconnectMaxMs,
        jitterRatio: options.reconnectJitterRatio,
      });
      try {
        void taskEventReporter.send({
          type: 'started',
          message: `Worker ${worker.id} started task`,
        });

        const result = await runTask(task, {
          dataDir: options.dataDir || path.resolve('.nado'),
          workerId: worker.id,
          workerRuntimeId: runtime.id,
          workerRuntimeStartedAt: runtime.startedAt,
          agentCommand: options.agentCommand,
          cleanupWorkspaces: Boolean(options.cleanupWorkspaces),
          maxArtifactFileBytes: options.maxArtifactFileBytes,
          maxArtifactTotalBytes: options.maxArtifactTotalBytes,
          maxInlineArtifactBytes: options.maxInlineArtifactBytes,
          maxInlineArtifactTotalBytes: options.maxInlineArtifactTotalBytes,
          maxArtifactFiles: options.maxArtifactFiles,
          downloadInput: (input, target) => downloadTaskInputFile(client, task, input, target, {
            maxRetries: options.inputDownloadRetries,
            retryBaseMs: options.reconnectBaseMs,
            retryMaxMs: options.reconnectMaxMs,
            signal: controller.signal,
          }),
          signal: controller.signal,
          onOutput: (stream, text) => taskEventReporter.send({
            type: stream,
            message: text,
            data: {
              stream,
            },
          }),
        });
        const eventFlush = await taskEventReporter.flush();
        if (eventFlush.gap) {
          emitLog('task_output_delivery_gap', `live output delivery gap for ${task.id}: ${eventFlush.gap.data.missingEventCount} event(s)`, {
            level: 'warning',
            data: {
              taskId: task.id,
              attemptId: task.currentAttemptId,
              delivered: eventFlush.delivered,
              ...eventFlush.gap.data,
            },
          });
        }

        try {
          const artifacts = await prepareArtifactsForCompletion(client, task, result.artifacts, {
            chunkBytes: options.artifactChunkBytes,
            maxRetries: options.artifactUploadRetries
              || options.completionRetries
              || process.env.NADO_WORKER_COMPLETION_RETRIES,
            retryBaseMs: options.completionRetryBaseMs,
            retryMaxMs: options.completionRetryMaxMs,
          });
          let workspaceCleaned = result.workspaceCleaned;
          if (result.cleanupWorkspaceAfterUpload) {
            await fs.rm(result.workspace, { recursive: true, force: true });
            workspaceCleaned = true;
          }
          const { cleanupWorkspaceAfterUpload, ...completed } = result;
          completionResult = {
            ...completed,
            artifacts,
            workspaceCleaned,
          };
        } catch (error) {
          completionResult = {
            status: 'failed',
            exitCode: 1,
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            error: `Artifact preparation or delivery failed: ${error.message}`,
            failureKind: 'worker_error',
            workspace: result.workspace || null,
            workspaceCleaned: Boolean(result.workspaceCleaned),
            artifacts: [],
          };
        }
      } catch (error) {
        completionResult = {
          status: 'failed',
          exitCode: 1,
          stdout: '',
          stderr: '',
          error: error.message,
          failureKind: 'worker_error',
          artifacts: [],
        };
      }

      try {
        const delivery = await reportTaskCompletionWithRetry(client, task, completionResult, {
          maxRetries: options.completionRetries,
          retryBaseMs: options.completionRetryBaseMs,
          retryMaxMs: options.completionRetryMaxMs,
          jitterRatio: options.reconnectJitterRatio,
          onRetry: ({ attempt, maxRetries, retryMs, error }) => {
            emitLog('task_completion_retry', `completion delivery failed for ${task.id}; retrying in ${retryMs}ms`, {
              level: 'warning',
              data: {
                taskId: task.id,
                attemptId: task.currentAttemptId,
                deliveryAttempt: attempt,
                maxDeliveryAttempts: maxRetries,
                retryMs,
                error: error.message,
              },
            });
          },
        });
        const completion = delivery.response;
        const retryScheduled = completion.task?.status === 'queued'
          && completion.task?.events?.some((event) => event.type === 'retry_scheduled');
        if (!delivery.accepted) {
          emitLog('task_completion_rejected', `gateway rejected completion for ${task.id}`, {
            level: 'warning',
            data: {
              taskId: task.id,
              attemptId: task.currentAttemptId,
              gatewayStatus: completion.task?.status || null,
              gatewayAttemptId: completion.task?.currentAttemptId || null,
              rejectionEvent: delivery.rejectionEvent?.type || null,
              deliveryAttempts: delivery.attempts,
            },
          });
        } else {
          if (delivery.attempts > 1) {
            emitLog('task_completion_recovered', `completion delivery recovered for ${task.id} after ${delivery.attempts} attempts`, {
              data: {
                taskId: task.id,
                attemptId: task.currentAttemptId,
                deliveryAttempts: delivery.attempts,
              },
            });
          }
          emitLog(retryScheduled ? 'task_retry_scheduled' : 'task_completed', retryScheduled
            ? `retry scheduled ${task.id}: ${completionResult.failureKind || completionResult.exitCode}`
            : `completed ${task.id}: ${completionResult.status}`, {
            level: retryScheduled || completionResult.status === 'succeeded' ? 'info' : 'error',
            data: {
              taskId: task.id,
              status: completion.task?.status || completionResult.status,
              exitCode: completionResult.exitCode,
              failureKind: completionResult.failureKind || null,
              attemptId: task.currentAttemptId,
              deliveryAttempts: delivery.attempts,
            },
          });
        }
      } catch (error) {
        emitLog('task_completion_delivery_failed', `completion delivery exhausted for ${task.id}: ${error.message}`, {
          level: 'error',
          data: {
            taskId: task.id,
            attemptId: task.currentAttemptId,
            deliveryAttempts: error.deliveryAttempts || null,
            error: error.message,
          },
        });
      } finally {
        await emitLog('task_released', `released task process ${task.id}`, {
          retry: true,
          data: {
            taskId: task.id,
            attemptId: task.currentAttemptId,
          },
        });
        // Keep the task promise visible to Worker shutdown until the child has
        // closed and its critical release evidence has finished delivery.
        runningTasks.delete(task.id);
      }
    })();
    runningTasks.set(task.id, { task, controller, promise });
    return promise;
  };

  const loop = async () => {
    while (!stopped) {
      try {
        await heartbeat();
        consecutiveErrors = 0;
        await rotateCredentials();
        await probeNetwork();
        if (stopped) {
          break;
        }

        const canClaim = adminState === 'enabled' && runningTasks.size < maxConcurrency;
        if (canClaim && Date.now() - Date.parse(inventory.collectedAt) > 60_000) {
          inventory = await collectInventory(options.capabilities || []);
        }
        let usedLongPoll = false;
        while (adminState === 'enabled' && runningTasks.size < maxConcurrency) {
          if (Date.now() - Date.parse(inventory.collectedAt) > 60_000) {
            inventory = await collectInventory(options.capabilities || []);
          }
          const longPollMs = Math.max(0, Math.min(30_000, Number(options.longPollMs ?? 20_000)));
          const waitMs = !options.once && runningTasks.size === 0 ? longPollMs : 0;
          usedLongPoll = waitMs > 0;
          claimController = new AbortController();
          let claimResult;
          try {
            claimResult = await client.claimTask(worker.id, {
              waitMs,
              signal: claimController.signal,
            });
          } finally {
            claimController = null;
          }
          const { task } = claimResult;
          if (task) {
            startClaimedTask(task);
          } else if (options.once) {
            break;
          } else {
            break;
          }
        }

        if (options.once && runningTasks.size === 0) {
          break;
        }

        if (!usedLongPoll) {
          await sleep(options.pollMs || 2_000);
        }
      } catch (error) {
        if (stopped) {
          break;
        }
        consecutiveErrors += 1;
        const retryMs = reconnectDelay(consecutiveErrors, {
          baseMs: options.reconnectBaseMs || options.pollMs || 1_000,
          maxMs: options.reconnectMaxMs || 30_000,
          jitterRatio: options.reconnectJitterRatio,
        });
        emitLog('worker_error', `worker error: ${error.message}; retrying in ${retryMs}ms`, {
          level: 'error',
          data: { consecutiveErrors, retryMs },
        });
        if (options.once) {
          throw error;
        }
        await sleep(retryMs);
      }
    }
    await Promise.allSettled([...runningTasks.values()].map((running) => running.promise));
    emitLog('stopped', `worker ${worker.id} stopped`);
  };

  const done = loop();
  return { stop, done };
}
