import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import fs from 'node:fs/promises';
import initSqlJs from 'sql.js';
import { buildBatchReport } from './batch-report.js';
import { mergeArtifactPolicy, normalizeArtifactPolicy } from './artifact-policy.js';
import { dependencyArtifactAllowed, mergeDependencyArtifacts, normalizeDependencyArtifacts } from './dependency-artifacts.js';
import { ensureDir, hasLabels, isSubset, newId, nowIso, readJson, safeName, writeJson } from './utils.js';
import {
  agentReadinessForTask,
  effectiveRequiredCapabilities,
  missingRequiredTools,
  normalizeToolName,
  protocolReadinessForWorker,
  scheduleTask,
  taskSlotCost,
} from './scheduler.js';
import { buildDispatchPlan } from './dispatch-plan.js';
import { routingActionHint } from './routing-diagnostics.js';
import { workerReadinessDiagnostics, workerResourceDiagnostics } from './worker-diagnostics.js';
import {
  normalizeResourceRequirements,
  resourceFitForTask,
  resourceRequirementsEmpty,
  workerResourceCapacity,
  workerResourceUsage,
} from './resource-model.js';
import {
  normalizeRetryPolicy,
  normalizeTaskFailureKind,
  retryPolicyMatch,
} from './retry-policy.js';
import { normalizeRuntimeBuild } from './runtime-build.js';

const ACTIVE_WINDOW_MS = 45_000;
const DEFAULT_TASK_LEASE_MS = 60_000;
const MIN_TASK_LEASE_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 60_000;
const DEFAULT_MAX_ARTIFACT_CHUNK_BYTES = 16 * 1024 * 1024;
const DEFAULT_WORKER_TOKEN_ROTATION_TTL_MS = 10 * 60_000;
const MIN_WORKER_TOKEN_ROTATION_TTL_MS = 60_000;
const MAX_WORKER_TOKEN_ROTATION_TTL_MS = 60 * 60_000;
const CONTROL_ONLY_WORKER_EVENT_TYPES = new Set(['runtime_started']);
export const CURRENT_STATE_VERSION = 2;
export const CURRENT_SQLITE_SCHEMA_VERSION = 1;

export function normalizeTaskLeaseMs(value, fallback = DEFAULT_TASK_LEASE_MS) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(MIN_TASK_LEASE_MS, Math.floor(parsed));
}

function normalizeMaxAttempts(value) {
  const parsed = Number(value ?? DEFAULT_MAX_ATTEMPTS);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.floor(parsed))) : DEFAULT_MAX_ATTEMPTS;
}

function normalizeRetryBackoffMs(value, fallback = DEFAULT_RETRY_BACKOFF_MS) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function retryDelayMs(task) {
  const baseMs = normalizeRetryBackoffMs(task.retryBackoffMs);
  const maxMs = Math.max(baseMs, normalizeRetryBackoffMs(task.maxRetryBackoffMs, DEFAULT_MAX_RETRY_BACKOFF_MS));
  const exponent = Math.max(0, Number(task.attemptSeq || 1) - 1);
  return Math.min(maxMs, baseMs * (2 ** Math.min(exponent, 20)));
}

function leaseExpired(task, atMs = Date.now()) {
  const expiresAt = task?.lease?.expiresAt ? Date.parse(task.lease.expiresAt) : 0;
  return Boolean(expiresAt && expiresAt <= atMs);
}

function maxConcurrency(value) {
  return Math.max(1, Number(value || 1));
}

function normalizeTaskSlots(value) {
  return taskSlotCost({ slots: value });
}

function normalizeTaskIds(ids = [], fallback = null) {
  const values = Array.isArray(ids) ? ids : [];
  if (fallback) {
    values.push(fallback);
  }
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeWorkerRuntime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const id = String(value.id || '').trim().slice(0, 160);
  const startedAt = String(value.startedAt || '').trim();
  const pid = Number(value.pid);
  if (!id || !Number.isFinite(Date.parse(startedAt))) {
    return null;
  }
  return {
    id,
    startedAt: new Date(Date.parse(startedAt)).toISOString(),
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    build: normalizeRuntimeBuild(value.build),
  };
}

function normalizeStringList(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeToolList(value) {
  return Array.from(new Set(normalizeStringList(value).map(normalizeToolName).filter(Boolean)));
}

function normalizeLabels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, labelValue]) => key && labelValue !== undefined && labelValue !== null)
      .map(([key, labelValue]) => [String(key), String(labelValue)]),
  );
}

function normalizeEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, envValue]) => key && envValue !== undefined && envValue !== null)
      .map(([key, envValue]) => [String(key), String(envValue)]),
  );
}

function normalizeSandboxProfile(value) {
  if (value === true) {
    return 'isolated';
  }
  const text = String(value || 'default').trim().toLowerCase();
  if (!text || ['default', 'inherit', 'none', 'off', 'false'].includes(text)) {
    return 'default';
  }
  if (['isolated', 'minimal', 'sandbox', 'strict'].includes(text)) {
    return 'isolated';
  }
  throw new Error(`Unknown sandbox profile: ${value}`);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function mergeBatchTaskDefaults(defaults = {}, spec = {}) {
  const merged = {
    ...defaults,
    ...spec,
  };
  merged.workerId = firstDefined(spec.workerId, spec.worker, defaults.workerId, defaults.worker);
  merged.sessionId = firstDefined(spec.sessionId, spec.session, defaults.sessionId, defaults.session);
  merged.requiredCapabilities = firstDefined(
    spec.requiredCapabilities,
    spec.capabilities,
    defaults.requiredCapabilities,
    defaults.capabilities,
  ) || [];
  merged.requiredTools = Array.from(new Set([
    ...normalizeToolList(firstDefined(defaults.requiredTools, defaults.tools)),
    ...normalizeToolList(firstDefined(spec.requiredTools, spec.tools)),
  ]));
  if (hasOwn(spec, 'slots') || hasOwn(spec, 'taskSlots') || hasOwn(defaults, 'slots') || hasOwn(defaults, 'taskSlots')) {
    merged.slots = normalizeTaskSlots(firstDefined(spec.slots, spec.taskSlots, defaults.slots, defaults.taskSlots));
  }
  merged.requiredLabels = {
    ...normalizeLabels(defaults.requiredLabels || defaults.labels),
    ...normalizeLabels(spec.requiredLabels || spec.labels),
  };
  merged.requiredResources = {
    ...normalizeResourceRequirements(defaults.requiredResources || defaults.resources),
    ...normalizeResourceRequirements(spec.requiredResources || spec.resources),
  };
  merged.env = {
    ...normalizeEnv(defaults.env),
    ...normalizeEnv(spec.env),
  };
  merged.artifactPolicy = mergeArtifactPolicy(defaults.artifactPolicy, spec.artifactPolicy);
  merged.dependencyArtifacts = mergeDependencyArtifacts(defaults.dependencyArtifacts, spec.dependencyArtifacts);
  if (hasOwn(defaults, 'inputFiles') || hasOwn(spec, 'inputFiles')) {
    merged.inputFiles = [
      ...(defaults.inputFiles || []),
      ...(spec.inputFiles || []),
    ];
  }
  if (hasOwn(spec, 'keepWorkspace') || hasOwn(defaults, 'keepWorkspace')) {
    merged.keepWorkspace = firstDefined(spec.keepWorkspace, defaults.keepWorkspace);
  }
  if (hasOwn(spec, 'sandboxProfile') || hasOwn(spec, 'sandbox') || hasOwn(defaults, 'sandboxProfile') || hasOwn(defaults, 'sandbox')) {
    merged.sandboxProfile = normalizeSandboxProfile(firstDefined(
      spec.sandboxProfile,
      spec.sandbox,
      defaults.sandboxProfile,
      defaults.sandbox,
    ));
  }
  if (hasOwn(spec, 'retryPolicy') || hasOwn(defaults, 'retryPolicy')) {
    merged.retryPolicy = firstDefined(spec.retryPolicy, defaults.retryPolicy);
  }
  delete merged.worker;
  delete merged.session;
  delete merged.capabilities;
  delete merged.tools;
  delete merged.taskSlots;
  delete merged.labels;
  delete merged.sandbox;
  delete merged.resources;
  return merged;
}

function terminalTaskStatus(status) {
  return ['succeeded', 'failed', 'cancelled'].includes(status);
}

function terminalBatchStatus(status) {
  return ['succeeded', 'completed_with_errors', 'cancelled'].includes(status);
}

function isSystemTask(task) {
  const title = String(task?.title || '').toLowerCase();
  return title.startsWith('nado verify')
    || title.startsWith('nado doctor')
    || title.startsWith('docker agent echo')
    || title.startsWith('docker gpu route')
    || title.startsWith('nado route check')
    || title.startsWith('run cuda inference cli route explanation')
    || title.startsWith('claude smoke')
    || title.startsWith('claude file smoke');
}

function isSystemBatch(batch) {
  const title = String(batch?.title || '').toLowerCase();
  return title.startsWith('nado verify')
    || title.startsWith('nado doctor')
    || title.startsWith('docker agent echo')
    || title.startsWith('docker gpu route')
    || title.startsWith('nado route check')
    || title.startsWith('run cuda inference cli route explanation')
    || title.startsWith('claude smoke')
    || title.startsWith('claude file smoke');
}

function taskNeedsAttention(task) {
  if (task?.runtimeDiagnostics?.needsAttention) {
    return true;
  }
  if (!task || task.status !== 'queued' || !task.scheduler) {
    return false;
  }
  if (task.scheduler.workerId) {
    return false;
  }
  return ['no eligible worker', 'explicit worker requested; target not eligible'].includes(task.scheduler.reason);
}

function attentionTaskSummary(task) {
  const candidateReasons = (task.scheduler?.candidates || [])
    .flatMap((candidate) => candidate.reasons || [])
    .filter(Boolean);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    requestedWorkerId: task.requestedWorkerId || null,
    assignedWorkerId: task.assignedWorkerId || null,
    schedulerReason: task.scheduler?.reason || null,
    nextAction: task.runtimeDiagnostics?.nextAction || task.nextAction || routingActionHint(task),
    runtimeDiagnostics: task.runtimeDiagnostics || null,
    inferredCapabilities: task.scheduler?.inferredCapabilities || [],
    effectiveRequiredCapabilities: task.scheduler?.effectiveRequiredCapabilities || [],
    requiredResources: task.requiredResources || {},
    candidateReasons: Array.from(new Set(candidateReasons)),
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || null,
  };
}

function compactWorkerSnapshot(worker) {
  const { events, ...compact } = worker;
  return {
    ...compact,
    eventCount: Array.isArray(events) ? events.length : 0,
    lastEventAt: Array.isArray(events) && events.length ? events[events.length - 1].at : worker.lastEventAt || null,
  };
}

function emptySessionRecord(session = {}) {
  return !(session.taskIds || []).length
    && !session.currentTaskId
    && !session.workspace;
}

export function buildTaskRuntimeDiagnostics(task, context = {}) {
  const nowMs = Number(context.nowMs ?? Date.now());
  const worker = context.worker || null;
  const session = context.session || null;
  const workerId = task?.assignedWorkerId || task?.requestedWorkerId || session?.assignedWorkerId || null;
  const leaseExpiresAtMs = task?.lease?.expiresAt ? Date.parse(task.lease.expiresAt) : Number.NaN;
  const leaseRemainingMs = Number.isFinite(leaseExpiresAtMs) ? leaseExpiresAtMs - nowMs : null;
  const lease = task?.lease ? {
    ...task.lease,
    remainingMs: leaseRemainingMs,
    expired: leaseRemainingMs !== null && leaseRemainingMs <= 0,
  } : null;
  const latestQueueOwnershipEvent = [...(task?.events || [])].reverse().find((event) => (
    [
      'lease_recovered',
      'offline_recovered',
      'requeued',
      'rescheduled',
      'retry_scheduled',
      'claimed',
      'cancelled',
      'succeeded',
      'failed',
    ].includes(event.type)
  )) || null;
  const recoveryEvent = (
    ['lease_recovered', 'offline_recovered'].includes(latestQueueOwnershipEvent?.type)
    && latestQueueOwnershipEvent?.data?.sessionRecoveryMode === 'same-worker'
  ) ? latestQueueOwnershipEvent : null;
  const workerState = worker ? {
    id: worker.id,
    active: Boolean(worker.active),
    gatewayState: worker.gatewayState || 'unknown',
    adminState: worker.adminState || 'unknown',
    ageMs: Number.isFinite(Number(worker.ageMs)) ? Number(worker.ageMs) : null,
    availableSlots: Number.isFinite(Number(worker.availableSlots)) ? Number(worker.availableSlots) : null,
    runningSlots: Number.isFinite(Number(worker.runningSlots)) ? Number(worker.runningSlots) : null,
    maxConcurrency: Number.isFinite(Number(worker.maxConcurrency)) ? Number(worker.maxConcurrency) : null,
  } : (workerId ? {
    id: workerId,
    active: false,
    gatewayState: 'missing',
    adminState: 'unknown',
    ageMs: null,
    availableSlots: null,
    runningSlots: null,
    maxConcurrency: null,
  } : null);
  const base = {
    state: 'unknown',
    summary: 'Task runtime state is unavailable',
    needsAttention: false,
    attemptId: task?.currentAttemptId || null,
    attemptSeq: Number(task?.attemptSeq || 0),
    maxAttempts: normalizeMaxAttempts(task?.maxAttempts),
    worker: workerState,
    lease,
    session: task?.sessionId ? {
      id: task.sessionId,
      assignedWorkerId: session?.assignedWorkerId || null,
      workspace: session?.workspace || null,
      recoveryMode: recoveryEvent ? 'same-worker' : null,
      recoveryEventAt: recoveryEvent?.at || null,
    } : null,
    nextAction: null,
  };

  if (!task) {
    return base;
  }
  if (terminalTaskStatus(task.status)) {
    return {
      ...base,
      state: 'terminal',
      summary: `Task is ${task.status}`,
    };
  }
  if (task.status === 'running') {
    if (!lease) {
      return {
        ...base,
        state: 'lease_missing',
        summary: 'Running task has no execution lease',
        needsAttention: true,
        nextAction: {
          code: 'inspect_missing_task_lease',
          message: 'Inspect control state and Worker logs, then recover or cancel this task before accepting more output.',
          workerId,
        },
      };
    }
    if (lease?.expired) {
      const sessionPinned = Boolean(task.sessionId && (session?.assignedWorkerId || workerId));
      return {
        ...base,
        state: 'lease_expired',
        summary: sessionPinned
          ? `Attempt lease expired; recovery must remain on session Worker ${session?.assignedWorkerId || workerId}`
          : 'Attempt lease expired and is awaiting recovery',
        needsAttention: true,
        nextAction: {
          code: sessionPinned ? 'recover_on_session_worker' : 'recover_expired_task',
          message: sessionPinned
            ? `Restore Worker ${session?.assignedWorkerId || workerId}; automatic recovery will keep the session on that workspace owner.`
            : 'Run offline-task recovery or inspect the automatic recovery supervisor.',
          workerId: session?.assignedWorkerId || workerId,
        },
      };
    }
    if (workerState && !workerState.active) {
      return {
        ...base,
        state: 'worker_heartbeat_stale',
        summary: 'Worker heartbeat is stale while the attempt lease is still live',
        needsAttention: true,
        nextAction: {
          code: 'restore_worker_before_lease_expiry',
          message: `Restore Worker ${workerId} connectivity before the lease expires, or prepare for at-least-once recovery.`,
          workerId,
        },
      };
    }
    return {
      ...base,
      state: 'running_healthy',
      summary: 'Worker heartbeat and attempt lease are healthy',
    };
  }

  const notBeforeMs = task.notBeforeAt ? Date.parse(task.notBeforeAt) : Number.NaN;
  if (task.status === 'queued' && Number.isFinite(notBeforeMs) && notBeforeMs > nowMs) {
    return {
      ...base,
      state: 'retry_backoff',
      summary: `Retry is delayed until ${task.notBeforeAt}`,
      nextAction: {
        code: 'wait_for_retry_backoff',
        message: 'Wait for the bounded retry delay, or cancel the task if it is no longer required.',
      },
    };
  }
  if (task.status === 'queued' && recoveryEvent && task.sessionId) {
    if (!workerState?.active) {
      return {
        ...base,
        state: 'waiting_for_session_worker',
        summary: `Recovered session task is waiting for Worker ${workerId}`,
        needsAttention: true,
        nextAction: {
          code: 'reconnect_session_worker',
          message: `Reconnect the original session Worker ${workerId}; another Worker cannot claim its local workspace.`,
          workerId,
        },
      };
    }
    if (workerState.adminState !== 'enabled') {
      return {
        ...base,
        state: 'session_worker_disabled',
        summary: `Session Worker ${workerId} is ${workerState.adminState}`,
        needsAttention: true,
        nextAction: {
          code: 'enable_session_worker',
          message: `Resume Worker ${workerId} so it can reclaim the session task.`,
          workerId,
        },
      };
    }
    if (
      workerState.runningSlots !== null
      && workerState.maxConcurrency !== null
      && workerState.runningSlots + taskSlotCost(task) > workerState.maxConcurrency
    ) {
      return {
        ...base,
        state: 'waiting_for_session_worker_slot',
        summary: `Session Worker ${workerId} has no available task slot`,
        needsAttention: true,
        nextAction: {
          code: 'wait_for_session_worker_slot',
          message: `Wait for capacity on Worker ${workerId}, or cancel lower-priority work on that Worker.`,
          workerId,
        },
      };
    }
    return {
      ...base,
      state: 'awaiting_session_claim',
      summary: `Session Worker ${workerId} is online and can reclaim the task`,
    };
  }
  if (task.status === 'queued') {
    return {
      ...base,
      state: task.scheduler?.workerId ? 'awaiting_claim' : 'awaiting_route',
      summary: task.scheduler?.workerId
        ? `Task is waiting for Worker ${task.scheduler.workerId} to claim it`
        : 'Task is waiting for an eligible route',
    };
  }
  return {
    ...base,
    state: task.status || 'unknown',
    summary: `Task is ${task.status || 'in an unknown state'}`,
  };
}

function compactTaskSnapshot(task, runtimeDiagnostics = null) {
  const routingNextAction = routingActionHint(task);
  return {
    id: task.id,
    title: task.title,
    type: task.type,
    status: task.status,
    priority: task.priority,
    slots: task.slots,
    requestedWorkerId: task.requestedWorkerId || null,
    assignedWorkerId: task.assignedWorkerId || null,
    sessionId: task.sessionId || null,
    batchId: task.batchId || null,
    batchKey: task.batchKey || null,
    requiredCapabilities: task.requiredCapabilities || [],
    requiredTools: task.requiredTools || [],
    requiredLabels: task.requiredLabels || {},
    requiredResources: task.requiredResources || {},
    scheduler: task.scheduler || null,
    nextAction: runtimeDiagnostics?.nextAction || routingNextAction,
    routingNextAction,
    runtimeDiagnostics,
    attemptSeq: task.attemptSeq || 0,
    maxAttempts: normalizeMaxAttempts(task.maxAttempts),
    retryPolicy: normalizeRetryPolicy(task.retryPolicy),
    notBeforeAt: task.notBeforeAt || null,
    lease: task.lease || null,
    idempotencyKey: task.idempotencyKey || null,
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || null,
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    exitCode: task.exitCode ?? null,
    failureKind: task.failureKind || null,
    error: task.error || null,
    workspaceCleaned: Boolean(task.workspaceCleaned),
    artifactCount: Array.isArray(task.artifacts) ? task.artifacts.filter((artifact) => !artifact.skipped).length : 0,
    eventCount: Array.isArray(task.events) ? task.events.length : 0,
    inputFileCount: Array.isArray(task.inputFiles) ? task.inputFiles.length : 0,
    stdoutBytes: Buffer.byteLength(String(task.stdout || ''), 'utf8'),
    stderrBytes: Buffer.byteLength(String(task.stderr || ''), 'utf8'),
  };
}

function requireRoutableError(plan) {
  const blocked = (plan.items || []).filter((item) => !item.routability?.routable);
  if (!blocked.length) {
    return null;
  }
  const actionCodes = Array.from(new Set(blocked.map((item) => item.nextAction?.code).filter(Boolean)));
  const actionText = actionCodes.length ? `; nextAction=${actionCodes.join(',')}` : '';
  const error = new Error(`No routable worker for ${blocked.length} task(s): ${blocked.map((item) => item.key).join(', ')}${actionText}`);
  error.status = 409;
  error.dispatchPlan = plan;
  error.nextActions = actionCodes;
  return error;
}

function initialState() {
  return {
    version: CURRENT_STATE_VERSION,
    workers: {},
    workerTokens: {},
    workerSignatureNonces: {},
    workerEnrollmentTokens: {},
    sessions: {},
    batches: {},
    artifactUploads: {},
    inputUploads: {},
    auditEvents: [],
    workerTokenOrder: [],
    workerEnrollmentTokenOrder: [],
    sessionOrder: [],
    batchOrder: [],
    artifactUploadOrder: [],
    inputUploadOrder: [],
    tasks: {},
    taskOrder: [],
    commandOrder: [],
  };
}

function normalizeStateShape(state) {
  if (state !== undefined && state !== null && (typeof state !== 'object' || Array.isArray(state))) {
    throw new Error('Control state must be a JSON object');
  }
  const normalized = state || initialState();
  const sourceVersion = Number(normalized.version ?? 0);
  if (!Number.isInteger(sourceVersion) || sourceVersion < 0) {
    throw new Error(`Invalid control state version: ${normalized.version}`);
  }
  if (sourceVersion > CURRENT_STATE_VERSION) {
    throw new Error(`Control state version ${sourceVersion} is newer than supported version ${CURRENT_STATE_VERSION}`);
  }
  normalized.workers ??= {};
  for (const worker of Object.values(normalized.workers)) {
    worker.runtime = normalizeWorkerRuntime(worker.runtime);
  }
  normalized.workerTokens ??= {};
  for (const token of Object.values(normalized.workerTokens)) {
    token.rotationStatus ??= null;
    token.rotationFromTokenId ??= null;
    token.rotationToTokenId ??= null;
    token.rotationExpiresAt ??= null;
    token.rotationFinalExpiresAt ??= null;
    token.rotationConfirmedAt ??= null;
    token.rotationExpiredAt ??= null;
    token.rotationSupersededAt ??= null;
  }
  normalized.workerSignatureNonces ??= {};
  normalized.workerEnrollmentTokens ??= {};
  normalized.sessions ??= {};
  for (const session of Object.values(normalized.sessions)) {
    session.requiredResources = normalizeResourceRequirements(session.requiredResources || session.resources);
  }
  normalized.batches ??= {};
  normalized.artifactUploads ??= {};
  normalized.inputUploads ??= {};
  normalized.auditEvents = Array.isArray(normalized.auditEvents) ? normalized.auditEvents.slice(-5_000) : [];
  normalized.workerTokenOrder ??= Object.keys(normalized.workerTokens);
  normalized.workerEnrollmentTokenOrder ??= Object.keys(normalized.workerEnrollmentTokens);
  normalized.sessionOrder ??= Object.keys(normalized.sessions);
  normalized.batchOrder ??= Object.keys(normalized.batches);
  normalized.artifactUploadOrder ??= Object.keys(normalized.artifactUploads);
  normalized.inputUploadOrder ??= Object.keys(normalized.inputUploads);
  normalized.tasks ??= {};
  for (const task of Object.values(normalized.tasks)) {
    task.requiredResources = normalizeResourceRequirements(task.requiredResources || task.resources);
    task.maxAttempts = normalizeMaxAttempts(task.maxAttempts);
    task.retryPolicy = normalizeRetryPolicy(task.retryPolicy);
    task.retryBackoffMs = normalizeRetryBackoffMs(task.retryBackoffMs);
    task.maxRetryBackoffMs = Math.max(
      task.retryBackoffMs,
      normalizeRetryBackoffMs(task.maxRetryBackoffMs, DEFAULT_MAX_RETRY_BACKOFF_MS),
    );
    task.notBeforeAt ??= null;
    task.lease ??= null;
    task.idempotencyKey ??= null;
    task.failureKind = normalizeTaskFailureKind(task.failureKind);
    task.inputReadyStatus ??= null;
  }
  normalized.taskOrder ??= Object.keys(normalized.tasks);
  normalized.commandOrder ??= [];
  normalized.version = CURRENT_STATE_VERSION;
  return normalized;
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function makeWorkerToken() {
  return `nado_wt_${crypto.randomBytes(24).toString('hex')}`;
}

function normalizeWorkerTokenRotationTtlMs(value) {
  const parsed = Number(value ?? DEFAULT_WORKER_TOKEN_ROTATION_TTL_MS);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WORKER_TOKEN_ROTATION_TTL_MS;
  }
  return Math.max(
    MIN_WORKER_TOKEN_ROTATION_TTL_MS,
    Math.min(MAX_WORKER_TOKEN_ROTATION_TTL_MS, Math.floor(parsed)),
  );
}

function workerTokenRotationError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function makeWorkerEnrollmentToken() {
  return `nado_enroll_${crypto.randomBytes(24).toString('hex')}`;
}

function publicWorkerToken(record) {
  const { tokenHash, ...publicRecord } = record;
  return publicRecord;
}

function publicWorkerEnrollmentToken(record) {
  const { tokenHash, ...publicRecord } = record;
  return publicRecord;
}

function publicArtifactUpload(record) {
  if (!record) {
    return null;
  }
  const { tempPath, storagePath, ...publicRecord } = record;
  return publicRecord;
}

function publicInputUpload(record) {
  if (!record) {
    return null;
  }
  const { tempPath, storagePath, ...publicRecord } = record;
  return publicRecord;
}

function normalizeWorkerEvents(events) {
  return Array.isArray(events) ? events.slice(-300) : [];
}

function taskSortTime(task) {
  return Date.parse(task.completedAt || task.updatedAt || task.createdAt || '') || 0;
}

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.backend = 'json';
    this.dataDir = path.dirname(file);
    this.artifactDir = path.join(this.dataDir, 'artifacts');
    this.inputDir = path.join(this.dataDir, 'inputs');
    this.state = initialState();
    this.writeQueue = Promise.resolve();
    this.artifactUploadQueues = new Map();
    this.inputUploadQueues = new Map();
    this.taskLeaseMs = DEFAULT_TASK_LEASE_MS;
    this.claimWaiters = new Set();
    this.writeFence = null;
  }

  setWriteFence(fence) {
    this.writeFence = fence || null;
  }

  configureReliability(options = {}) {
    this.taskLeaseMs = normalizeTaskLeaseMs(options.taskLeaseMs, this.taskLeaseMs);
    return {
      taskLeaseMs: this.taskLeaseMs,
      defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
      deliverySemantics: 'at-least-once',
    };
  }

  notifyClaimWaiters() {
    for (const waiter of this.claimWaiters) {
      void waiter.wake();
    }
  }

  closeClaimWaiters() {
    for (const waiter of [...this.claimWaiters]) {
      waiter.finish(null);
    }
  }

  async waitForTaskClaim(workerId, waitMs = 0, options = {}) {
    const immediate = await this.claimTask(workerId, {
      snapshotResult: options.snapshotResult,
    });
    const boundedWaitMs = Math.max(0, Math.min(30_000, Math.floor(Number(waitMs || 0))));
    if (immediate || !boundedWaitMs) {
      return immediate;
    }

    return new Promise((resolve) => {
      const waiter = {
        workerId,
        busy: false,
        done: false,
        timer: null,
        probeTimer: null,
        finish: (task) => {
          if (waiter.done) {
            return;
          }
          waiter.done = true;
          clearTimeout(waiter.timer);
          clearInterval(waiter.probeTimer);
          options.signal?.removeEventListener('abort', waiter.abort);
          this.claimWaiters.delete(waiter);
          resolve(task);
        },
        wake: async () => {
          if (waiter.done || waiter.busy) {
            return;
          }
          waiter.busy = true;
          try {
            const task = await this.claimTask(workerId, {
              touchWorker: false,
              snapshotResult: options.snapshotResult,
            });
            if (task) {
              waiter.finish(task);
            } else if (this.state.workers[workerId]?.adminState !== 'enabled') {
              waiter.finish(null);
            }
          } catch {
            waiter.finish(null);
          } finally {
            waiter.busy = false;
          }
        },
      };
      waiter.timer = setTimeout(() => waiter.finish(null), boundedWaitMs);
      waiter.probeTimer = setInterval(() => void waiter.wake(), Math.min(500, boundedWaitMs));
      waiter.abort = () => waiter.finish(null);
      if (options.signal?.aborted) {
        waiter.finish(null);
        return;
      }
      options.signal?.addEventListener('abort', waiter.abort, { once: true });
      this.claimWaiters.add(waiter);
      queueMicrotask(() => void waiter.wake());
    });
  }

  static defaultPath(dataDir) {
    return path.join(dataDir, 'control-state.json');
  }

  async load() {
    const loaded = await readJson(this.file, initialState());
    const sourceVersion = Number(loaded?.version ?? 0);
    this.state = normalizeStateShape(loaded);
    this.lastMigration = {
      fromVersion: sourceVersion,
      toVersion: CURRENT_STATE_VERSION,
      migrated: sourceVersion < CURRENT_STATE_VERSION,
    };
    if (this.lastMigration.migrated) {
      await this.save();
    }
  }

  async save() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await this.writeFence?.assertOwned();
        await writeJson(this.file, snapshot, {
          beforeCommit: () => this.writeFence?.assertOwned(),
        });
      });
    await this.writeQueue;
  }

  async compact() {
    await this.save();
    return {
      backend: 'json',
      path: this.file,
      compacted: false,
    };
  }

  async upsertWorker(worker, authentication = null, connection = null) {
    const now = nowIso();
    const existing = this.state.workers[worker.id] || {};
    const previousRuntime = normalizeWorkerRuntime(existing.runtime);
    const reportedRuntime = normalizeWorkerRuntime(worker.runtime);
    const currentRuntime = reportedRuntime?.id !== previousRuntime?.id
      ? (reportedRuntime || previousRuntime)
      : (previousRuntime || reportedRuntime);
    const updated = {
      ...existing,
      id: worker.id,
      name: worker.name || worker.id,
      host: worker.host || existing.host || null,
      capabilities: Array.from(new Set(worker.capabilities || existing.capabilities || [])),
      labels: { ...(existing.labels || {}), ...normalizeLabels(worker.labels) },
      agentCommandConfigured: Boolean(worker.agentCommandConfigured),
      agentPreset: worker.agentPreset || existing.agentPreset || null,
      credentialRotationConfigured: Boolean(
        worker.credentialRotationConfigured ?? existing.credentialRotationConfigured,
      ),
      identity: authentication
        ? { ...authentication }
        : existing.identity || null,
      connection: connection
        ? { ...connection }
        : existing.connection || null,
      maxConcurrency: maxConcurrency(worker.maxConcurrency || existing.maxConcurrency),
      adminState: existing.adminState || 'enabled',
      observedState: worker.observedState || existing.observedState || 'idle',
      currentTaskIds: normalizeTaskIds(worker.currentTaskIds ?? existing.currentTaskIds, worker.currentTaskId ?? existing.currentTaskId ?? null),
      currentTaskId: null,
      metrics: worker.metrics || existing.metrics || {},
      inventory: worker.inventory || existing.inventory || {},
      runtime: currentRuntime,
      diagnostics: existing.diagnostics || {},
      commands: existing.commands || [],
      events: normalizeWorkerEvents(existing.events),
      registeredAt: existing.registeredAt || now,
      lastSeenAt: now,
    };
    updated.currentTaskId = updated.currentTaskIds[0] || null;
    if (reportedRuntime && reportedRuntime.id !== previousRuntime?.id) {
      this.appendWorkerEvent(updated, {
        type: 'runtime_started',
        level: 'info',
        message: `Worker ${worker.id} runtime ${reportedRuntime.id} connected`,
        data: {
          controlObserved: true,
          runtimeId: reportedRuntime.id,
          runtimeStartedAt: reportedRuntime.startedAt,
          pid: reportedRuntime.pid,
          previousRuntimeId: previousRuntime?.id || null,
          previousRuntimeStartedAt: previousRuntime?.startedAt || null,
          previousLastSeenAt: existing.lastSeenAt || null,
          authenticationType: authentication?.type || null,
          workerTokenId: authentication?.workerTokenId || null,
        },
      });
    }
    this.appendWorkerEvent(updated, {
      type: 'registered',
      level: 'info',
      message: `Worker ${worker.id} registered`,
      data: {
        capabilities: updated.capabilities,
        labels: updated.labels,
        maxConcurrency: updated.maxConcurrency,
        agentPreset: updated.agentPreset,
        runtimeId: updated.runtime?.id || null,
      },
    });
    this.state.workers[worker.id] = updated;
    await this.save();
    return this.decorateWorker(updated);
  }

  async createWorkerToken(input = {}) {
    if (!input.workerId) {
      throw new Error('Worker token requires workerId');
    }
    const now = nowIso();
    const token = input.token || makeWorkerToken();
    const record = {
      id: newId('wtok'),
      workerId: String(input.workerId),
      label: input.label ? String(input.label) : '',
      publicKey: input.publicKey || null,
      enrollmentTokenId: input.enrollmentTokenId || null,
      tokenHash: hashToken(token),
      tokenPreview: token.slice(-8),
      createdAt: now,
      lastUsedAt: null,
      expiresAt: input.expiresAt || null,
      revokedAt: null,
      rotationStatus: null,
      rotationFromTokenId: null,
      rotationToTokenId: null,
      rotationExpiresAt: null,
      rotationFinalExpiresAt: null,
      rotationConfirmedAt: null,
      rotationExpiredAt: null,
      rotationSupersededAt: null,
    };
    this.state.workerTokens[record.id] = record;
    this.state.workerTokenOrder.push(record.id);
    await this.save();
    return {
      workerToken: publicWorkerToken(record),
      token,
    };
  }

  listWorkerTokens(options = {}) {
    return this.state.workerTokenOrder
      .map((id) => this.state.workerTokens[id])
      .filter(Boolean)
      .filter((record) => !options.workerId || record.workerId === options.workerId)
      .map(publicWorkerToken)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getWorkerToken(tokenId) {
    const record = this.state.workerTokens[tokenId];
    return record ? publicWorkerToken(record) : null;
  }

  async revokeWorkerToken(tokenId) {
    const record = this.state.workerTokens[tokenId];
    if (!record) {
      throw new Error(`Unknown worker token: ${tokenId}`);
    }
    record.revokedAt = record.revokedAt || nowIso();
    await this.save();
    return publicWorkerToken(record);
  }

  async expirePendingWorkerTokenRotations(atMs = Date.now()) {
    const expired = [];
    const at = new Date(atMs).toISOString();
    for (const record of Object.values(this.state.workerTokens)) {
      if (record.rotationStatus !== 'pending' || !record.rotationExpiresAt) {
        continue;
      }
      if (Date.parse(record.rotationExpiresAt) > atMs) {
        continue;
      }
      record.rotationStatus = 'expired';
      record.rotationExpiredAt = record.rotationExpiredAt || at;
      record.revokedAt = record.revokedAt || at;
      expired.push(publicWorkerToken(record));
    }
    if (expired.length) {
      await this.save();
    }
    return expired;
  }

  async prepareWorkerTokenRotation(workerId, currentTokenId, input = {}) {
    await this.expirePendingWorkerTokenRotations();
    const current = this.state.workerTokens[currentTokenId];
    if (!current || current.workerId !== workerId || current.revokedAt) {
      throw workerTokenRotationError('Current Worker token is not active for this Worker', 403);
    }
    if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) {
      throw workerTokenRotationError('Current Worker token has expired', 401);
    }
    if (!current.publicKey) {
      throw workerTokenRotationError('Worker token rotation requires an enrolled signed Worker identity', 409);
    }
    if (current.rotationStatus === 'pending') {
      throw workerTokenRotationError('Pending Worker token must be confirmed before starting another rotation', 409);
    }
    const token = String(input.token || '');
    if (!/^nado_wt_[a-f0-9]{48,}$/i.test(token)) {
      throw workerTokenRotationError('Replacement Worker token must be a locally generated high-entropy nado_wt_ token');
    }
    const tokenHash = hashToken(token);
    const existing = Object.values(this.state.workerTokens).find((candidate) => candidate.tokenHash === tokenHash);
    if (existing) {
      if (
        existing.workerId === workerId
        && existing.rotationFromTokenId === currentTokenId
        && existing.rotationStatus === 'pending'
        && (!existing.rotationExpiresAt || Date.parse(existing.rotationExpiresAt) > Date.now())
      ) {
        return {
          workerToken: publicWorkerToken(existing),
          previousWorkerToken: publicWorkerToken(current),
          idempotent: true,
        };
      }
      throw workerTokenRotationError('Replacement Worker token is already registered', 409);
    }

    const now = nowIso();
    for (const pending of Object.values(this.state.workerTokens)) {
      if (
        pending.rotationStatus === 'pending'
        && pending.rotationFromTokenId === currentTokenId
        && pending.id !== existing?.id
      ) {
        pending.rotationStatus = 'superseded';
        pending.rotationSupersededAt = pending.rotationSupersededAt || now;
        pending.revokedAt = pending.revokedAt || now;
      }
    }
    const ttlMs = normalizeWorkerTokenRotationTtlMs(input.ttlMs);
    const requestedRotationExpiryMs = Date.now() + ttlMs;
    const currentExpiryMs = current.expiresAt ? Date.parse(current.expiresAt) : Number.POSITIVE_INFINITY;
    const rotationExpiresAt = new Date(Math.min(requestedRotationExpiryMs, currentExpiryMs)).toISOString();
    const record = {
      id: newId('wtok'),
      workerId,
      label: current.label ? `${current.label} (rotated)` : 'rotated Worker token',
      publicKey: current.publicKey,
      enrollmentTokenId: current.enrollmentTokenId || null,
      tokenHash,
      tokenPreview: token.slice(-8),
      createdAt: now,
      lastUsedAt: null,
      expiresAt: rotationExpiresAt,
      revokedAt: null,
      rotationStatus: 'pending',
      rotationFromTokenId: current.id,
      rotationToTokenId: null,
      rotationExpiresAt,
      rotationFinalExpiresAt: current.expiresAt || null,
      rotationConfirmedAt: null,
      rotationExpiredAt: null,
      rotationSupersededAt: null,
    };
    current.rotationToTokenId = record.id;
    this.state.workerTokens[record.id] = record;
    this.state.workerTokenOrder.push(record.id);
    await this.save();
    return {
      workerToken: publicWorkerToken(record),
      previousWorkerToken: publicWorkerToken(current),
      idempotent: false,
    };
  }

  async confirmWorkerTokenRotation(workerId, replacementTokenId) {
    const replacement = this.state.workerTokens[replacementTokenId];
    if (!replacement || replacement.workerId !== workerId || !replacement.rotationFromTokenId) {
      throw workerTokenRotationError('Replacement Worker token is not a rotation token for this Worker', 409);
    }
    if (replacement.rotationStatus === 'confirmed') {
      const previous = this.state.workerTokens[replacement.rotationFromTokenId] || null;
      return {
        workerToken: publicWorkerToken(replacement),
        previousWorkerToken: previous ? publicWorkerToken(previous) : null,
        idempotent: true,
      };
    }
    if (replacement.rotationStatus !== 'pending' || replacement.revokedAt) {
      throw workerTokenRotationError(`Worker token rotation is ${replacement.rotationStatus || 'inactive'}`, 409);
    }
    if (replacement.rotationExpiresAt && Date.parse(replacement.rotationExpiresAt) <= Date.now()) {
      await this.expirePendingWorkerTokenRotations();
      throw workerTokenRotationError('Worker token rotation confirmation window has expired', 410);
    }
    const previous = this.state.workerTokens[replacement.rotationFromTokenId];
    if (!previous || previous.workerId !== workerId) {
      throw workerTokenRotationError('Previous Worker token record is missing or has a different owner', 409);
    }

    const now = nowIso();
    replacement.rotationStatus = 'confirmed';
    replacement.rotationConfirmedAt = replacement.rotationConfirmedAt || now;
    replacement.expiresAt = replacement.rotationFinalExpiresAt || null;
    for (const pending of Object.values(this.state.workerTokens)) {
      if (
        pending.id !== replacement.id
        && pending.rotationStatus === 'pending'
        && pending.rotationFromTokenId === previous.id
      ) {
        pending.rotationStatus = 'superseded';
        pending.rotationSupersededAt = pending.rotationSupersededAt || now;
        pending.revokedAt = pending.revokedAt || now;
      }
    }
    previous.rotationToTokenId = replacement.id;
    previous.revokedAt = previous.revokedAt || now;
    await this.save();
    return {
      workerToken: publicWorkerToken(replacement),
      previousWorkerToken: publicWorkerToken(previous),
      idempotent: false,
    };
  }

  async rememberWorkerRequestNonce(workerTokenId, nonce, timestampMs, windowMs = 5 * 60_000) {
    if (!workerTokenId || !nonce) {
      return false;
    }
    const now = Date.now();
    const signedAt = Number(timestampMs);
    const cutoff = now - windowMs;
    this.state.workerSignatureNonces ??= {};
    const nonces = this.state.workerSignatureNonces[workerTokenId] || {};
    for (const [key, value] of Object.entries(nonces)) {
      if (!Number.isFinite(Number(value)) || Number(value) < cutoff) {
        delete nonces[key];
      }
    }
    if (nonces[nonce]) {
      this.state.workerSignatureNonces[workerTokenId] = nonces;
      return false;
    }
    nonces[nonce] = signedAt;
    this.state.workerSignatureNonces[workerTokenId] = nonces;
    await this.save();
    return true;
  }

  async createWorkerEnrollmentToken(input = {}) {
    const now = nowIso();
    const token = input.token || makeWorkerEnrollmentToken();
    const record = {
      id: newId('wenroll'),
      label: input.label ? String(input.label) : '',
      tokenHash: hashToken(token),
      tokenPreview: token.slice(-8),
      createdAt: now,
      lastUsedAt: null,
      useCount: 0,
      maxUses: input.maxUses ? Math.max(1, Number(input.maxUses)) : null,
      expiresAt: input.expiresAt || null,
      revokedAt: null,
    };
    this.state.workerEnrollmentTokens[record.id] = record;
    this.state.workerEnrollmentTokenOrder.push(record.id);
    await this.save();
    return {
      enrollmentToken: publicWorkerEnrollmentToken(record),
      token,
    };
  }

  listWorkerEnrollmentTokens() {
    return this.state.workerEnrollmentTokenOrder
      .map((id) => this.state.workerEnrollmentTokens[id])
      .filter(Boolean)
      .map(publicWorkerEnrollmentToken)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async revokeWorkerEnrollmentToken(tokenId) {
    const record = this.state.workerEnrollmentTokens[tokenId];
    if (!record) {
      throw new Error(`Unknown worker enrollment token: ${tokenId}`);
    }
    record.revokedAt = record.revokedAt || nowIso();
    await this.save();
    return publicWorkerEnrollmentToken(record);
  }

  workerEnrollmentTokensPrunable() {
    return this.state.workerEnrollmentTokenOrder
      .map((id) => this.state.workerEnrollmentTokens[id])
      .filter(Boolean)
      .filter((record) => !record.revokedAt && Number(record.useCount || 0) === 0)
      .map(publicWorkerEnrollmentToken)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  previewWorkerEnrollmentTokenPrune() {
    const prunableTokens = this.workerEnrollmentTokensPrunable();
    return {
      criteria: {
        unusedOnly: true,
        alreadyRevoked: 'preserved',
        usedTokens: 'preserved',
        action: 'revoke',
      },
      prunableTokens,
      prunableCount: prunableTokens.length,
    };
  }

  async pruneWorkerEnrollmentTokens() {
    const preview = this.previewWorkerEnrollmentTokenPrune();
    const now = nowIso();
    for (const token of preview.prunableTokens) {
      const record = this.state.workerEnrollmentTokens[token.id];
      if (record && !record.revokedAt && Number(record.useCount || 0) === 0) {
        record.revokedAt = now;
      }
    }
    if (preview.prunableTokens.length) {
      await this.save();
    }
    return {
      ...preview,
      prunedTokens: preview.prunableTokens.map((token) => publicWorkerEnrollmentToken(this.state.workerEnrollmentTokens[token.id])),
      prunedCount: preview.prunableTokens.length,
    };
  }

  authenticateWorkerEnrollmentToken(token) {
    if (!token) {
      return null;
    }
    const tokenHash = hashToken(token);
    const record = Object.values(this.state.workerEnrollmentTokens).find((candidate) => (
      candidate.tokenHash === tokenHash
      && !candidate.revokedAt
      && (!candidate.expiresAt || Date.parse(candidate.expiresAt) > Date.now())
      && (!candidate.maxUses || Number(candidate.useCount || 0) < Number(candidate.maxUses))
    ));
    if (!record) {
      return null;
    }
    return {
      type: 'worker_enrollment',
      enrollmentTokenId: record.id,
      label: record.label || '',
    };
  }

  async recordWorkerEnrollmentUse(tokenId) {
    const record = this.state.workerEnrollmentTokens[tokenId];
    if (!record) {
      return null;
    }
    record.lastUsedAt = nowIso();
    record.useCount = Number(record.useCount || 0) + 1;
    await this.save();
    return publicWorkerEnrollmentToken(record);
  }

  authenticateWorkerToken(token) {
    if (!token) {
      return null;
    }
    const tokenHash = hashToken(token);
    const now = nowIso();
    const record = Object.values(this.state.workerTokens).find((candidate) => (
      candidate.tokenHash === tokenHash
      && !candidate.revokedAt
      && (!candidate.expiresAt || Date.parse(candidate.expiresAt) > Date.now())
      && (candidate.rotationStatus !== 'expired')
    ));
    if (!record) {
      return null;
    }
    record.lastUsedAt = now;
    return {
      type: 'worker',
      workerId: record.workerId,
      workerTokenId: record.id,
      workerTokenRotationStatus: record.rotationStatus || null,
    };
  }

  async heartbeat(workerId, input = {}, authentication = null, connection = null) {
    const worker = this.state.workers[workerId];
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    const now = nowIso();
    const nowMs = Date.parse(now);
    const previousLastSeenAt = worker.lastSeenAt || null;
    const previousRuntime = normalizeWorkerRuntime(worker.runtime);
    const reportedRuntime = normalizeWorkerRuntime(input.runtime);
    const reportedLeases = new Map((Array.isArray(input.taskLeases) ? input.taskLeases : [])
      .filter((item) => item?.taskId)
      .map((item) => [item.taskId, item]));
    const reportedTaskIds = normalizeTaskIds(input.currentTaskIds ?? worker.currentTaskIds, input.currentTaskId ?? null);
    const currentTaskIds = reportedTaskIds.filter((taskId) => {
      const task = this.state.tasks[taskId];
      const reportedLease = reportedLeases.get(taskId);
      return task?.status === 'running'
        && task.assignedWorkerId === workerId
        && (!reportedLease?.attemptId || reportedLease.attemptId === task.currentAttemptId)
        && !leaseExpired(task, nowMs);
    });
    for (const taskId of currentTaskIds) {
      const task = this.state.tasks[taskId];
      const durationMs = normalizeTaskLeaseMs(task.lease?.durationMs, this.taskLeaseMs);
      const expiresAt = new Date(nowMs + durationMs).toISOString();
      task.lease = {
        attemptId: task.currentAttemptId,
        workerId,
        acquiredAt: task.lease?.acquiredAt || now,
        renewedAt: now,
        expiresAt,
        durationMs,
      };
      const attempt = (task.attempts || []).find((item) => item.id === task.currentAttemptId);
      if (attempt) {
        attempt.leaseRenewedAt = now;
        attempt.leaseExpiresAt = expiresAt;
      }
    }
    const hasRunningAssignedTask = Object.values(this.state.tasks)
      .some((task) => task.status === 'running' && task.assignedWorkerId === workerId);
    const staleRunningHeartbeat = input.observedState === 'running' && !currentTaskIds.length && !hasRunningAssignedTask;
    worker.lastSeenAt = now;
    worker.maxConcurrency = maxConcurrency(input.maxConcurrency || worker.maxConcurrency);
    worker.currentTaskIds = currentTaskIds;
    worker.currentTaskId = worker.currentTaskIds[0] || null;
    if (currentTaskIds.length) {
      worker.observedState = 'running';
    } else if (staleRunningHeartbeat) {
      worker.observedState = worker.adminState === 'enabled' ? 'idle' : worker.adminState;
    } else {
      worker.observedState = input.observedState || worker.observedState || 'idle';
    }
    worker.metrics = input.metrics || worker.metrics || {};
    worker.inventory = input.inventory || worker.inventory || {};
    if (reportedRuntime && reportedRuntime.id !== previousRuntime?.id) {
      this.appendWorkerEvent(worker, {
        at: now,
        type: 'runtime_started',
        level: 'info',
        message: `Worker ${workerId} runtime ${reportedRuntime.id} connected`,
        data: {
          controlObserved: true,
          runtimeId: reportedRuntime.id,
          runtimeStartedAt: reportedRuntime.startedAt,
          pid: reportedRuntime.pid,
          previousRuntimeId: previousRuntime?.id || null,
          previousRuntimeStartedAt: previousRuntime?.startedAt || null,
          previousLastSeenAt,
          authenticationType: authentication?.type || null,
          workerTokenId: authentication?.workerTokenId || null,
        },
      });
    }
    worker.runtime = reportedRuntime?.id !== previousRuntime?.id
      ? (reportedRuntime || previousRuntime)
      : (previousRuntime || reportedRuntime);
    if (authentication) {
      worker.identity = { ...authentication };
    }
    if (connection) {
      worker.connection = { ...connection };
    }
    await this.save();
    return {
      worker: this.decorateWorker(worker),
      commands: worker.commands.filter((command) => command.status === 'queued'),
    };
  }

  listWorkers() {
    return Object.values(this.state.workers)
      .map((worker) => this.decorateWorker(worker))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  getStatusSnapshot() {
    const workers = this.listWorkers();
    const workerById = new Map(workers.map((worker) => [worker.id, worker]));
    const workerItems = workers.map(compactWorkerSnapshot);
    const sessions = this.listSessions();
    const tasks = this.listTasks();
    const taskItems = tasks.map((task) => {
      const workerId = task.assignedWorkerId || task.requestedWorkerId || null;
      return compactTaskSnapshot(task, buildTaskRuntimeDiagnostics(task, {
        worker: workerById.get(workerId) || null,
        session: task.sessionId ? this.state.sessions[task.sessionId] || null : null,
      }));
    });
    const batches = this.listBatches();
    const taskCounts = tasks.reduce((acc, task) => {
      acc[task.status] = (acc[task.status] || 0) + 1;
      return acc;
    }, {});
    const batchCounts = batches.reduce((acc, batch) => {
      acc[batch.status] = (acc[batch.status] || 0) + 1;
      return acc;
    }, {});
    const attentionTasks = taskItems.filter(taskNeedsAttention);
    const routingIssues = attentionTasks.filter((task) => Boolean(task.routingNextAction));
    const operationalIssues = attentionTasks.filter((task) => task.runtimeDiagnostics?.needsAttention);
    return {
      storage: {
        backend: this.backend,
        stateVersion: this.state.version,
        sqliteSchemaVersion: this.backend === 'sqlite' ? this.schemaVersion : null,
        migration: this.lastMigration || null,
        schemaMigration: this.lastSchemaMigration || null,
        restoreReceipt: this.restoreReceipt || null,
      },
      workers: {
        total: workerItems.length,
        active: workerItems.filter((worker) => worker.active).length,
        byGatewayState: workerItems.reduce((acc, worker) => {
          const state = worker.gatewayState || 'unknown';
          acc[state] = (acc[state] || 0) + 1;
          return acc;
        }, {}),
        items: workerItems,
      },
      sessions: {
        total: sessions.length,
        open: sessions.filter((session) => session.status === 'open').length,
        items: sessions,
      },
      tasks: {
        total: tasks.length,
        counts: taskCounts,
        attention: {
          total: attentionTasks.length,
          routingIssues: routingIssues.length,
          operationalIssues: operationalIssues.length,
          items: attentionTasks.slice(0, 20).map(attentionTaskSummary),
        },
        items: taskItems,
      },
      batches: {
        total: batches.length,
        counts: batchCounts,
        items: batches,
      },
    };
  }

  async createSession(input) {
    const now = nowIso();
    const session = {
      id: newId('session'),
      title: input.title || 'untitled session',
      status: 'open',
      requestedWorkerId: input.workerId || null,
      scheduler: null,
      assignedWorkerId: null,
      requiredCapabilities: Array.from(new Set(input.requiredCapabilities || [])),
      requiredTools: normalizeToolList(input.requiredTools || input.tools),
      requiredLabels: normalizeLabels(input.requiredLabels),
      requiredResources: normalizeResourceRequirements(input.requiredResources || input.resources),
      labels: input.labels || {},
      createdAt: now,
      updatedAt: now,
      currentTaskId: null,
      taskIds: [],
      workspace: null,
      events: [
        {
          at: now,
          type: 'created',
          message: 'Session created',
        },
      ],
    };
    this.state.sessions[session.id] = session;
    this.state.sessionOrder.push(session.id);
    await this.save();
    return session;
  }

  listSessions() {
    return this.state.sessionOrder
      .map((id) => this.state.sessions[id])
      .filter(Boolean)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listEmptySessions(options = {}) {
    const sessionId = options.sessionId || null;
    return this.listSessions()
      .filter((session) => (!sessionId || session.id === sessionId) && emptySessionRecord(session));
  }

  async pruneEmptySessions(options = {}) {
    const sessions = this.listEmptySessions(options);
    if (!sessions.length) {
      return { prunedCount: 0, sessions: [] };
    }
    const ids = new Set(sessions.map((session) => session.id));
    for (const id of ids) {
      delete this.state.sessions[id];
    }
    this.state.sessionOrder = this.state.sessionOrder.filter((id) => !ids.has(id));
    await this.save();
    return { prunedCount: sessions.length, sessions };
  }

  getSession(sessionId) {
    const session = this.state.sessions[sessionId];
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  async closeSession(sessionId) {
    const session = this.getSession(sessionId);
    const now = nowIso();
    session.status = 'closed';
    session.updatedAt = now;
    session.events.push({
      at: now,
      type: 'closed',
      message: 'Session closed',
    });
    await this.save();
    return session;
  }

  decorateBatch(batch) {
    const tasks = (batch.taskIds || [])
      .map((id) => this.state.tasks[id])
      .filter(Boolean);
    const counts = tasks.reduce((acc, task) => {
      acc[task.status] = (acc[task.status] || 0) + 1;
      return acc;
    }, {});
    const terminal = tasks.filter((task) => terminalTaskStatus(task.status)).length;
    let status = 'queued';
    const active = (counts.queued || 0) + (counts.running || 0) + (counts.uploading_inputs || 0);
    if (tasks.length && terminal === tasks.length) {
      status = (counts.failed || counts.cancelled) ? 'completed_with_errors' : 'succeeded';
    } else if (!active && (counts.failed || counts.cancelled || counts.blocked)) {
      status = 'completed_with_errors';
    } else if (counts.running) {
      status = 'running';
    } else if (counts.uploading_inputs) {
      status = 'uploading_inputs';
    } else if (counts.queued) {
      status = 'queued';
    } else if (counts.blocked) {
      status = 'blocked';
    }
    return {
      ...batch,
      status,
      counts,
      totalTasks: tasks.length,
      completedTasks: terminal,
    };
  }

  async createBatch(input) {
    const now = nowIso();
    const defaults = input.defaults && typeof input.defaults === 'object' && !Array.isArray(input.defaults)
      ? input.defaults
      : {};
    const specs = (Array.isArray(input.tasks) ? input.tasks : [])
      .map((spec) => mergeBatchTaskDefaults(defaults, spec));
    if (!specs.length) {
      throw new Error('Batch requires at least one task');
    }
    for (const spec of specs) {
      if (!spec.command && !spec.prompt) {
        throw new Error('Each batch task requires command or prompt');
      }
    }
    const keys = specs.map((spec, index) => String(spec.key || spec.id || `task_${index + 1}`));
    if (new Set(keys).size !== keys.length) {
      throw new Error('Batch task keys must be unique');
    }
    const keySet = new Set(keys);
    const dependenciesByKey = new Map();
    for (let index = 0; index < specs.length; index += 1) {
      const dependsOn = normalizeStringList(specs[index].dependsOn);
      for (const key of dependsOn) {
        if (!keySet.has(key)) {
          throw new Error(`Unknown batch dependency "${key}" for task "${keys[index]}"`);
        }
      }
      dependenciesByKey.set(keys[index], dependsOn);
    }
    this.assertAcyclicBatchDependencies(keys, dependenciesByKey);
    if (input.requireRoutable) {
      const plan = buildDispatchPlan({
        title: input.title || 'untitled batch',
        tasks: specs,
      }, {
        workers: this.listWorkers(),
        tasks: this.listTasks(),
        sessions: this.listSessions(),
      });
      const error = requireRoutableError(plan);
      if (error) {
        throw error;
      }
    }
    const batch = {
      id: newId('batch'),
      title: input.title || 'untitled batch',
      status: 'queued',
      labels: input.labels || {},
      createdAt: now,
      updatedAt: now,
      taskIds: [],
      events: [
        {
          at: now,
          type: 'created',
          message: `Batch created with ${specs.length} tasks`,
        },
      ],
    };
    this.state.batches[batch.id] = batch;
    this.state.batchOrder.push(batch.id);

    const tasks = [];
    const taskByKey = new Map();
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      const key = keys[index];
      const dependencyKeys = dependenciesByKey.get(key) || [];
      const task = await this.createTask({
        ...spec,
        batchId: batch.id,
        batchKey: key,
        dependencyKeys,
        status: dependencyKeys.length ? 'blocked' : 'queued',
        workerId: spec.workerId,
        sessionId: spec.sessionId,
        requiredCapabilities: spec.requiredCapabilities || [],
        requiredTools: spec.requiredTools || [],
        requiredLabels: spec.requiredLabels || {},
      });
      tasks.push(task);
      taskByKey.set(key, task);
      batch.taskIds.push(task.id);
      batch.updatedAt = nowIso();
      batch.events.push({
        at: batch.updatedAt,
        type: task.status === 'blocked' ? 'task_blocked' : 'task_queued',
        message: `Task ${task.status}: ${task.id}`,
        taskId: task.id,
      });
    }
    for (const task of tasks) {
      task.dependsOnTaskIds = (task.dependencyKeys || []).map((key) => taskByKey.get(key).id);
      if (task.dependsOnTaskIds.length) {
        task.blockedReason = `Waiting for dependencies: ${task.dependencyKeys.join(', ')}`;
      }
    }
    await this.save();
    return { batch: this.decorateBatch(batch), tasks };
  }

  assertAcyclicBatchDependencies(keys, dependenciesByKey) {
    const visiting = new Set();
    const visited = new Set();
    const visit = (key, stack = []) => {
      if (visited.has(key)) {
        return;
      }
      if (visiting.has(key)) {
        throw new Error(`Batch dependency cycle: ${[...stack, key].join(' -> ')}`);
      }
      visiting.add(key);
      for (const dep of dependenciesByKey.get(key) || []) {
        visit(dep, [...stack, key]);
      }
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of keys) {
      visit(key);
    }
  }

  dependencyLabel(task) {
    return task?.batchKey || task?.title || task?.id || 'unknown';
  }

  dependencyStateForTask(task) {
    const dependencyIds = normalizeTaskIds(task.dependsOnTaskIds);
    const missing = [];
    const failed = [];
    const pending = [];
    for (const dependencyId of dependencyIds) {
      const dependency = this.state.tasks[dependencyId];
      if (!dependency) {
        missing.push(dependencyId);
      } else if (dependency.status === 'succeeded') {
        continue;
      } else if (terminalTaskStatus(dependency.status)) {
        failed.push(dependency);
      } else {
        pending.push(dependency);
      }
    }
    return {
      ready: !missing.length && !failed.length && !pending.length,
      missing,
      failed,
      pending,
    };
  }

  dependencyBlockedReason(task, state = this.dependencyStateForTask(task)) {
    if (state.failed.length) {
      return `Blocked by failed dependencies: ${state.failed
        .map((dependency) => `${this.dependencyLabel(dependency)}(${dependency.status})`)
        .join(', ')}`;
    }
    if (state.missing.length) {
      return `Blocked by missing dependencies: ${state.missing.join(', ')}`;
    }
    return `Waiting for dependencies: ${state.pending
      .map((dependency) => this.dependencyLabel(dependency))
      .join(', ')}`;
  }

  async loadDependencyArtifactInputs(task) {
    const policy = normalizeDependencyArtifacts(task.dependencyArtifacts);
    if (!policy.enabled) {
      return [];
    }
    const dependencyIds = normalizeTaskIds(task.dependsOnTaskIds);
    const files = [];
    for (const dependencyId of dependencyIds) {
      const dependency = this.state.tasks[dependencyId];
      if (!dependency || dependency.status !== 'succeeded') {
        continue;
      }
      const dependencyLabel = safeName(dependency.batchKey || dependency.title || dependency.id);
      for (const artifact of this.listArtifacts(dependency.id)) {
        if (artifact.skipped || !artifact.storagePath || !dependencyArtifactAllowed(artifact.path, policy)) {
          continue;
        }
        files.push({
          path: `${policy.prefix}/${dependencyLabel}/${artifact.path}`,
          size: artifact.size,
          sha256: artifact.sha256,
          transfer: 'stored_reference',
          sourceTaskId: dependency.id,
          sourceBatchKey: dependency.batchKey || null,
          sourceArtifactId: artifact.id,
          sourcePath: artifact.path,
        });
      }
    }
    return files;
  }

  async makeTaskQueuedAfterDependencies(task, now) {
    task.dependencyInputFiles = await this.loadDependencyArtifactInputs(task);
    task.status = 'queued';
    task.blockedReason = null;
    task.updatedAt = now;
    task.events.push({
      at: now,
      type: 'unblocked',
      message: 'Dependencies satisfied; task queued',
    });
    if (!task.requestedWorkerId) {
      this.scheduleQueuedTask(task, now, 'scheduled');
    } else {
      task.scheduler = scheduleTask({
        task,
        workers: this.listWorkers(),
        tasks: this.listTasks(),
        session: task.sessionId ? this.getSession(task.sessionId) : null,
      });
    }
  }

  makeTaskBlockedByDependencies(task, now, reason = null) {
    const blockedReason = reason || this.dependencyBlockedReason(task);
    const changed = task.status !== 'blocked' || task.blockedReason !== blockedReason;
    task.status = 'blocked';
    task.assignedWorkerId = null;
    task.startedAt = null;
    task.completedAt = null;
    task.blockedReason = blockedReason;
    task.scheduler = {
      workerId: null,
      reason: 'blocked by dependencies',
      candidates: [],
    };
    task.updatedAt = now;
    if (changed) {
      task.events.push({
        at: now,
        type: 'blocked',
        message: blockedReason,
      });
    }
  }

  async refreshBatchDependencyStates(batchId, now = nowIso()) {
    const batch = batchId ? this.state.batches[batchId] : null;
    if (!batch) {
      return [];
    }
    const changed = [];
    for (const taskId of batch.taskIds || []) {
      const task = this.state.tasks[taskId];
      if (!task || task.status !== 'blocked') {
        continue;
      }
      const dependencyState = this.dependencyStateForTask(task);
      if (dependencyState.ready) {
        await this.makeTaskQueuedAfterDependencies(task, now);
        changed.push(task);
        batch.events.push({
          at: now,
          type: 'task_unblocked',
          message: `Task unblocked: ${task.id}`,
          taskId: task.id,
        });
        continue;
      }
      const before = task.blockedReason;
      this.makeTaskBlockedByDependencies(task, now, this.dependencyBlockedReason(task, dependencyState));
      if (task.blockedReason !== before) {
        changed.push(task);
        batch.events.push({
          at: now,
          type: 'task_blocked',
          message: task.blockedReason,
          taskId: task.id,
        });
      }
    }
    if (changed.length) {
      batch.updatedAt = now;
    }
    return changed;
  }

  listBatches() {
    return this.state.batchOrder
      .map((id) => this.state.batches[id])
      .filter(Boolean)
      .map((batch) => this.decorateBatch(batch))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getBatch(batchId) {
    const batch = this.state.batches[batchId];
    if (!batch) {
      throw new Error(`Unknown batch: ${batchId}`);
    }
    return {
      batch: this.decorateBatch(batch),
      tasks: (batch.taskIds || [])
        .map((id) => this.state.tasks[id])
        .filter(Boolean),
    };
  }

  listBatchArtifacts(batchId, options = {}) {
    const { batch, tasks } = this.getBatch(batchId);
    const includeSkipped = Boolean(options.includeSkipped);
    const children = [];
    let totalArtifacts = 0;
    for (const task of tasks) {
      const artifacts = includeSkipped
        ? this.listArtifacts(task.id)
        : this.listArtifacts(task.id).filter((artifact) => !artifact.skipped);
      totalArtifacts += artifacts.length;
      children.push({
        taskId: task.id,
        batchKey: task.batchKey || null,
        title: task.title,
        status: task.status,
        artifacts,
      });
    }
    return {
      batch,
      totalArtifacts,
      tasks: children,
    };
  }

  listTaskArtifacts(taskId, options = {}) {
    const task = this.getTask(taskId);
    const includeSkipped = Boolean(options.includeSkipped);
    const artifacts = includeSkipped
      ? this.listArtifacts(taskId)
      : this.listArtifacts(taskId).filter((artifact) => !artifact.skipped);
    return {
      task,
      totalArtifacts: artifacts.length,
      artifacts,
    };
  }

  async readTaskArtifacts(taskId, options = {}) {
    const listed = this.listTaskArtifacts(taskId, options);
    const artifacts = [];
    let totalBytes = 0;
    for (const artifact of listed.artifacts) {
      if (artifact.skipped) {
        artifacts.push({
          ...artifact,
          contentBase64: null,
          unavailableReason: artifact.reason || 'artifact was skipped',
        });
        continue;
      }
      const fetched = await this.readArtifact(taskId, artifact.id);
      totalBytes += fetched.artifact.size || Buffer.byteLength(fetched.contentBase64 || '', 'base64');
      artifacts.push({
        ...fetched.artifact,
        contentBase64: fetched.contentBase64,
      });
    }
    return {
      task: listed.task,
      totalArtifacts: artifacts.filter((artifact) => artifact.contentBase64).length,
      totalBytes,
      artifacts,
    };
  }

  async readBatchArtifacts(batchId, options = {}) {
    const listed = this.listBatchArtifacts(batchId, options);
    const tasks = [];
    let totalBytes = 0;
    let totalArtifacts = 0;
    for (const child of listed.tasks) {
      const artifacts = [];
      for (const artifact of child.artifacts) {
        if (artifact.skipped) {
          artifacts.push({
            ...artifact,
            contentBase64: null,
            unavailableReason: artifact.reason || 'artifact was skipped',
          });
          continue;
        }
        const fetched = await this.readArtifact(child.taskId, artifact.id);
        totalArtifacts += 1;
        totalBytes += fetched.artifact.size || Buffer.byteLength(fetched.contentBase64 || '', 'base64');
        artifacts.push({
          ...fetched.artifact,
          contentBase64: fetched.contentBase64,
        });
      }
      tasks.push({
        ...child,
        artifacts,
      });
    }
    return {
      batch: listed.batch,
      totalArtifacts,
      totalBytes,
      tasks,
    };
  }

  listSessionArtifacts(sessionId, options = {}) {
    const session = this.getSession(sessionId);
    const includeSkipped = Boolean(options.includeSkipped);
    const taskIds = [...(session.taskIds || [])].reverse();
    for (const taskId of taskIds) {
      const task = this.state.tasks[taskId];
      if (!task) {
        continue;
      }
      const artifacts = includeSkipped
        ? this.listArtifacts(taskId)
        : this.listArtifacts(taskId).filter((artifact) => !artifact.skipped);
      if (artifacts.length) {
        return {
          session,
          sourceTaskId: taskId,
          sourceTask: task,
          totalArtifacts: artifacts.length,
          artifacts,
        };
      }
    }
    return {
      session,
      sourceTaskId: null,
      sourceTask: null,
      totalArtifacts: 0,
      artifacts: [],
    };
  }

  async readSessionArtifacts(sessionId, options = {}) {
    const listed = this.listSessionArtifacts(sessionId, options);
    const artifacts = [];
    let totalBytes = 0;
    for (const artifact of listed.artifacts) {
      if (artifact.skipped) {
        artifacts.push({
          ...artifact,
          contentBase64: null,
          unavailableReason: artifact.reason || 'artifact was skipped',
        });
        continue;
      }
      const fetched = await this.readArtifact(listed.sourceTaskId, artifact.id);
      totalBytes += fetched.artifact.size || Buffer.byteLength(fetched.contentBase64 || '', 'base64');
      artifacts.push({
        ...fetched.artifact,
        contentBase64: fetched.contentBase64,
      });
    }
    return {
      session: listed.session,
      sourceTaskId: listed.sourceTaskId,
      sourceTask: listed.sourceTask,
      totalArtifacts: artifacts.filter((artifact) => artifact.contentBase64).length,
      totalBytes,
      artifacts,
    };
  }

  getBatchReport(batchId, options = {}) {
    const { batch, tasks } = this.getBatch(batchId);
    const artifactGroups = new Map(tasks.map((task) => [task.id, this.listArtifacts(task.id)]));
    return buildBatchReport(batch, tasks, {
      artifactGroups,
      stdoutChars: options.stdoutChars,
      stderrChars: options.stderrChars,
    });
  }

  async manageBatch(batchId, action, options = {}) {
    const batch = this.state.batches[batchId];
    if (!batch) {
      throw new Error(`Unknown batch: ${batchId}`);
    }
    const allowed = new Set(['retry_failed', 'cancel']);
    if (!allowed.has(action)) {
      throw new Error(`Unsupported batch action: ${action}`);
    }

    const now = nowIso();
    const retried = [];
    const cancelled = [];
    const skipped = [];
    if (action === 'cancel') {
      for (const taskId of batch.taskIds || []) {
        const task = this.state.tasks[taskId];
        if (!task) {
          continue;
        }
        if (terminalTaskStatus(task.status)) {
          skipped.push({ task, reason: `status=${task.status}` });
          continue;
        }
        await this.cancelTask(task, now, options.reason || 'Batch cancelled by gateway task management');
        cancelled.push(task);
      }
      await this.refreshBatchDependencyStates(batch.id, now);
      batch.updatedAt = now;
      batch.events.push({
        at: now,
        type: 'cancel',
        message: `Cancelled ${cancelled.length} queued/running/blocked tasks`,
        data: {
          cancelledTaskIds: cancelled.map((task) => task.id),
          skippedTaskIds: skipped.map((item) => item.task.id),
        },
      });
      await this.save();
      return {
        batch: this.decorateBatch(batch),
        cancelled,
        retried,
        skipped,
      };
    }

    const retryable = new Set(['failed', 'cancelled']);
    for (const taskId of batch.taskIds || []) {
      const task = this.state.tasks[taskId];
      if (!task) {
        continue;
      }
      if (!retryable.has(task.status)) {
        skipped.push({ task, reason: `status=${task.status}` });
        continue;
      }
      this.resetTaskForRetry(task, {
        now,
        workerId: options.workerId,
        requiredCapabilities: options.requiredCapabilities,
        requiredTools: options.requiredTools,
        slots: options.slots,
        requiredLabels: options.requiredLabels,
        requiredResources: options.requiredResources,
        reason: options.reason || 'Batch retry failed tasks',
        touchWorker: false,
      });
      retried.push(task);
    }
    await this.refreshBatchDependencyStates(batch.id, now);

    batch.updatedAt = now;
    batch.events.push({
      at: now,
      type: 'retry_failed',
      message: `Retried ${retried.length} failed/cancelled tasks`,
      data: {
        retriedTaskIds: retried.map((task) => task.id),
        skippedTaskIds: skipped.map((item) => item.task.id),
      },
    });
    await this.save();
    return {
      batch: this.decorateBatch(batch),
      cancelled,
      retried,
      skipped,
    };
  }

  decorateWorker(worker) {
    const lastSeen = worker.lastSeenAt ? Date.parse(worker.lastSeenAt) : 0;
    const ageMs = lastSeen ? Date.now() - lastSeen : Number.POSITIVE_INFINITY;
    const running = this.listTasks().filter(
      (task) => task.assignedWorkerId === worker.id && task.status === 'running',
    );
    const reserved = this.listTasks().filter(
      (task) => task.requestedWorkerId === worker.id && task.status === 'queued',
    );
    const runningSlots = running.reduce((sum, task) => sum + taskSlotCost(task), 0);
    const reservedSlots = reserved.reduce((sum, task) => sum + taskSlotCost(task), 0);
    const capacity = maxConcurrency(worker.maxConcurrency);
    const hardwareCapacity = workerResourceCapacity(worker);
    const hardwareUsed = workerResourceUsage(worker, [...running, ...reserved]);
    const hardwareAvailable = {
      cpuCores: Math.max(0, hardwareCapacity.cpuCores - hardwareUsed.cpuCores),
      memoryBytes: Math.max(0, hardwareCapacity.memoryBytes - hardwareUsed.memoryBytes),
      gpuCount: Math.max(0, hardwareCapacity.gpuCount - hardwareUsed.gpuCount),
      gpuMemoryBytes: Math.max(0, hardwareCapacity.gpuMemoryBytes - hardwareUsed.gpuMemoryBytes),
    };
    return {
      ...worker,
      gatewayState: this.gatewayState(worker, ageMs),
      active: ageMs <= ACTIVE_WINDOW_MS,
      ageMs,
      maxConcurrency: capacity,
      runningTasks: running.length,
      reservedTasks: reserved.length,
      runningSlots,
      reservedSlots,
      availableSlots: Math.max(0, capacity - runningSlots - reservedSlots),
      resources: {
        ...workerResourceDiagnostics(worker),
        reservations: {
          capacity: {
            cpuCores: hardwareCapacity.cpuCores,
            memoryBytes: hardwareCapacity.memoryBytes,
            gpuCount: hardwareCapacity.gpuCount,
            gpuMemoryBytes: hardwareCapacity.gpuMemoryBytes,
          },
          used: hardwareUsed,
          available: hardwareAvailable,
        },
      },
      readiness: workerReadinessDiagnostics(worker),
    };
  }

  appendWorkerEvent(worker, event = {}) {
    worker.events = normalizeWorkerEvents(worker.events);
    const eventId = String(event.id || '').trim().slice(0, 120) || newId('wev');
    const existing = worker.events.find((candidate) => candidate.id === eventId);
    if (existing) {
      return existing;
    }
    const item = {
      id: eventId,
      at: event.at || nowIso(),
      type: event.type || 'log',
      level: event.level || 'info',
      message: String(event.message || ''),
      workerId: worker.id,
      data: event.data || undefined,
    };
    worker.events.push(item);
    if (worker.events.length > 300) {
      worker.events = worker.events.slice(worker.events.length - 300);
    }
    return item;
  }

  async addWorkerEvent(workerId, event = {}) {
    const worker = this.state.workers[workerId];
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    if (CONTROL_ONLY_WORKER_EVENT_TYPES.has(event.type)) {
      const error = new Error(`Worker event type ${event.type} is reserved for control-observed events`);
      error.status = 400;
      throw error;
    }
    const item = this.appendWorkerEvent(worker, event);
    worker.lastEventAt = item.at;
    if (item.type === 'agent_self_test') {
      worker.diagnostics ??= {};
      worker.diagnostics.agentSelfTest = {
        at: item.at,
        status: item.data?.status || 'unknown',
        taskId: item.data?.taskId || null,
        exitCode: item.data?.exitCode ?? null,
        error: item.data?.error || null,
      };
    }
    if (item.type === 'self_test') {
      worker.diagnostics ??= {};
      worker.diagnostics.selfTest = {
        at: item.at,
        status: item.data?.status || 'unknown',
        taskId: item.data?.taskId || null,
        exitCode: item.data?.exitCode ?? null,
        error: item.data?.error || null,
      };
    }
    const taskId = String(item.data?.taskId || '').trim();
    const task = taskId ? this.state.tasks[taskId] : null;
    const attemptId = String(item.data?.attemptId || '').trim() || null;
    const attempt = attemptId
      ? task?.attempts?.find((candidate) => candidate.id === attemptId) || null
      : null;
    const workerBoundToTask = Boolean(
      task
      && (
        task.assignedWorkerId === workerId
        || task.requestedWorkerId === workerId
        || task.attempts?.some((candidate) => candidate.workerId === workerId)
      )
    );
    let taskEvent = null;
    if (
      workerBoundToTask
      && item.type === 'command_applied'
      && item.data?.action === 'cancel_current'
    ) {
      taskEvent = {
        type: 'worker_cancel_applied',
        message: `Worker ${workerId} applied cancel_current`,
        workerId,
        attemptId,
        data: { workerEventId: item.id },
      };
    } else if (
      workerBoundToTask
      && item.type === 'task_released'
      && attempt?.workerId === workerId
    ) {
      taskEvent = {
        type: 'worker_process_released',
        message: `Worker ${workerId} released task process`,
        workerId,
        attemptId,
        data: { workerEventId: item.id },
      };
    }
    if (taskEvent && !task.events?.some((candidate) => (
      candidate.type === taskEvent.type
      && candidate.workerId === workerId
      && (candidate.attemptId || null) === attemptId
    ))) {
      task.events ??= [];
      task.events.push({ at: item.at, ...taskEvent });
    }
    await this.save();
    return item;
  }

  async addAuditEvent(event = {}) {
    const item = {
      id: event.id || newId('audit'),
      at: event.at || nowIso(),
      requestId: String(event.requestId || '').slice(0, 80) || null,
      actorType: String(event.actorType || 'anonymous').slice(0, 40),
      actorId: String(event.actorId || '').slice(0, 120) || null,
      method: String(event.method || '').slice(0, 16).toUpperCase(),
      path: String(event.path || '').slice(0, 500),
      statusCode: Number(event.statusCode || 0),
      outcome: event.outcome === 'denied' || event.outcome === 'error' ? event.outcome : 'success',
      remoteAddress: String(event.remoteAddress || '').slice(0, 120) || null,
      userAgent: String(event.userAgent || '').slice(0, 300) || null,
      durationMs: Math.max(0, Number(event.durationMs || 0)),
      error: String(event.error || '').slice(0, 500) || null,
    };
    this.state.auditEvents.push(item);
    if (this.state.auditEvents.length > 5_000) {
      this.state.auditEvents = this.state.auditEvents.slice(-5_000);
    }
    await this.save();
    return item;
  }

  listAuditEvents(options = {}) {
    const tail = Math.max(0, Math.min(1_000, Number(options.tail ?? 100)));
    const actorType = options.actorType ? String(options.actorType) : null;
    const outcome = options.outcome ? String(options.outcome) : null;
    const statusCode = options.statusCode === undefined || options.statusCode === null
      ? null
      : Number(options.statusCode);
    const filtered = this.state.auditEvents.filter((event) => (
      (!actorType || event.actorType === actorType)
      && (!outcome || event.outcome === outcome)
      && (statusCode === null || event.statusCode === statusCode)
    ));
    return tail ? filtered.slice(-tail) : [];
  }

  listWorkerEvents(workerId, options = {}) {
    const worker = this.state.workers[workerId];
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    const events = normalizeWorkerEvents(worker.events);
    const tail = options.tail === undefined || options.tail === null
      ? null
      : Math.max(0, Number(options.tail || 0));
    return {
      workerId,
      worker: this.decorateWorker(worker),
      events: tail === null ? events : events.slice(-tail),
    };
  }

  gatewayState(worker, ageMs) {
    if (ageMs > ACTIVE_WINDOW_MS) {
      return 'offline';
    }
    if (worker.adminState === 'shutdown_requested') {
      return 'shutdown_requested';
    }
    if (worker.adminState === 'paused') {
      return 'paused';
    }
    if (worker.adminState === 'draining') {
      return worker.currentTaskIds?.length ? 'draining_running' : 'drained';
    }
    if (worker.currentTaskIds?.length || worker.observedState === 'running') {
      return 'running';
    }
    return worker.observedState || 'idle';
  }

  async createTask(input) {
    const idempotencyKey = String(input.idempotencyKey || '').trim() || null;
    if (idempotencyKey) {
      const existing = this.listTasks().find((candidate) => candidate.idempotencyKey === idempotencyKey
        && (candidate.batchId || null) === (input.batchId || null)
        && (candidate.sessionId || null) === (input.sessionId || null));
      if (existing) {
        return existing;
      }
    }
    const now = nowIso();
    const retryBackoffMs = normalizeRetryBackoffMs(input.retryBackoffMs);
    const task = {
      id: newId('task'),
      title: input.title || input.command || input.prompt || 'untitled task',
      type: input.type || 'shell',
      status: input.status || 'queued',
      priority: Number(input.priority || 0),
      slots: normalizeTaskSlots(input.slots || input.taskSlots),
      command: input.command || null,
      prompt: input.prompt || null,
      requestedWorkerId: input.workerId || null,
      assignedWorkerId: null,
      sessionId: input.sessionId || null,
      batchId: input.batchId || null,
      batchKey: input.batchKey || null,
      dependencyKeys: normalizeStringList(input.dependencyKeys || input.dependsOn),
      dependsOnTaskIds: normalizeTaskIds(input.dependsOnTaskIds),
      blockedReason: input.status === 'blocked' ? 'Waiting for dependencies' : null,
      requiredCapabilities: Array.from(new Set(input.requiredCapabilities || [])),
      requiredTools: normalizeToolList(input.requiredTools || input.tools),
      requiredLabels: normalizeLabels(input.requiredLabels || input.labels),
      requiredResources: normalizeResourceRequirements(input.requiredResources || input.resources),
      env: normalizeEnv(input.env),
      sandboxProfile: normalizeSandboxProfile(input.sandboxProfile ?? input.sandbox),
      artifactPolicy: normalizeArtifactPolicy(input.artifactPolicy),
      dependencyArtifacts: normalizeDependencyArtifacts(input.dependencyArtifacts),
      dependencyInputFiles: [],
      inputFiles: input.inputFiles || [],
      inputReadyStatus: null,
      attemptSeq: Number(input.attemptSeq || 0),
      currentAttemptId: input.currentAttemptId || null,
      attempts: Array.isArray(input.attempts) ? input.attempts : [],
      maxAttempts: normalizeMaxAttempts(input.maxAttempts),
      retryPolicy: normalizeRetryPolicy(input.retryPolicy, { strict: true }),
      retryBackoffMs,
      maxRetryBackoffMs: Math.max(
        retryBackoffMs,
        normalizeRetryBackoffMs(input.maxRetryBackoffMs, DEFAULT_MAX_RETRY_BACKOFF_MS),
      ),
      notBeforeAt: input.notBeforeAt || null,
      lease: null,
      idempotencyKey,
      keepWorkspace: typeof input.keepWorkspace === 'boolean' ? input.keepWorkspace : undefined,
      timeoutMs: Number(input.timeoutMs || 10 * 60 * 1000),
      maxOutputChars: Number(input.maxOutputChars || 80_000),
      createdControlInstanceId: String(input.controlInstanceId || '').trim() || null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      exitCode: null,
      failureKind: null,
      stdout: '',
      stderr: '',
      error: null,
      workspace: null,
      workspaceCleaned: false,
      artifacts: [],
      events: [
        {
          at: now,
          type: input.status === 'blocked' ? 'blocked' : 'queued',
          message: input.status === 'blocked' ? 'Task blocked waiting for dependencies' : 'Task queued',
        },
      ],
    };

    if (task.sessionId) {
      const session = this.getSession(task.sessionId);
      if (session.status !== 'open') {
        throw new Error(`Session is not open: ${task.sessionId}`);
      }
      task.requestedWorkerId = task.requestedWorkerId || session.assignedWorkerId || session.requestedWorkerId;
      task.requiredCapabilities = task.requiredCapabilities.length
        ? task.requiredCapabilities
        : [...session.requiredCapabilities];
      task.requiredTools = task.requiredTools.length
        ? task.requiredTools
        : [...(session.requiredTools || [])];
      task.requiredLabels = Object.keys(task.requiredLabels).length
        ? task.requiredLabels
        : { ...(session.requiredLabels || {}) };
      task.requiredResources = resourceRequirementsEmpty(task.requiredResources)
        ? { ...(session.requiredResources || {}) }
        : task.requiredResources;
      session.taskIds.push(task.id);
      session.updatedAt = now;
      session.events.push({
        at: now,
        type: 'task_queued',
        message: `Task queued: ${task.id}`,
        taskId: task.id,
      });
    }

    if (input.requireRoutable) {
      const plan = buildDispatchPlan({
        title: task.title,
        tasks: [task],
      }, {
        workers: this.listWorkers(),
        tasks: this.listTasks(),
        sessions: this.listSessions(),
      });
      const error = requireRoutableError(plan);
      if (error) {
        throw error;
      }
    }

    await this.initializeTaskInputUploads(task);

    if (task.status === 'uploading_inputs') {
      task.scheduler = {
        workerId: null,
        reason: 'waiting for control-side input uploads',
        candidates: [],
      };
    } else if (task.status === 'blocked') {
      task.scheduler = {
        workerId: null,
        reason: 'blocked by dependencies',
        candidates: [],
      };
    } else if (!task.requestedWorkerId) {
      this.scheduleQueuedTask(task, now, 'scheduled');
    } else {
      task.scheduler = scheduleTask({
        task,
        workers: this.listWorkers(),
        tasks: this.listTasks(),
        session: task.sessionId ? this.getSession(task.sessionId) : null,
      });
    }

    this.state.tasks[task.id] = task;
    this.state.taskOrder.push(task.id);
    await this.save();
    this.notifyClaimWaiters();
    return task;
  }

  async initializeTaskInputUploads(task) {
    const normalized = [];
    let pending = 0;
    for (const file of task.inputFiles || []) {
      if (file.contentBase64 !== undefined) {
        normalized.push(file);
        continue;
      }
      if (file.localPath) {
        const error = new Error(`Control-side localPath cannot be persisted in task input: ${file.path}`);
        error.status = 400;
        throw error;
      }
      if (file.transfer !== 'chunked') {
        const error = new Error(`Input file requires contentBase64 or chunked transfer: ${file.path}`);
        error.status = 400;
        throw error;
      }
      const inputPath = String(file.path || '').replaceAll('\\', '/').replace(/^\/+/, '');
      const size = Number(file.size);
      const sha256 = String(file.sha256 || '').toLowerCase() || null;
      const serverDigest = file.digestMode === 'server';
      if (!inputPath || inputPath.includes('\0') || !Number.isSafeInteger(size) || size < 0 || (!serverDigest && !/^[a-f0-9]{64}$/.test(sha256 || ''))) {
        const error = new Error(`Chunked input requires valid path, size, and SHA-256: ${file.path || '(missing path)'}`);
        error.status = 400;
        throw error;
      }
      const id = newId('input');
      const dir = path.join(this.inputDir, safeName(task.id));
      await ensureDir(dir);
      const tempPath = path.join(dir, `${safeName(id)}.part`);
      await fs.writeFile(tempPath, Buffer.alloc(0));
      const now = nowIso();
      const upload = {
        id,
        taskId: task.id,
        path: inputPath,
        size,
        sha256,
        digestMode: serverDigest ? 'server' : 'client',
        status: 'pending',
        committedBytes: 0,
        tempPath,
        storagePath: null,
        createdAt: now,
        updatedAt: now,
        finalizedAt: null,
      };
      this.state.inputUploads[id] = upload;
      this.state.inputUploadOrder.push(id);
      normalized.push({
        path: inputPath,
        size,
        sha256,
        digestMode: serverDigest ? 'server' : 'client',
        transfer: 'chunked',
        inputUploadId: id,
        ready: false,
      });
      pending += 1;
    }
    task.inputFiles = normalized;
    if (pending) {
      task.inputReadyStatus = task.status;
      task.status = 'uploading_inputs';
      task.blockedReason = `Waiting for ${pending} control-side input upload(s)`;
      task.events = [{
        at: task.createdAt,
        type: 'uploading_inputs',
        message: task.blockedReason,
      }];
    }
  }

  scheduleQueuedTask(task, now = nowIso(), eventType = 'scheduled') {
    const session = task.sessionId ? this.getSession(task.sessionId) : null;
    const scheduling = scheduleTask({
      task,
      workers: this.listWorkers(),
      tasks: this.listTasks(),
      session,
    });
    task.scheduler = scheduling;
    if (scheduling.workerId) {
      task.requestedWorkerId = scheduling.workerId;
    }
    task.updatedAt = now;
    task.events.push({
      at: now,
      type: eventType,
      message: scheduling.reason,
      data: scheduling,
    });
    if (session && scheduling.workerId && !session.assignedWorkerId) {
      session.requestedWorkerId = scheduling.workerId;
      session.updatedAt = now;
      session.events.push({
        at: now,
        type: eventType,
        message: `Task ${task.id} ${eventType}: ${scheduling.reason}`,
        taskId: task.id,
        workerId: scheduling.workerId,
      });
    }
    return scheduling;
  }

  listTasks() {
    return this.state.taskOrder
      .map((id) => this.state.tasks[id])
      .filter(Boolean)
      .sort((a, b) => (
        Number(b.priority || 0) - Number(a.priority || 0)
        || a.createdAt.localeCompare(b.createdAt)
      ));
  }

  taskRuntimeDiagnostics(taskOrId, options = {}) {
    const task = typeof taskOrId === 'string' ? this.getTask(taskOrId) : taskOrId;
    const workerId = task?.assignedWorkerId || task?.requestedWorkerId || null;
    const worker = Object.hasOwn(options, 'worker')
      ? options.worker
      : (workerId && this.state.workers[workerId]
        ? this.decorateWorker(this.state.workers[workerId])
        : null);
    const session = Object.hasOwn(options, 'session')
      ? options.session
      : (task?.sessionId ? this.state.sessions[task.sessionId] || null : null);
    return buildTaskRuntimeDiagnostics(task, {
      worker,
      session,
      nowMs: options.nowMs,
    });
  }

  decorateTask(taskOrId, options = {}) {
    const task = typeof taskOrId === 'string' ? this.getTask(taskOrId) : taskOrId;
    const runtimeDiagnostics = this.taskRuntimeDiagnostics(task, options);
    const routingNextAction = routingActionHint(task);
    return {
      ...task,
      nextAction: runtimeDiagnostics.nextAction || routingNextAction,
      routingNextAction,
      runtimeDiagnostics,
    };
  }

  listTaskViews(options = {}) {
    const workerById = new Map(this.listWorkers().map((worker) => [worker.id, worker]));
    return this.listTasks().map((task) => {
      const workerId = task.assignedWorkerId || task.requestedWorkerId || null;
      return this.decorateTask(task, {
        ...options,
        worker: workerById.get(workerId) || null,
        session: task.sessionId ? this.state.sessions[task.sessionId] || null : null,
      });
    });
  }

  listPrunableTasks(options = {}) {
    const keep = Math.max(0, Number(options.keep ?? 20));
    const terminalStandalone = this.state.taskOrder
      .map((id) => this.state.tasks[id])
      .filter(Boolean)
      .filter((task) => terminalTaskStatus(task.status))
      .filter((task) => !task.batchId && !task.sessionId)
      .sort((a, b) => taskSortTime(b) - taskSortTime(a) || b.id.localeCompare(a.id));
    const retained = terminalStandalone.slice(0, keep);
    const prunable = terminalStandalone.slice(keep);
    return {
      keep,
      totalStandaloneTerminal: terminalStandalone.length,
      retained: retained.map((task) => task.id),
      tasks: prunable,
    };
  }

  dropArtifactUploadRecordsForTask(taskId) {
    const removed = new Set(
      this.state.artifactUploadOrder.filter((id) => this.state.artifactUploads[id]?.taskId === taskId),
    );
    for (const id of removed) {
      delete this.state.artifactUploads[id];
      this.artifactUploadQueues.delete(id);
    }
    if (removed.size) {
      this.state.artifactUploadOrder = this.state.artifactUploadOrder.filter((id) => !removed.has(id));
    }
    return removed.size;
  }

  dropInputUploadRecordsForTask(taskId) {
    const removed = new Set(
      this.state.inputUploadOrder.filter((id) => this.state.inputUploads[id]?.taskId === taskId),
    );
    for (const id of removed) {
      delete this.state.inputUploads[id];
      this.inputUploadQueues.delete(id);
    }
    if (removed.size) {
      this.state.inputUploadOrder = this.state.inputUploadOrder.filter((id) => !removed.has(id));
    }
    return removed.size;
  }

  async pruneTaskHistory(options = {}) {
    const preview = this.listPrunableTasks(options);
    const pruned = [];
    for (const task of preview.tasks) {
      delete this.state.tasks[task.id];
      this.dropArtifactUploadRecordsForTask(task.id);
      this.dropInputUploadRecordsForTask(task.id);
      pruned.push({
        id: task.id,
        title: task.title,
        status: task.status,
        completedAt: task.completedAt || null,
      });
      await fs.rm(path.join(this.artifactDir, safeName(task.id)), { recursive: true, force: true });
      await fs.rm(path.join(this.inputDir, safeName(task.id)), { recursive: true, force: true });
    }
    if (pruned.length) {
      const removed = new Set(pruned.map((task) => task.id));
      this.state.taskOrder = this.state.taskOrder.filter((id) => !removed.has(id));
      await this.save();
    }
    return {
      keep: preview.keep,
      totalStandaloneTerminal: preview.totalStandaloneTerminal,
      pruned,
      prunedCount: pruned.length,
    };
  }

  listPrunableSystemHistory() {
    const batches = this.listBatches()
      .filter((batch) => terminalBatchStatus(batch.status))
      .filter(isSystemBatch)
      .sort((a, b) => taskSortTime(b) - taskSortTime(a) || b.id.localeCompare(a.id));
    const batchIds = new Set(batches.map((batch) => batch.id));
    const taskIdsFromBatches = new Set(
      batches.flatMap((batch) => batch.taskIds || []),
    );
    const tasks = this.state.taskOrder
      .map((id) => this.state.tasks[id])
      .filter(Boolean)
      .filter((task) => terminalTaskStatus(task.status))
      .filter((task) => taskIdsFromBatches.has(task.id) || (!task.sessionId && isSystemTask(task)))
      .sort((a, b) => taskSortTime(b) - taskSortTime(a) || b.id.localeCompare(a.id));
    return {
      batches,
      batchIds,
      tasks,
      taskIds: new Set(tasks.map((task) => task.id)),
    };
  }

  async pruneSystemHistory() {
    const preview = this.listPrunableSystemHistory();
    const taskIds = new Set(preview.taskIds);
    const batchIds = new Set(preview.batchIds);
    for (const batchId of batchIds) {
      const batch = this.state.batches[batchId];
      for (const taskId of batch?.taskIds || []) {
        taskIds.add(taskId);
      }
    }
    const prunedTasks = [];
    for (const taskId of taskIds) {
      const task = this.state.tasks[taskId];
      if (!task || !terminalTaskStatus(task.status)) {
        continue;
      }
      delete this.state.tasks[taskId];
      this.dropArtifactUploadRecordsForTask(taskId);
      this.dropInputUploadRecordsForTask(taskId);
      prunedTasks.push({
        id: task.id,
        title: task.title,
        status: task.status,
        completedAt: task.completedAt || null,
      });
      await fs.rm(path.join(this.artifactDir, safeName(task.id)), { recursive: true, force: true });
      await fs.rm(path.join(this.inputDir, safeName(task.id)), { recursive: true, force: true });
    }
    const prunedBatches = [];
    for (const batchId of batchIds) {
      const batch = this.state.batches[batchId];
      if (!batch) {
        continue;
      }
      const decorated = preview.batches.find((candidate) => candidate.id === batchId);
      delete this.state.batches[batchId];
      prunedBatches.push({
        id: batch.id,
        title: batch.title,
        status: decorated?.status || batch.status,
      });
    }
    if (prunedTasks.length || prunedBatches.length) {
      this.state.taskOrder = this.state.taskOrder.filter((id) => !taskIds.has(id));
      this.state.batchOrder = this.state.batchOrder.filter((id) => !batchIds.has(id));
      for (const session of Object.values(this.state.sessions)) {
        session.taskIds = (session.taskIds || []).filter((id) => !taskIds.has(id));
      }
      await this.save();
    }
    return {
      prunedTasks,
      prunedBatches,
      prunedTaskCount: prunedTasks.length,
      prunedBatchCount: prunedBatches.length,
    };
  }

  getTask(taskId) {
    const task = this.state.tasks[taskId];
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    return task;
  }

  async claimTask(workerId, options = {}) {
    const worker = this.state.workers[workerId];
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    worker.maxConcurrency = maxConcurrency(worker.maxConcurrency);
    worker.currentTaskIds = normalizeTaskIds(worker.currentTaskIds, worker.currentTaskId);
    worker.currentTaskId = worker.currentTaskIds[0] || null;
    const protocolReadiness = protocolReadinessForWorker(worker);
    if (!protocolReadiness.eligible) {
      const at = nowIso();
      const protocolReason = protocolReadiness.reasons[0];
      let stateChanged = false;
      for (const task of this.listTasks()) {
        if (task.status !== 'queued') {
          continue;
        }
        const session = task.sessionId ? this.state.sessions[task.sessionId] : null;
        const targetsWorker = task.requestedWorkerId === workerId
          || session?.assignedWorkerId === workerId
          || session?.requestedWorkerId === workerId;
        const alreadyDiagnosed = (task.scheduler?.candidates || []).some((candidate) => (
          candidate.workerId === workerId && (candidate.reasons || []).includes(protocolReason)
        ));
        if (!targetsWorker || alreadyDiagnosed) {
          continue;
        }
        task.scheduler = scheduleTask({
          task,
          workers: this.listWorkers(),
          tasks: this.listTasks(),
          session,
        });
        task.updatedAt = at;
        task.events.push({
          at,
          type: 'protocol_incompatible',
          message: protocolReason,
          workerId,
          data: {
            workerProtocolVersion: protocolReadiness.workerProtocolVersion,
            controlProtocolVersion: protocolReadiness.controlProtocolVersion,
          },
        });
        stateChanged = true;
      }
      if (options.touchWorker !== false) {
        worker.lastSeenAt = at;
        stateChanged = true;
      }
      if (stateChanged) {
        await this.save();
      }
      return null;
    }
    const runningSlots = this.listTasks()
      .filter((candidate) => candidate.assignedWorkerId === workerId && candidate.status === 'running')
      .reduce((sum, candidate) => sum + taskSlotCost(candidate), 0);
    if (runningSlots >= worker.maxConcurrency) {
      if (options.touchWorker !== false) {
        worker.lastSeenAt = nowIso();
        await this.save();
      }
      return null;
    }

    const task = this.listTasks().find((candidate) => {
      if (candidate.status !== 'queued') {
        return false;
      }
      if (candidate.notBeforeAt && Date.parse(candidate.notBeforeAt) > Date.now()) {
        return false;
      }
      if (worker.adminState !== 'enabled') {
        return false;
      }
      if (candidate.sessionId) {
        const session = this.state.sessions[candidate.sessionId];
        if (!session || session.status !== 'open') {
          return false;
        }
        if (session.assignedWorkerId && session.assignedWorkerId !== workerId) {
          return false;
        }
        if (session.requestedWorkerId && session.requestedWorkerId !== workerId) {
          return false;
        }
        if (session.currentTaskId) {
          return false;
        }
        if (!isSubset(effectiveRequiredCapabilities(session), worker.capabilities)) {
          return false;
        }
        if (missingRequiredTools(session, worker).length) {
          return false;
        }
        if (!hasLabels(session.requiredLabels || {}, worker.labels || {})) {
          return false;
        }
      }
      if (candidate.requestedWorkerId && candidate.requestedWorkerId !== workerId) {
        return false;
      }
      if (!agentReadinessForTask(candidate, worker).eligible) {
        return false;
      }
      if (!resourceFitForTask(candidate, worker, this.listTasks()).eligible) {
        return false;
      }
      if (runningSlots + taskSlotCost(candidate) > worker.maxConcurrency) {
        return false;
      }
      return isSubset(effectiveRequiredCapabilities(candidate), worker.capabilities)
        && !missingRequiredTools(candidate, worker).length
        && hasLabels(candidate.requiredLabels || {}, worker.labels || {});
    });

    if (!task) {
      if (options.touchWorker !== false) {
        worker.lastSeenAt = nowIso();
        await this.save();
      }
      return null;
    }

    const now = nowIso();
    const nowMs = Date.parse(now);
    const attemptId = newId('attempt');
    task.status = 'running';
    task.assignedWorkerId = workerId;
    task.attemptSeq = Number(task.attemptSeq || 0) + 1;
    task.currentAttemptId = attemptId;
    task.notBeforeAt = null;
    const leaseDurationMs = normalizeTaskLeaseMs(this.taskLeaseMs);
    const leaseExpiresAt = new Date(nowMs + leaseDurationMs).toISOString();
    task.lease = {
      attemptId,
      workerId,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: leaseExpiresAt,
      durationMs: leaseDurationMs,
    };
    task.attempts ??= [];
    task.attempts.push({
      id: attemptId,
      seq: task.attemptSeq,
      workerId,
      claimedAt: now,
      completedAt: null,
      status: 'running',
      leaseRenewedAt: now,
      leaseExpiresAt,
    });
    task.startedAt = now;
    task.updatedAt = now;
    worker.currentTaskIds = normalizeTaskIds(worker.currentTaskIds, task.id);
    worker.currentTaskId = worker.currentTaskIds[0] || null;
    worker.observedState = 'running';
    worker.lastSeenAt = now;
    if (task.sessionId) {
      const session = this.getSession(task.sessionId);
      session.assignedWorkerId = session.assignedWorkerId || workerId;
      session.currentTaskId = task.id;
      session.updatedAt = now;
      session.events.push({
        at: now,
        type: 'task_claimed',
        message: `Task ${task.id} claimed by ${workerId}`,
        taskId: task.id,
        workerId,
      });
    }
    task.events.push({
      at: now,
      type: 'claimed',
      message: `Claimed by ${workerId}`,
      workerId,
      data: {
        attemptId,
        attemptSeq: task.attemptSeq,
      },
    });
    this.appendWorkerEvent(worker, {
      at: now,
      type: 'task_claimed',
      level: 'info',
      message: `Claimed task ${task.id}: ${task.title}`,
      data: {
        taskId: task.id,
        attemptId,
        attemptSeq: task.attemptSeq,
      },
    });
    const claimedResult = options.snapshotResult
      ? JSON.parse(JSON.stringify(task))
      : task;
    await this.save();
    return claimedResult;
  }

  getWorker(workerId) {
    const worker = this.state.workers[workerId];
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    return this.decorateWorker(worker);
  }

  async manageWorker(workerId, action, reason = '') {
    const worker = this.state.workers[workerId];
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    const now = nowIso();
    const allowed = new Set(['pause', 'resume', 'drain', 'shutdown', 'cancel_current', 'rotate_token']);
    if (!allowed.has(action)) {
      throw new Error(`Unsupported worker action: ${action}`);
    }

    if (action === 'pause') {
      worker.adminState = 'paused';
    } else if (action === 'resume') {
      worker.adminState = 'enabled';
    } else if (action === 'drain') {
      worker.adminState = 'draining';
    } else if (action === 'shutdown') {
      worker.adminState = 'shutdown_requested';
    }

    const command = {
      id: newId('cmd'),
      workerId,
      action,
      reason,
      status: 'queued',
      createdAt: now,
      acknowledgedAt: null,
      completedAt: null,
    };
    worker.commands ??= [];
    worker.commands.push(command);
    this.state.commandOrder.push(command.id);
    this.appendWorkerEvent(worker, {
      at: now,
      type: 'command_queued',
      level: action === 'shutdown' || action === 'cancel_current' ? 'warn' : 'info',
      message: `Queued worker command ${action}`,
      data: {
        commandId: command.id,
        action,
        reason,
      },
    });
    await this.save();
    this.notifyClaimWaiters();
    return { worker: this.decorateWorker(worker), command };
  }

  async forgetWorker(workerId, options = {}) {
    const worker = this.state.workers[workerId];
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    const decorated = this.decorateWorker(worker);
    const allowedStates = new Set(['offline', 'shutdown_requested', 'drained']);
    if (!allowedStates.has(decorated.gatewayState)) {
      throw new Error(`Worker ${workerId} must be offline, shutdown_requested, or drained before it can be forgotten`);
    }
    const blockers = this.listTasks().filter((task) => {
      const belongsToWorker = task.assignedWorkerId === workerId || task.requestedWorkerId === workerId;
      return belongsToWorker && !terminalTaskStatus(task.status);
    });
    if (blockers.length) {
      throw new Error(`Worker ${workerId} still has ${blockers.length} non-terminal task(s)`);
    }

    const now = nowIso();
    const commandIds = new Set((worker.commands || []).map((command) => command.id));
    const revokedWorkerTokens = [];
    for (const token of Object.values(this.state.workerTokens || {})) {
      if (token.workerId === workerId && !token.revokedAt) {
        token.revokedAt = now;
        revokedWorkerTokens.push(publicWorkerToken(token));
      }
    }
    delete this.state.workers[workerId];
    this.state.commandOrder = (this.state.commandOrder || []).filter((id) => !commandIds.has(id));
    await this.save();
    return {
      worker: decorated,
      forgottenAt: now,
      reason: options.reason || '',
      revokedWorkerTokens,
      removedCommandCount: commandIds.size,
    };
  }

  async acknowledgeCommand(workerId, commandId, status = 'acknowledged', message = '', result = null) {
    const worker = this.state.workers[workerId];
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    const command = (worker.commands || []).find((candidate) => candidate.id === commandId);
    if (!command) {
      throw new Error(`Unknown command: ${commandId}`);
    }
    const now = nowIso();
    command.status = status;
    command.message = message;
    command.result = result && typeof result === 'object' && !Array.isArray(result) ? result : null;
    if (!command.acknowledgedAt) {
      command.acknowledgedAt = now;
    }
    if (status === 'completed' || status === 'failed') {
      command.completedAt = now;
    }
    this.appendWorkerEvent(worker, {
      at: now,
      type: 'command_ack',
      level: status === 'failed' ? 'error' : 'info',
      message: `Worker command ${command.action} ${status}`,
      data: {
        commandId,
        action: command.action,
        status,
        message,
        result: command.result,
      },
    });
    await this.save();
    return command;
  }

  async addTaskEvent(taskId, event) {
    const task = this.getTask(taskId);
    const suppliedEventId = String(event.id || '').trim().slice(0, 120) || null;
    if (suppliedEventId) {
      const existing = task.events.find((candidate) => candidate.id === suppliedEventId);
      if (existing) {
        return existing;
      }
    }
    if (task.status === 'running' && leaseExpired(task)) {
      return {
        id: suppliedEventId,
        at: event.at || nowIso(),
        type: 'expired_lease_event_ignored',
        message: 'Ignored event because the task attempt lease expired',
        workerId: event.workerId || task.assignedWorkerId || null,
        data: {
          currentAttemptId: task.currentAttemptId || null,
          eventAttemptId: event.attemptId || null,
          leaseExpiresAt: task.lease?.expiresAt || null,
        },
        ignored: true,
      };
    }
    if (task.currentAttemptId && event.attemptId !== task.currentAttemptId) {
      return {
        id: suppliedEventId,
        at: event.at || nowIso(),
        type: 'stale_event_ignored',
        message: 'Ignored event for a stale task attempt',
        workerId: event.workerId || task.assignedWorkerId || null,
        data: {
          currentAttemptId: task.currentAttemptId,
          eventAttemptId: event.attemptId || null,
        },
        ignored: true,
      };
    }
    const item = {
      id: suppliedEventId || newId('tev'),
      at: event.at || nowIso(),
      type: event.type || 'event',
      message: event.message || '',
      workerId: event.workerId || task.assignedWorkerId || null,
      attemptId: event.attemptId || null,
      data: event.data || undefined,
    };
    task.events.push(item);
    task.updatedAt = item.at;
    if (task.events.length > 300) {
      task.events = task.events.slice(task.events.length - 300);
    }
    await this.save();
    return item;
  }

  async completeTask(taskId, result) {
    const task = this.getTask(taskId);
    const now = nowIso();
    if (task.status !== 'running') {
      task.events.push({
        at: now,
        type: 'late_result_ignored',
        message: `Ignored result for non-running task status=${task.status}`,
        workerId: task.assignedWorkerId,
        data: {
          currentAttemptId: task.currentAttemptId || null,
          resultAttemptId: result.attemptId || null,
        },
      });
      await this.save();
      return task;
    }
    if (leaseExpired(task, Date.parse(now))) {
      task.events.push({
        at: now,
        type: 'expired_lease_result_ignored',
        message: 'Ignored result because the task attempt lease expired',
        workerId: task.assignedWorkerId,
        data: {
          currentAttemptId: task.currentAttemptId || null,
          resultAttemptId: result.attemptId || null,
          leaseExpiresAt: task.lease?.expiresAt || null,
        },
      });
      await this.save();
      return task;
    }
    if (task.currentAttemptId && result.attemptId !== task.currentAttemptId) {
      task.events.push({
        at: now,
        type: 'stale_result_ignored',
        message: 'Ignored result for a stale task attempt',
        workerId: task.assignedWorkerId,
        data: {
          currentAttemptId: task.currentAttemptId,
          resultAttemptId: result.attemptId || null,
        },
      });
      await this.save();
      return task;
    }
    const completionStatus = result.status || (result.exitCode === 0 ? 'succeeded' : 'failed');
    const failureKind = normalizeTaskFailureKind(result.failureKind)
      || (completionStatus === 'cancelled' ? 'cancelled' : completionStatus === 'failed' ? 'nonzero_exit' : null);
    const retryMatch = completionStatus === 'failed'
      ? retryPolicyMatch(task.retryPolicy, { exitCode: result.exitCode, failureKind })
      : { matched: false };
    const retryExhausted = retryMatch.matched
      && Number(task.attemptSeq || 0) >= normalizeMaxAttempts(task.maxAttempts);
    if (retryMatch.matched && !retryExhausted) {
      const previousWorkerId = task.assignedWorkerId;
      const previousAttemptId = task.currentAttemptId;
      const attempt = (task.attempts || []).find((item) => item.id === previousAttemptId);
      if (attempt) {
        attempt.exitCode = result.exitCode ?? null;
        attempt.failureKind = failureKind;
      }
      const delayMs = retryDelayMs(task);
      const notBeforeAt = delayMs ? new Date(Date.parse(now) + delayMs).toISOString() : null;
      const preserveExplicitWorker = String(task.scheduler?.reason || '').startsWith('explicit worker');
      const matchedReason = retryMatch.matchedFailureKind || `exit code ${retryMatch.matchedExitCode}`;
      const retryReason = `Retryable ${matchedReason} failure on attempt ${task.attemptSeq}/${task.maxAttempts}`;
      this.resetTaskForRetry(task, {
        now,
        workerId: preserveExplicitWorker ? task.requestedWorkerId : undefined,
        attemptStatus: 'retryable_failure',
        reason: retryReason,
        notBeforeAt,
      });
      task.events.push({
        at: now,
        type: 'retry_scheduled',
        message: retryReason,
        workerId: previousWorkerId,
        data: {
          attemptId: previousAttemptId,
          attemptSeq: task.attemptSeq,
          maxAttempts: task.maxAttempts,
          exitCode: result.exitCode ?? null,
          failureKind,
          matchedFailureKind: retryMatch.matchedFailureKind,
          matchedExitCode: retryMatch.matchedExitCode,
          retryDelayMs: delayMs,
          notBeforeAt,
        },
      });
      const worker = previousWorkerId ? this.state.workers[previousWorkerId] : null;
      if (worker) {
        this.appendWorkerEvent(worker, {
          at: now,
          type: 'task_retry_scheduled',
          level: 'warning',
          message: `Task ${task.id} scheduled for retry`,
          data: {
            taskId: task.id,
            attemptId: previousAttemptId,
            exitCode: result.exitCode ?? null,
            failureKind,
            retryDelayMs: delayMs,
          },
        });
      }
      if (task.sessionId) {
        const session = this.getSession(task.sessionId);
        session.updatedAt = now;
        session.events.push({
          at: now,
          type: 'task_retry_scheduled',
          message: `Task ${task.id} scheduled for retry on the session Worker`,
          taskId: task.id,
          workerId: session.assignedWorkerId || previousWorkerId,
        });
      }
      await this.refreshBatchDependencyStates(task.batchId, now);
      await this.save();
      this.notifyClaimWaiters();
      return task;
    }
    const artifacts = await this.saveArtifacts(task.id, result.artifacts || []);
    task.status = completionStatus;
    task.exitCode = result.exitCode ?? null;
    task.failureKind = failureKind;
    task.stdout = result.stdout || '';
    task.stderr = result.stderr || '';
    task.error = result.error || null;
    task.workspace = result.workspace || task.workspace;
    task.workspaceCleaned = Boolean(result.workspaceCleaned);
    task.artifacts = artifacts;
    task.completedAt = now;
    task.updatedAt = now;
    const attempt = (task.attempts || []).find((item) => item.id === task.currentAttemptId);
    if (attempt) {
      attempt.completedAt = now;
      attempt.status = task.status;
      attempt.exitCode = task.exitCode;
      attempt.failureKind = failureKind;
    }
    task.events.push({
      at: now,
      type: task.status,
      message: result.error || `Task ${task.status}`,
      workerId: task.assignedWorkerId,
      data: {
        attemptId: task.currentAttemptId || null,
      },
    });
    if (retryExhausted) {
      task.events.push({
        at: now,
        type: 'retry_exhausted',
        message: `Retry policy matched, but maximum attempts were exhausted (${task.attemptSeq}/${task.maxAttempts})`,
        workerId: task.assignedWorkerId,
        data: {
          attemptId: task.currentAttemptId || null,
          attemptSeq: task.attemptSeq,
          maxAttempts: task.maxAttempts,
          exitCode: task.exitCode,
          failureKind,
          matchedFailureKind: retryMatch.matchedFailureKind,
          matchedExitCode: retryMatch.matchedExitCode,
        },
      });
    }
    const worker = task.assignedWorkerId ? this.state.workers[task.assignedWorkerId] : null;
    if (worker) {
      worker.currentTaskIds = normalizeTaskIds(worker.currentTaskIds, worker.currentTaskId)
        .filter((id) => id !== task.id);
      worker.currentTaskId = worker.currentTaskIds[0] || null;
      worker.observedState = worker.currentTaskIds.length ? 'running' : worker.adminState === 'enabled' ? 'idle' : worker.adminState;
      worker.lastSeenAt = now;
      this.appendWorkerEvent(worker, {
        at: now,
        type: 'task_completed',
        level: task.status === 'succeeded' ? 'info' : 'error',
        message: `Task ${task.id} ${task.status}`,
        data: {
          taskId: task.id,
          status: task.status,
          exitCode: task.exitCode,
          attemptId: result.attemptId || null,
        },
      });
    }
    if (task.sessionId) {
      const session = this.getSession(task.sessionId);
      if (session.currentTaskId === task.id) {
        session.currentTaskId = null;
      }
      session.workspace = task.workspace || session.workspace;
      session.updatedAt = now;
      session.events.push({
        at: now,
        type: `task_${task.status}`,
        message: `Task ${task.id} ${task.status}`,
        taskId: task.id,
      });
    }
    if (task.batchId && this.state.batches[task.batchId]) {
      const batch = this.state.batches[task.batchId];
      batch.updatedAt = now;
      batch.events.push({
        at: now,
        type: `task_${task.status}`,
        message: `Task ${task.id} ${task.status}`,
        taskId: task.id,
      });
      await this.refreshBatchDependencyStates(task.batchId, now);
    }
    task.currentAttemptId = null;
    task.lease = null;
    task.notBeforeAt = null;
    await this.save();
    this.notifyClaimWaiters();
    return task;
  }

  async manageTask(taskId, action, options = {}) {
    const task = this.getTask(taskId);
    const now = nowIso();
    const allowed = new Set(['cancel', 'requeue', 'reschedule']);
    if (!allowed.has(action)) {
      throw new Error(`Unsupported task action: ${action}`);
    }

    if (action === 'cancel') {
      if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
        throw new Error(`Task is already terminal: ${task.status}`);
      }
      await this.cancelTask(task, now, options.reason || 'Cancelled by gateway task management');
      await this.save();
      this.notifyClaimWaiters();
      return task;
    }

    if (action === 'requeue') {
      if (task.status === 'uploading_inputs') {
        throw new Error('Task is waiting for input uploads; resume or cancel the uploads instead of requeueing');
      }
      if (task.status === 'queued') {
        throw new Error('Task is already queued');
      }
      let activeWorker = false;
      if (task.status === 'running' && task.assignedWorkerId) {
        const worker = this.state.workers[task.assignedWorkerId];
        const lastSeen = worker?.lastSeenAt ? Date.parse(worker.lastSeenAt) : 0;
        activeWorker = Boolean(lastSeen && Date.now() - lastSeen <= ACTIVE_WINDOW_MS);
        if (activeWorker) {
          throw new Error('Cannot requeue an actively running task; cancel it first or wait for the worker to go offline');
        }
      }
      this.resetTaskForRetry(task, {
        now,
        workerId: options.workerId,
        requiredCapabilities: options.requiredCapabilities,
        requiredTools: options.requiredTools,
        slots: options.slots,
        requiredLabels: options.requiredLabels,
        requiredResources: options.requiredResources,
        reason: options.reason || 'Task requeued by gateway task management',
        touchWorker: activeWorker,
      });
        await this.refreshBatchDependencyStates(task.batchId, now);
      await this.save();
      this.notifyClaimWaiters();
      return task;
    }

    if (action === 'reschedule') {
      if (task.status !== 'queued') {
        throw new Error(`Can only reschedule queued tasks; current status is ${task.status}`);
      }
      if (options.requiredCapabilities !== undefined) {
        task.requiredCapabilities = Array.from(new Set(options.requiredCapabilities || []));
      }
      if (options.requiredTools !== undefined) {
        task.requiredTools = normalizeToolList(options.requiredTools);
      }
      if (options.slots !== undefined) {
        task.slots = normalizeTaskSlots(options.slots);
      }
      if (options.requiredLabels !== undefined) {
        task.requiredLabels = normalizeLabels(options.requiredLabels);
      }
      if (options.requiredResources !== undefined) {
        task.requiredResources = normalizeResourceRequirements(options.requiredResources);
      }
      const session = task.sessionId ? this.getSession(task.sessionId) : null;
      if (session?.assignedWorkerId && options.workerId && options.workerId !== session.assignedWorkerId) {
        throw new Error(`Session is already assigned to ${session.assignedWorkerId}`);
      }
      if (options.workerId !== undefined) {
        task.requestedWorkerId = options.workerId || null;
        task.scheduler = task.requestedWorkerId
          ? scheduleTask({
            task,
            workers: this.listWorkers(),
            tasks: this.listTasks(),
            session,
          })
          : {
            workerId: null,
            reason: 'explicit worker cleared',
            candidates: [],
          };
        if (session && !session.assignedWorkerId) {
          session.requestedWorkerId = task.requestedWorkerId;
          session.updatedAt = now;
        }
        task.updatedAt = now;
        task.events.push({
          at: now,
          type: 'rescheduled',
          message: options.reason || task.scheduler.reason,
          data: task.scheduler,
        });
      } else {
        task.requestedWorkerId = session?.assignedWorkerId || null;
        if (session && !session.assignedWorkerId) {
          session.requestedWorkerId = null;
        }
        this.scheduleQueuedTask(task, now, 'rescheduled');
      }
      await this.save();
      this.notifyClaimWaiters();
      return task;
    }

    throw new Error(`Unsupported task action: ${action}`);
  }

  async cancelTask(task, now = nowIso(), reason = 'Cancelled by gateway task management') {
    const workerId = task.assignedWorkerId;
    task.status = 'cancelled';
    task.completedAt = now;
    task.updatedAt = now;
    task.error = reason;
    task.events.push({
      at: now,
      type: 'cancelled',
      message: reason,
      workerId,
    });
    if (workerId) {
      const worker = this.state.workers[workerId];
      if (worker?.currentTaskId === task.id || worker?.currentTaskIds?.includes(task.id)) {
        const command = {
          id: newId('cmd'),
          workerId: worker.id,
          action: 'cancel_current',
          taskId: task.id,
          reason,
          status: 'queued',
          createdAt: now,
          acknowledgedAt: null,
          completedAt: null,
        };
        worker.commands ??= [];
        worker.commands.push(command);
        this.state.commandOrder.push(command.id);
      }
    }
    this.clearTaskRuntime(task, now);
    this.closeCurrentAttempt(task, now, 'cancelled', reason);
    task.currentAttemptId = null;
    task.lease = null;
    task.notBeforeAt = null;
    if (task.batchId && this.state.batches[task.batchId]) {
      const batch = this.state.batches[task.batchId];
      batch.updatedAt = now;
      batch.events.push({
        at: now,
        type: 'task_cancelled',
        message: `Task ${task.id} cancelled`,
        taskId: task.id,
      });
      await this.refreshBatchDependencyStates(task.batchId, now);
    }
    return task;
  }

  resetTaskForRetry(task, options = {}) {
    const now = options.now || nowIso();
    this.closeCurrentAttempt(task, now, options.attemptStatus || 'superseded', options.reason || 'Task requeued');
    this.clearTaskRuntime(task, now, { touchWorker: options.touchWorker });
    task.assignedWorkerId = null;
    task.startedAt = null;
    task.completedAt = null;
    task.exitCode = null;
    task.failureKind = null;
    task.stdout = '';
    task.stderr = '';
    task.error = null;
    task.workspace = null;
    task.workspaceCleaned = false;
    task.artifacts = [];
    task.currentAttemptId = null;
    task.lease = null;
    task.notBeforeAt = options.notBeforeAt || null;
    if (options.workerId !== undefined) {
      task.requestedWorkerId = options.workerId || null;
    } else {
      task.requestedWorkerId = null;
    }
    if (options.requiredCapabilities !== undefined) {
      task.requiredCapabilities = Array.from(new Set(options.requiredCapabilities || []));
    }
    if (options.requiredTools !== undefined) {
      task.requiredTools = normalizeToolList(options.requiredTools);
    }
    if (options.slots !== undefined) {
      task.slots = normalizeTaskSlots(options.slots);
    }
    if (options.requiredLabels !== undefined) {
      task.requiredLabels = normalizeLabels(options.requiredLabels);
    }
    if (options.requiredResources !== undefined) {
      task.requiredResources = normalizeResourceRequirements(options.requiredResources);
    }
    task.updatedAt = now;
    task.events.push({
      at: now,
      type: 'requeued',
      message: options.reason || 'Task requeued',
    });
    const dependencyState = this.dependencyStateForTask(task);
    if (!dependencyState.ready) {
      this.makeTaskBlockedByDependencies(task, now, this.dependencyBlockedReason(task, dependencyState));
    } else if (!task.requestedWorkerId) {
      task.status = 'queued';
      task.blockedReason = null;
      this.scheduleQueuedTask(task, now, 'rescheduled');
    } else {
      task.status = 'queued';
      task.blockedReason = null;
      task.scheduler = scheduleTask({
        task,
        workers: this.listWorkers(),
        tasks: this.listTasks(),
        session: task.sessionId ? this.getSession(task.sessionId) : null,
      });
    }
    return task;
  }

  listOfflineRunningTasks(options = {}) {
    const minOfflineMs = Math.max(ACTIVE_WINDOW_MS + 1, Number(options.minOfflineMs || 0));
    return this.listTasks()
      .filter((task) => {
        if (task.status !== 'running' || !task.assignedWorkerId) {
          return false;
        }
        if (options.workerId && task.assignedWorkerId !== options.workerId) {
          return false;
        }
        const worker = this.state.workers[task.assignedWorkerId];
        const lastSeen = worker?.lastSeenAt ? Date.parse(worker.lastSeenAt) : 0;
        return !lastSeen || Date.now() - lastSeen >= minOfflineMs;
      })
      .map((task) => {
        const worker = this.state.workers[task.assignedWorkerId] || null;
        const lastSeen = worker?.lastSeenAt ? Date.parse(worker.lastSeenAt) : 0;
        return {
          task,
          worker: worker ? this.decorateWorker(worker) : null,
          offlineMs: lastSeen ? Date.now() - lastSeen : null,
          recoveryReason: 'worker_offline',
        };
      });
  }

  listExpiredLeaseTasks(options = {}) {
    const atMs = Number(options.atMs || Date.now());
    return this.listTasks()
      .filter((task) => task.status === 'running'
        && task.assignedWorkerId
        && (!options.workerId || task.assignedWorkerId === options.workerId)
        && leaseExpired(task, atMs))
      .map((task) => {
        const worker = this.state.workers[task.assignedWorkerId] || null;
        const expiresAt = Date.parse(task.lease.expiresAt);
        return {
          task,
          worker: worker ? this.decorateWorker(worker) : null,
          offlineMs: worker?.lastSeenAt ? atMs - Date.parse(worker.lastSeenAt) : null,
          leaseExpiredMs: Math.max(0, atMs - expiresAt),
          recoveryReason: 'lease_expired',
        };
      });
  }

  listRecoverableRunningTasks(options = {}) {
    const candidates = this.listOfflineRunningTasks(options);
    const byTaskId = new Map(candidates.map((item) => [item.task.id, item]));
    for (const item of this.listExpiredLeaseTasks(options)) {
      const existing = byTaskId.get(item.task.id);
      byTaskId.set(item.task.id, existing
        ? { ...existing, leaseExpiredMs: item.leaseExpiredMs, recoveryReason: 'lease_expired_and_worker_offline' }
        : item);
    }
    return [...byTaskId.values()];
  }

  async recoverOfflineTasks(options = {}) {
    const action = options.action || 'list';
    const allowed = new Set(['list', 'requeue']);
    if (!allowed.has(action)) {
      throw new Error(`Unsupported recovery action: ${action}`);
    }
    const candidateOptions = {
      workerId: options.workerId,
      minOfflineMs: options.minOfflineMs,
    };
    const candidates = options.includeExpiredLeases === false
      ? this.listOfflineRunningTasks(candidateOptions)
      : this.listRecoverableRunningTasks(candidateOptions);
    if (action === 'list') {
      return { action, candidates, recovered: [], exhausted: [], skipped: [] };
    }

    const now = nowIso();
    const recovered = [];
    const exhausted = [];
    const skipped = [];
    for (const item of candidates) {
      const task = this.getTask(item.task.id);
      const session = task.sessionId ? this.getSession(task.sessionId) : null;
      const sameWorkerSessionRecovery = Boolean(
        session && options.sessionRecovery === 'same-worker',
      );
      if (session && !options.includeSessions && !sameWorkerSessionRecovery) {
        skipped.push({
          task,
          reason: 'session task recovery requires --include-sessions because its worker-local session workspace may be unavailable',
        });
        continue;
      }

      const previousWorkerId = task.assignedWorkerId;
      const previousAttemptId = task.currentAttemptId;
      const recoveryTargetWorkerId = sameWorkerSessionRecovery
        ? (session.assignedWorkerId || previousWorkerId)
        : (options.targetWorkerId || null);
      if (
        sameWorkerSessionRecovery
        && (
          session.status !== 'open'
          || !recoveryTargetWorkerId
          || (previousWorkerId && recoveryTargetWorkerId !== previousWorkerId)
        )
      ) {
        skipped.push({
          task,
          reason: session.status !== 'open'
            ? `session ${session.id} is ${session.status}; automatic recovery requires an open session`
            : 'session Worker affinity does not match the lost task owner',
        });
        continue;
      }
      const attemptStatus = item.recoveryReason?.startsWith('lease_expired') ? 'lease_expired' : 'worker_lost';
      if (Number(task.attemptSeq || 0) >= normalizeMaxAttempts(task.maxAttempts)) {
        this.closeCurrentAttempt(task, now, attemptStatus, 'Execution ownership expired before completion');
        this.clearTaskRuntime(task, now, { touchWorker: false });
        task.status = 'failed';
        task.completedAt = now;
        task.updatedAt = now;
        task.error = `Maximum attempts exhausted (${task.attemptSeq}/${task.maxAttempts}) after ${item.recoveryReason}`;
        task.currentAttemptId = null;
        task.lease = null;
        task.notBeforeAt = null;
        task.events.push({
          at: now,
          type: 'retry_exhausted',
          message: task.error,
          workerId: previousWorkerId,
          data: {
            attemptSeq: task.attemptSeq,
            maxAttempts: task.maxAttempts,
            recoveryReason: item.recoveryReason,
          },
        });
        await this.refreshBatchDependencyStates(task.batchId, now);
        exhausted.push(task);
        continue;
      }

      this.closeCurrentAttempt(task, now, attemptStatus, options.reason || 'Execution ownership expired');
      this.clearTaskRuntime(task, now, { touchWorker: false });
      task.status = 'queued';
      task.assignedWorkerId = null;
      task.startedAt = null;
      task.completedAt = null;
      task.exitCode = null;
      task.failureKind = null;
      task.stdout = '';
      task.stderr = '';
      task.error = null;
      task.workspace = null;
      task.workspaceCleaned = false;
      task.artifacts = [];
      task.currentAttemptId = null;
      task.lease = null;
      const delayMs = retryDelayMs(task);
      task.notBeforeAt = delayMs ? new Date(Date.parse(now) + delayMs).toISOString() : null;
      if (options.requiredCapabilities !== undefined) {
        task.requiredCapabilities = Array.from(new Set(options.requiredCapabilities || []));
      }
      if (options.requiredTools !== undefined) {
        task.requiredTools = normalizeToolList(options.requiredTools);
      }
      if (options.slots !== undefined) {
        task.slots = normalizeTaskSlots(options.slots);
      }
      if (options.requiredLabels !== undefined) {
        task.requiredLabels = normalizeLabels(options.requiredLabels);
      }
      if (options.requiredResources !== undefined) {
        task.requiredResources = normalizeResourceRequirements(options.requiredResources);
      }
      task.requestedWorkerId = recoveryTargetWorkerId;
      if (session) {
        session.assignedWorkerId = recoveryTargetWorkerId;
        session.requestedWorkerId = recoveryTargetWorkerId;
        if (!sameWorkerSessionRecovery) {
          session.workspace = null;
        }
        session.updatedAt = now;
        session.events.push({
          at: now,
          type: item.recoveryReason?.startsWith('lease_expired') ? 'lease_recovered' : 'offline_recovered',
          message: `Recovered task ${task.id} after ${item.recoveryReason}`,
          taskId: task.id,
          workerId: recoveryTargetWorkerId,
          attemptId: previousAttemptId,
          data: {
            recoveryMode: sameWorkerSessionRecovery ? 'same-worker' : 'operator-directed',
            workspacePreserved: sameWorkerSessionRecovery,
          },
        });
      }
      task.updatedAt = now;
      task.events.push({
        at: now,
        type: item.recoveryReason?.startsWith('lease_expired') ? 'lease_recovered' : 'offline_recovered',
        message: options.reason || `Recovered after ${item.recoveryReason} on ${item.worker?.id || previousWorkerId || 'unknown'}`,
        workerId: recoveryTargetWorkerId || previousWorkerId,
        attemptId: previousAttemptId,
        data: {
          previousWorkerId: item.worker?.id || previousWorkerId,
          previousAttemptId,
          targetWorkerId: recoveryTargetWorkerId,
          recoveryReason: item.recoveryReason,
          sessionRecoveryMode: sameWorkerSessionRecovery ? 'same-worker' : null,
          sessionWorkspacePreserved: sameWorkerSessionRecovery,
          retryDelayMs: delayMs,
          notBeforeAt: task.notBeforeAt,
          attemptSeq: task.attemptSeq,
          maxAttempts: task.maxAttempts,
        },
      });
      const dependencyState = this.dependencyStateForTask(task);
      if (!dependencyState.ready) {
        this.makeTaskBlockedByDependencies(task, now, this.dependencyBlockedReason(task, dependencyState));
      } else if (!task.requestedWorkerId) {
        this.scheduleQueuedTask(task, now, 'rescheduled');
      } else {
        task.scheduler = {
          workerId: task.requestedWorkerId,
          reason: sameWorkerSessionRecovery
            ? 'recovered to the session-affine worker'
            : 'recovered to explicit worker',
          candidates: [],
        };
      }
      await this.refreshBatchDependencyStates(task.batchId, now);
      recovered.push(task);
    }

    await this.save();
    this.notifyClaimWaiters();
    return { action, candidates, recovered, exhausted, skipped };
  }

  closeCurrentAttempt(task, now = nowIso(), status = 'superseded', error = '') {
    const attempt = (task.attempts || []).find((item) => item.id === task.currentAttemptId);
    if (!attempt || attempt.status !== 'running') {
      return;
    }
    attempt.completedAt = now;
    attempt.status = status;
    attempt.error = error || null;
  }

  clearTaskRuntime(task, now = nowIso(), options = {}) {
    const touchWorker = options.touchWorker !== false;
    const worker = task.assignedWorkerId ? this.state.workers[task.assignedWorkerId] : null;
    if (worker) {
      worker.currentTaskIds = normalizeTaskIds(worker.currentTaskIds, worker.currentTaskId)
        .filter((id) => id !== task.id);
      worker.currentTaskId = worker.currentTaskIds[0] || null;
      worker.observedState = worker.currentTaskIds.length ? 'running' : worker.adminState === 'enabled' ? 'idle' : worker.adminState;
      if (touchWorker) {
        worker.lastSeenAt = now;
      }
    }
    if (task.sessionId) {
      const session = this.state.sessions[task.sessionId];
      if (session?.currentTaskId === task.id) {
        session.currentTaskId = null;
        session.updatedAt = now;
        session.events.push({
          at: now,
          type: 'task_cleared',
          message: `Task ${task.id} cleared from session runtime`,
          taskId: task.id,
        });
      }
    }
  }

  getTaskInputUpload(taskId, uploadId) {
    const upload = this.state.inputUploads[uploadId];
    if (!upload || upload.taskId !== taskId) {
      const error = new Error(`Unknown task input upload: ${uploadId}`);
      error.status = 404;
      throw error;
    }
    return publicInputUpload(upload);
  }

  async withInputUploadLock(uploadId, operation) {
    const previous = this.inputUploadQueues.get(uploadId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.inputUploadQueues.set(uploadId, current);
    try {
      return await current;
    } finally {
      if (this.inputUploadQueues.get(uploadId) === current) {
        this.inputUploadQueues.delete(uploadId);
      }
    }
  }

  async appendTaskInputUpload(taskId, uploadId, input = {}) {
    return this.withInputUploadLock(uploadId, async () => {
      const task = this.getTask(taskId);
      const upload = this.state.inputUploads[uploadId];
      if (!upload || upload.taskId !== taskId) {
        const error = new Error(`Unknown task input upload: ${uploadId}`);
        error.status = 404;
        throw error;
      }
      if (task.status !== 'uploading_inputs' || upload.status !== 'pending') {
        const error = new Error(`Task input upload is not writable: task=${task.status} upload=${upload.status}`);
        error.status = 409;
        error.expectedOffset = upload.committedBytes;
        throw error;
      }
      const offset = Number(input.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset !== upload.committedBytes) {
        const error = new Error(`Task input upload offset conflict: expected ${upload.committedBytes}, received ${input.offset}`);
        error.status = 409;
        error.expectedOffset = upload.committedBytes;
        throw error;
      }
      const expectedSha256 = String(input.chunkSha256 || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
        const error = new Error('Task input chunk requires a SHA-256 digest');
        error.status = 400;
        throw error;
      }
      const maxChunkBytes = Math.max(1, Number(input.maxChunkBytes || DEFAULT_MAX_ARTIFACT_CHUNK_BYTES));
      const handle = await fs.open(upload.tempPath, 'r+');
      const hash = crypto.createHash('sha256');
      let written = 0;
      try {
        for await (const value of input.stream) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          if (written + chunk.length > maxChunkBytes || offset + written + chunk.length > upload.size) {
            const error = new Error(`Task input chunk exceeds allowed size (${maxChunkBytes} bytes) or declared input size`);
            error.status = 413;
            throw error;
          }
          hash.update(chunk);
          let cursor = 0;
          while (cursor < chunk.length) {
            const result = await handle.write(chunk, cursor, chunk.length - cursor, offset + written + cursor);
            cursor += result.bytesWritten;
          }
          written += chunk.length;
        }
        if (hash.digest('hex') !== expectedSha256) {
          const error = new Error('Task input chunk SHA-256 mismatch');
          error.status = 422;
          throw error;
        }
        if (!written && upload.size > upload.committedBytes) {
          const error = new Error('Task input chunk cannot be empty before upload completion');
          error.status = 400;
          throw error;
        }
      } catch (error) {
        await handle.truncate(upload.committedBytes);
        throw error;
      } finally {
        await handle.close();
      }
      upload.committedBytes += written;
      upload.updatedAt = nowIso();
      await this.save();
      return publicInputUpload(upload);
    });
  }

  async activateTaskAfterInputUploads(task, now = nowIso()) {
    const uploads = (task.inputFiles || [])
      .filter((file) => file.inputUploadId)
      .map((file) => this.state.inputUploads[file.inputUploadId]);
    if (!uploads.length || uploads.some((upload) => !upload || upload.status !== 'finalized')) {
      return false;
    }
    for (const file of task.inputFiles) {
      if (file.inputUploadId) {
        file.ready = true;
      }
    }
    task.inputReadyStatus = null;
    const dependencyState = this.dependencyStateForTask(task);
    if (task.dependsOnTaskIds?.length && !dependencyState.ready) {
      this.makeTaskBlockedByDependencies(task, now, this.dependencyBlockedReason(task, dependencyState));
    } else {
      task.status = 'queued';
      task.blockedReason = null;
      task.updatedAt = now;
      task.events.push({
        at: now,
        type: 'inputs_ready',
        message: 'All control-side input uploads finalized; task queued',
      });
      if (!task.requestedWorkerId) {
        this.scheduleQueuedTask(task, now, 'scheduled');
      } else {
        task.scheduler = scheduleTask({
          task,
          workers: this.listWorkers(),
          tasks: this.listTasks(),
          session: task.sessionId ? this.getSession(task.sessionId) : null,
        });
      }
    }
    if (task.batchId && this.state.batches[task.batchId]) {
      const batch = this.state.batches[task.batchId];
      batch.updatedAt = now;
      batch.events.push({
        at: now,
        type: task.status === 'queued' ? 'task_inputs_ready' : 'task_blocked',
        message: task.status === 'queued' ? `Task inputs ready: ${task.id}` : task.blockedReason,
        taskId: task.id,
      });
    }
    return true;
  }

  async finalizeTaskInputUpload(taskId, uploadId) {
    return this.withInputUploadLock(uploadId, async () => {
      const task = this.getTask(taskId);
      const upload = this.state.inputUploads[uploadId];
      if (!upload || upload.taskId !== taskId) {
        const error = new Error(`Unknown task input upload: ${uploadId}`);
        error.status = 404;
        throw error;
      }
      if (upload.status === 'finalized') {
        return { upload: publicInputUpload(upload), task };
      }
      if (task.status !== 'uploading_inputs') {
        const error = new Error(`Task is not accepting input uploads: ${task.status}`);
        error.status = 409;
        throw error;
      }
      if (upload.committedBytes !== upload.size) {
        const error = new Error(`Task input upload is incomplete: ${upload.committedBytes}/${upload.size}`);
        error.status = 409;
        error.expectedOffset = upload.committedBytes;
        throw error;
      }
      const hash = crypto.createHash('sha256');
      for await (const chunk of createReadStream(upload.tempPath)) {
        hash.update(chunk);
      }
      const actualSha256 = hash.digest('hex');
      if (upload.sha256 && actualSha256 !== upload.sha256) {
        await fs.truncate(upload.tempPath, 0);
        upload.committedBytes = 0;
        upload.updatedAt = nowIso();
        upload.lastError = 'sha256_mismatch';
        await this.save();
        const error = new Error('Task input SHA-256 mismatch; upload was reset for retry');
        error.status = 422;
        error.expectedOffset = 0;
        throw error;
      }
      if (!upload.sha256) {
        upload.sha256 = actualSha256;
        const descriptor = task.inputFiles.find((file) => file.inputUploadId === upload.id);
        if (descriptor) {
          descriptor.sha256 = actualSha256;
        }
      }
      const storagePath = path.join(path.dirname(upload.tempPath), `${safeName(upload.id)}.bin`);
      await fs.rename(upload.tempPath, storagePath);
      upload.tempPath = null;
      upload.storagePath = storagePath;
      upload.status = 'finalized';
      upload.updatedAt = nowIso();
      upload.finalizedAt = upload.updatedAt;
      upload.lastError = null;
      await this.activateTaskAfterInputUploads(task, upload.updatedAt);
      await this.save();
      this.notifyClaimWaiters();
      return { upload: publicInputUpload(upload), task };
    });
  }

  getTaskInputDownload(taskId, inputId, input = {}) {
    const task = this.assertLiveArtifactUploadTask(taskId, input.attemptId, input.workerId);
    const files = [...(task.inputFiles || []), ...(task.dependencyInputFiles || [])];
    const descriptor = files.find((file) => file.inputUploadId === inputId || file.sourceArtifactId === inputId);
    if (!descriptor) {
      const error = new Error(`Task input is not attached to task ${taskId}: ${inputId}`);
      error.status = 404;
      throw error;
    }
    if (descriptor.inputUploadId) {
      const upload = this.state.inputUploads[descriptor.inputUploadId];
      if (!upload || upload.status !== 'finalized' || !upload.storagePath) {
        const error = new Error(`Task input upload is not finalized: ${inputId}`);
        error.status = 409;
        throw error;
      }
      return {
        input: { ...descriptor, size: upload.size, sha256: upload.sha256 },
        storagePath: upload.storagePath,
      };
    }
    const sourceTask = this.state.tasks[descriptor.sourceTaskId];
    const artifact = sourceTask?.artifacts?.find((item) => item.id === descriptor.sourceArtifactId);
    if (!artifact || artifact.skipped || !artifact.storagePath) {
      const error = new Error(`Dependency input artifact is unavailable: ${inputId}`);
      error.status = 404;
      throw error;
    }
    return {
      input: { ...descriptor, size: artifact.size, sha256: artifact.sha256 },
      storagePath: artifact.storagePath,
    };
  }

  async saveArtifacts(taskId, artifacts) {
    const saved = [];
    const task = this.getTask(taskId);
    const dir = path.join(this.artifactDir, safeName(taskId));
    await ensureDir(dir);

    for (const artifact of artifacts) {
      const upload = artifact.uploadId ? this.state.artifactUploads[artifact.uploadId] : null;
      if (artifact.uploadId && (
        !upload
        || upload.taskId !== taskId
        || upload.status !== 'finalized'
        || upload.attemptId !== task.currentAttemptId
        || upload.workerId !== task.assignedWorkerId
      )) {
        const error = new Error(`Artifact upload is not finalized for task ${taskId}: ${artifact.uploadId}`);
        error.status = 409;
        throw error;
      }
      const record = {
        id: newId('artifact'),
        taskId,
        path: upload?.path || artifact.path,
        size: upload?.size ?? artifact.size ?? 0,
        sha256: upload?.sha256 || artifact.sha256 || null,
        skipped: Boolean(artifact.skipped),
        reason: artifact.reason || null,
        storedAt: nowIso(),
      };
      if (upload) {
        record.storagePath = upload.storagePath;
        record.uploadId = upload.id;
        upload.attachedArtifactId = record.id;
        upload.attachedAt = record.storedAt;
      } else if (!record.skipped && artifact.contentBase64) {
        const bytes = Buffer.from(artifact.contentBase64, 'base64');
        record.size = bytes.length;
        record.sha256 = record.sha256 || crypto.createHash('sha256').update(bytes).digest('hex');
        const fileName = `${record.id}.bin`;
        await fs.writeFile(path.join(dir, fileName), bytes);
        record.storagePath = path.join(dir, fileName);
      }
      saved.push(record);
    }
    return saved;
  }

  assertLiveArtifactUploadTask(taskId, attemptId, workerId) {
    const task = this.getTask(taskId);
    if (task.status !== 'running') {
      const error = new Error(`Task is not running: ${taskId}`);
      error.status = 409;
      throw error;
    }
    if (leaseExpired(task)) {
      const error = new Error(`Task lease expired: ${taskId}`);
      error.status = 409;
      throw error;
    }
    if (!attemptId || task.currentAttemptId !== attemptId) {
      const error = new Error(`Artifact upload attempt is stale for task ${taskId}`);
      error.status = 409;
      throw error;
    }
    if (!workerId || task.assignedWorkerId !== workerId) {
      const error = new Error(`Artifact upload worker does not own task ${taskId}`);
      error.status = 403;
      throw error;
    }
    return task;
  }

  async createArtifactUpload(taskId, input = {}) {
    const task = this.assertLiveArtifactUploadTask(taskId, input.attemptId, input.workerId);
    const artifactPath = String(input.path || '').replaceAll('\\', '/').replace(/^\/+/, '');
    const size = Number(input.size);
    const sha256 = String(input.sha256 || '').toLowerCase();
    if (!artifactPath || artifactPath.includes('\0')) {
      const error = new Error('Artifact upload requires a valid relative path');
      error.status = 400;
      throw error;
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      const error = new Error('Artifact upload requires a non-negative integer size');
      error.status = 400;
      throw error;
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      const error = new Error('Artifact upload requires a SHA-256 digest');
      error.status = 400;
      throw error;
    }
    const existing = Object.values(this.state.artifactUploads).find((upload) => (
      upload.taskId === taskId
      && upload.attemptId === input.attemptId
      && upload.workerId === input.workerId
      && upload.path === artifactPath
      && upload.size === size
      && upload.sha256 === sha256
      && ['pending', 'finalized'].includes(upload.status)
    ));
    if (existing) {
      return publicArtifactUpload(existing);
    }

    const id = newId('upload');
    const dir = path.join(this.artifactDir, safeName(taskId), '.uploads');
    await ensureDir(dir);
    const tempPath = path.join(dir, `${safeName(id)}.part`);
    await fs.writeFile(tempPath, Buffer.alloc(0));
    const now = nowIso();
    const upload = {
      id,
      taskId,
      workerId: task.assignedWorkerId,
      attemptId: task.currentAttemptId,
      path: artifactPath,
      size,
      sha256,
      status: 'pending',
      committedBytes: 0,
      tempPath,
      storagePath: null,
      createdAt: now,
      updatedAt: now,
      finalizedAt: null,
      attachedArtifactId: null,
    };
    this.state.artifactUploads[id] = upload;
    this.state.artifactUploadOrder.push(id);
    await this.save();
    return publicArtifactUpload(upload);
  }

  getArtifactUpload(taskId, uploadId, input = {}) {
    const upload = this.state.artifactUploads[uploadId];
    if (!upload || upload.taskId !== taskId) {
      const error = new Error(`Unknown artifact upload: ${uploadId}`);
      error.status = 404;
      throw error;
    }
    this.assertLiveArtifactUploadTask(taskId, input.attemptId || upload.attemptId, input.workerId);
    if (input.attemptId && upload.attemptId !== input.attemptId) {
      const error = new Error(`Artifact upload attempt is stale: ${uploadId}`);
      error.status = 409;
      throw error;
    }
    return publicArtifactUpload(upload);
  }

  listArtifactUploads(taskId) {
    this.getTask(taskId);
    return this.state.artifactUploadOrder
      .map((uploadId) => this.state.artifactUploads[uploadId])
      .filter((upload) => upload?.taskId === taskId)
      .map((upload) => publicArtifactUpload(upload));
  }

  async withArtifactUploadLock(uploadId, operation) {
    const previous = this.artifactUploadQueues.get(uploadId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.artifactUploadQueues.set(uploadId, current);
    try {
      return await current;
    } finally {
      if (this.artifactUploadQueues.get(uploadId) === current) {
        this.artifactUploadQueues.delete(uploadId);
      }
    }
  }

  async appendArtifactUpload(taskId, uploadId, input = {}) {
    return this.withArtifactUploadLock(uploadId, async () => {
      const upload = this.state.artifactUploads[uploadId];
      if (!upload || upload.taskId !== taskId) {
        const error = new Error(`Unknown artifact upload: ${uploadId}`);
        error.status = 404;
        throw error;
      }
      this.assertLiveArtifactUploadTask(taskId, input.attemptId, input.workerId);
      if (upload.attemptId !== input.attemptId || upload.workerId !== input.workerId) {
        const error = new Error(`Artifact upload ownership is stale: ${uploadId}`);
        error.status = 409;
        throw error;
      }
      if (upload.status !== 'pending') {
        const error = new Error(`Artifact upload is already ${upload.status}: ${uploadId}`);
        error.status = 409;
        error.expectedOffset = upload.committedBytes;
        throw error;
      }
      const offset = Number(input.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset !== upload.committedBytes) {
        const error = new Error(`Artifact upload offset conflict: expected ${upload.committedBytes}, received ${input.offset}`);
        error.status = 409;
        error.expectedOffset = upload.committedBytes;
        throw error;
      }
      const expectedSha256 = String(input.chunkSha256 || '').toLowerCase();
      const expectedBodySha256 = input.bodySha256 ? String(input.bodySha256).toLowerCase() : null;
      if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
        const error = new Error('Artifact chunk requires a SHA-256 digest');
        error.status = 400;
        throw error;
      }
      if (expectedBodySha256 && !/^[a-f0-9]{64}$/.test(expectedBodySha256)) {
        const error = new Error('Signed artifact chunk body digest is invalid');
        error.status = 401;
        throw error;
      }
      const maxChunkBytes = Math.max(1, Number(input.maxChunkBytes || DEFAULT_MAX_ARTIFACT_CHUNK_BYTES));
      const handle = await fs.open(upload.tempPath, 'r+');
      const hash = crypto.createHash('sha256');
      let written = 0;
      try {
        for await (const value of input.stream) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          if (written + chunk.length > maxChunkBytes || offset + written + chunk.length > upload.size) {
            const error = new Error(`Artifact chunk exceeds allowed size (${maxChunkBytes} bytes) or declared artifact size`);
            error.status = 413;
            throw error;
          }
          hash.update(chunk);
          let cursor = 0;
          while (cursor < chunk.length) {
            const result = await handle.write(chunk, cursor, chunk.length - cursor, offset + written + cursor);
            cursor += result.bytesWritten;
          }
          written += chunk.length;
        }
        const actualSha256 = hash.digest('hex');
        if (actualSha256 !== expectedSha256) {
          const error = new Error('Artifact chunk SHA-256 mismatch');
          error.status = 422;
          throw error;
        }
        if (expectedBodySha256 && actualSha256 !== expectedBodySha256) {
          const error = new Error('Signed artifact chunk body SHA-256 mismatch');
          error.status = 401;
          throw error;
        }
        if (!written && upload.size > upload.committedBytes) {
          const error = new Error('Artifact chunk cannot be empty before upload completion');
          error.status = 400;
          throw error;
        }
        this.assertLiveArtifactUploadTask(taskId, input.attemptId, input.workerId);
      } catch (error) {
        await handle.truncate(upload.committedBytes);
        throw error;
      } finally {
        await handle.close();
      }
      const previousCommittedBytes = upload.committedBytes;
      upload.committedBytes += written;
      upload.updatedAt = nowIso();
      const task = this.state.tasks[taskId];
      task?.events?.push({
        at: upload.updatedAt,
        type: 'artifact_upload_progress',
        message: `Artifact upload ${upload.id} committed ${upload.committedBytes}/${upload.size} bytes`,
        workerId: upload.workerId,
        attemptId: upload.attemptId,
        data: {
          uploadId: upload.id,
          path: upload.path,
          previousCommittedBytes,
          committedBytes: upload.committedBytes,
          chunkBytes: written,
          size: upload.size,
          sha256: upload.sha256,
        },
      });
      await this.save();
      return publicArtifactUpload(upload);
    });
  }

  async finalizeArtifactUpload(taskId, uploadId, input = {}) {
    return this.withArtifactUploadLock(uploadId, async () => {
      const upload = this.state.artifactUploads[uploadId];
      if (!upload || upload.taskId !== taskId) {
        const error = new Error(`Unknown artifact upload: ${uploadId}`);
        error.status = 404;
        throw error;
      }
      this.assertLiveArtifactUploadTask(taskId, input.attemptId, input.workerId);
      if (upload.attemptId !== input.attemptId || upload.workerId !== input.workerId) {
        const error = new Error(`Artifact upload ownership is stale: ${uploadId}`);
        error.status = 409;
        throw error;
      }
      if (upload.status === 'finalized') {
        return publicArtifactUpload(upload);
      }
      if (upload.committedBytes !== upload.size) {
        const error = new Error(`Artifact upload is incomplete: ${upload.committedBytes}/${upload.size}`);
        error.status = 409;
        error.expectedOffset = upload.committedBytes;
        throw error;
      }
      const hash = crypto.createHash('sha256');
      for await (const chunk of createReadStream(upload.tempPath)) {
        hash.update(chunk);
      }
      const actualSha256 = hash.digest('hex');
      if (actualSha256 !== upload.sha256) {
        await fs.truncate(upload.tempPath, 0);
        upload.committedBytes = 0;
        upload.updatedAt = nowIso();
        upload.lastError = 'sha256_mismatch';
        await this.save();
        const error = new Error('Artifact SHA-256 mismatch; upload was reset for retry');
        error.status = 422;
        error.expectedOffset = 0;
        throw error;
      }
      const storagePath = path.join(path.dirname(upload.tempPath), `${safeName(upload.id)}.bin`);
      await fs.rename(upload.tempPath, storagePath);
      upload.tempPath = null;
      upload.storagePath = storagePath;
      upload.status = 'finalized';
      upload.updatedAt = nowIso();
      upload.finalizedAt = upload.updatedAt;
      upload.lastError = null;
      const task = this.state.tasks[taskId];
      task?.events?.push({
        at: upload.finalizedAt,
        type: 'artifact_upload_finalized',
        message: `Artifact upload ${upload.id} finalized at ${upload.size} bytes`,
        workerId: upload.workerId,
        attemptId: upload.attemptId,
        data: {
          uploadId: upload.id,
          path: upload.path,
          committedBytes: upload.committedBytes,
          size: upload.size,
          sha256: upload.sha256,
        },
      });
      await this.save();
      return publicArtifactUpload(upload);
    });
  }

  listArtifacts(taskId) {
    const task = this.getTask(taskId);
    return task.artifacts || [];
  }

  getArtifact(taskId, artifactId) {
    const artifact = this.listArtifacts(taskId).find((item) => item.id === artifactId);
    if (!artifact) {
      throw new Error(`Unknown artifact: ${artifactId}`);
    }
    return artifact;
  }

  async readArtifact(taskId, artifactId) {
    const { artifact, bytes } = await this.readArtifactBytes(taskId, artifactId);
    return {
      artifact,
      contentBase64: bytes.toString('base64'),
    };
  }

  async readArtifactBytes(taskId, artifactId) {
    const artifact = this.getArtifact(taskId, artifactId);
    if (artifact.skipped || !artifact.storagePath) {
      throw new Error(`Artifact is not available for download: ${artifact.path}`);
    }
    const bytes = await fs.readFile(artifact.storagePath);
    return {
      artifact,
      bytes,
    };
  }
}

export class SQLiteStore extends JsonStore {
  constructor(file) {
    super(file);
    this.sqlite = null;
    this.sql = null;
    this.backend = 'sqlite';
  }

  static defaultPath(dataDir) {
    return path.join(dataDir, 'control-state.sqlite');
  }

  async load() {
    await ensureDir(this.dataDir);
    this.sql = this.sql || await initSqlJs();
    const exists = await fileExists(this.file);
    this.sqlite = exists
      ? new this.sql.Database(await fs.readFile(this.file))
      : new this.sql.Database();
    this.migrate();
    const loaded = this.loadStateFromDatabase();
    if (loaded) {
      const sourceVersion = Number(loaded.version ?? 0);
      this.state = normalizeStateShape(loaded);
      this.lastMigration = {
        fromVersion: sourceVersion,
        toVersion: CURRENT_STATE_VERSION,
        migrated: sourceVersion < CURRENT_STATE_VERSION,
      };
      if (this.lastMigration.migrated || this.lastSchemaMigration.migrated) {
        await this.save();
      }
      return;
    }
    const jsonFallback = JsonStore.defaultPath(this.dataDir);
    const fallbackState = await readJson(jsonFallback, initialState());
    const sourceVersion = Number(fallbackState?.version ?? 0);
    this.state = normalizeStateShape(fallbackState);
    this.lastMigration = {
      fromVersion: sourceVersion,
      toVersion: CURRENT_STATE_VERSION,
      migrated: sourceVersion < CURRENT_STATE_VERSION,
    };
    await this.save();
  }

  migrate() {
    const schemaRows = this.sqlite.exec('PRAGMA user_version');
    const sourceSchemaVersion = Number(schemaRows[0]?.values?.[0]?.[0] || 0);
    if (sourceSchemaVersion > CURRENT_SQLITE_SCHEMA_VERSION) {
      throw new Error(`SQLite schema version ${sourceSchemaVersion} is newer than supported version ${CURRENT_SQLITE_SCHEMA_VERSION}`);
    }
    this.sqlite.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS nado_state (
        collection TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (collection, key)
      );
      CREATE TABLE IF NOT EXISTS nado_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_nado_state_collection_position
        ON nado_state(collection, position);
      PRAGMA user_version = ${CURRENT_SQLITE_SCHEMA_VERSION};
    `);
    this.schemaVersion = CURRENT_SQLITE_SCHEMA_VERSION;
    this.lastSchemaMigration = {
      fromVersion: sourceSchemaVersion,
      toVersion: CURRENT_SQLITE_SCHEMA_VERSION,
      migrated: sourceSchemaVersion < CURRENT_SQLITE_SCHEMA_VERSION,
    };
  }

  loadStateFromDatabase() {
    const state = initialState();
    state.version = 0;
    const rows = this.sqlite.exec('SELECT collection, key, value FROM nado_state ORDER BY collection, position, key');
    if (!rows.length || !rows[0].values.length) {
      return null;
    }
    for (const [collection, key, value] of rows[0].values) {
      state[collection] ??= {};
      state[collection][key] = JSON.parse(value);
    }
    const meta = this.sqlite.exec('SELECT key, value FROM nado_meta');
    if (meta.length) {
      for (const [key, value] of meta[0].values) {
        state[key] = JSON.parse(value);
      }
    }
    return state;
  }

  async save() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await this.writeFence?.assertOwned();
        this.writeSnapshot(snapshot);
        await this.persistDatabase();
      });
    await this.writeQueue;
  }

  writeSnapshot(snapshot) {
    const collections = [
      ['workers', snapshot.workerOrder || Object.keys(snapshot.workers || {})],
      ['workerTokens', snapshot.workerTokenOrder || Object.keys(snapshot.workerTokens || {})],
      ['workerSignatureNonces', Object.keys(snapshot.workerSignatureNonces || {})],
      ['workerEnrollmentTokens', snapshot.workerEnrollmentTokenOrder || Object.keys(snapshot.workerEnrollmentTokens || {})],
      ['sessions', snapshot.sessionOrder || Object.keys(snapshot.sessions || {})],
      ['batches', snapshot.batchOrder || Object.keys(snapshot.batches || {})],
      ['artifactUploads', snapshot.artifactUploadOrder || Object.keys(snapshot.artifactUploads || {})],
      ['inputUploads', snapshot.inputUploadOrder || Object.keys(snapshot.inputUploads || {})],
      ['tasks', snapshot.taskOrder || Object.keys(snapshot.tasks || {})],
    ];
    const metaKeys = [
      'version',
      'workerTokenOrder',
      'workerEnrollmentTokenOrder',
      'sessionOrder',
      'batchOrder',
      'artifactUploadOrder',
      'inputUploadOrder',
      'taskOrder',
      'commandOrder',
      'auditEvents',
    ];
    this.sqlite.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      this.sqlite.exec('DELETE FROM nado_state; DELETE FROM nado_meta;');
      const insertState = this.sqlite.prepare(`
        INSERT INTO nado_state (collection, key, value, position, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      try {
        for (const [collection, orderedKeys] of collections) {
          const bucket = snapshot[collection] || {};
          const keys = Array.from(new Set([...(orderedKeys || []), ...Object.keys(bucket)]));
          keys.forEach((key, index) => {
            if (bucket[key] !== undefined) {
              insertState.run([collection, key, JSON.stringify(bucket[key]), index]);
            }
          });
        }
      } finally {
        insertState.free();
      }
      const insertMeta = this.sqlite.prepare(`
        INSERT INTO nado_meta (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `);
      try {
        for (const key of metaKeys) {
          insertMeta.run([key, JSON.stringify(snapshot[key] ?? [])]);
        }
      } finally {
        insertMeta.free();
      }
      this.sqlite.exec('COMMIT');
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  async persistDatabase() {
    await this.writeFence?.assertOwned();
    const bytes = Buffer.from(this.sqlite.export());
    await ensureDir(path.dirname(this.file));
    const tmp = `${this.file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, bytes);
    try {
      await this.writeFence?.assertOwned();
      await fs.rename(tmp, this.file);
    } catch (error) {
      if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EEXIST')) {
        await this.writeFence?.assertOwned();
        await fs.rm(this.file, { force: true });
        await fs.rename(tmp, this.file);
        return;
      }
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async compact() {
    await this.save();
    this.sqlite.exec('VACUUM');
    await this.persistDatabase();
    return {
      backend: 'sqlite',
      path: this.file,
      compacted: true,
    };
  }
}

export function createStore(options = {}) {
  const dataDir = options.dataDir || path.resolve('.nado');
  const backend = String(options.backend || process.env.NADO_STORE || 'json').trim().toLowerCase();
  if (backend === 'sqlite' || backend === 'sqlite-wasm') {
    return new SQLiteStore(options.file || SQLiteStore.defaultPath(dataDir));
  }
  if (backend === 'json' || backend === 'file') {
    return new JsonStore(options.file || JsonStore.defaultPath(dataDir));
  }
  throw new Error(`Unknown Nado store backend: ${backend}`);
}
