import crypto from 'node:crypto';
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
  scheduleTask,
  taskSlotCost,
} from './scheduler.js';
import { buildDispatchPlan } from './dispatch-plan.js';
import { routingActionHint } from './routing-diagnostics.js';
import { workerReadinessDiagnostics, workerResourceDiagnostics } from './worker-diagnostics.js';

const ACTIVE_WINDOW_MS = 45_000;

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
  delete merged.worker;
  delete merged.session;
  delete merged.capabilities;
  delete merged.tools;
  delete merged.taskSlots;
  delete merged.labels;
  delete merged.sandbox;
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
    nextAction: routingActionHint(task),
    inferredCapabilities: task.scheduler?.inferredCapabilities || [],
    effectiveRequiredCapabilities: task.scheduler?.effectiveRequiredCapabilities || [],
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

function compactTaskSnapshot(task) {
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
    scheduler: task.scheduler || null,
    nextAction: routingActionHint(task),
    attemptSeq: task.attemptSeq || 0,
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || null,
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    exitCode: task.exitCode ?? null,
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
    version: 1,
    workers: {},
    workerTokens: {},
    workerSignatureNonces: {},
    workerEnrollmentTokens: {},
    sessions: {},
    batches: {},
    workerTokenOrder: [],
    workerEnrollmentTokenOrder: [],
    sessionOrder: [],
    batchOrder: [],
    tasks: {},
    taskOrder: [],
    commandOrder: [],
  };
}

function normalizeStateShape(state) {
  const normalized = state || initialState();
  normalized.workers ??= {};
  normalized.workerTokens ??= {};
  normalized.workerSignatureNonces ??= {};
  normalized.workerEnrollmentTokens ??= {};
  normalized.sessions ??= {};
  normalized.batches ??= {};
  normalized.workerTokenOrder ??= Object.keys(normalized.workerTokens);
  normalized.workerEnrollmentTokenOrder ??= Object.keys(normalized.workerEnrollmentTokens);
  normalized.sessionOrder ??= Object.keys(normalized.sessions);
  normalized.batchOrder ??= Object.keys(normalized.batches);
  normalized.tasks ??= {};
  normalized.taskOrder ??= Object.keys(normalized.tasks);
  normalized.commandOrder ??= [];
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

function normalizeWorkerEvents(events) {
  return Array.isArray(events) ? events.slice(-300) : [];
}

function taskSortTime(task) {
  return Date.parse(task.completedAt || task.updatedAt || task.createdAt || '') || 0;
}

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.dataDir = path.dirname(file);
    this.artifactDir = path.join(this.dataDir, 'artifacts');
    this.state = initialState();
    this.writeQueue = Promise.resolve();
  }

  static defaultPath(dataDir) {
    return path.join(dataDir, 'control-state.json');
  }

  async load() {
    this.state = normalizeStateShape(await readJson(this.file, initialState()));
  }

  async save() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() => writeJson(this.file, snapshot));
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

  async upsertWorker(worker) {
    const now = nowIso();
    const existing = this.state.workers[worker.id] || {};
    const updated = {
      ...existing,
      id: worker.id,
      name: worker.name || worker.id,
      host: worker.host || existing.host || null,
      capabilities: Array.from(new Set(worker.capabilities || existing.capabilities || [])),
      labels: { ...(existing.labels || {}), ...normalizeLabels(worker.labels) },
      agentCommandConfigured: Boolean(worker.agentCommandConfigured),
      agentPreset: worker.agentPreset || existing.agentPreset || null,
      maxConcurrency: maxConcurrency(worker.maxConcurrency || existing.maxConcurrency),
      adminState: existing.adminState || 'enabled',
      observedState: worker.observedState || existing.observedState || 'idle',
      currentTaskIds: normalizeTaskIds(worker.currentTaskIds ?? existing.currentTaskIds, worker.currentTaskId ?? existing.currentTaskId ?? null),
      currentTaskId: null,
      metrics: worker.metrics || existing.metrics || {},
      inventory: worker.inventory || existing.inventory || {},
      diagnostics: existing.diagnostics || {},
      commands: existing.commands || [],
      events: normalizeWorkerEvents(existing.events),
      registeredAt: existing.registeredAt || now,
      lastSeenAt: now,
    };
    updated.currentTaskId = updated.currentTaskIds[0] || null;
    this.appendWorkerEvent(updated, {
      type: 'registered',
      level: 'info',
      message: `Worker ${worker.id} registered`,
      data: {
        capabilities: updated.capabilities,
        labels: updated.labels,
        maxConcurrency: updated.maxConcurrency,
        agentPreset: updated.agentPreset,
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
    ));
    if (!record) {
      return null;
    }
    record.lastUsedAt = now;
    return {
      type: 'worker',
      workerId: record.workerId,
      workerTokenId: record.id,
    };
  }

  async heartbeat(workerId, input = {}) {
    const worker = this.state.workers[workerId];
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    const reportedTaskIds = normalizeTaskIds(input.currentTaskIds ?? worker.currentTaskIds, input.currentTaskId ?? null);
    const currentTaskIds = reportedTaskIds.filter((taskId) => {
      const task = this.state.tasks[taskId];
      return task?.status === 'running' && task.assignedWorkerId === workerId;
    });
    const hasRunningAssignedTask = Object.values(this.state.tasks)
      .some((task) => task.status === 'running' && task.assignedWorkerId === workerId);
    const staleRunningHeartbeat = input.observedState === 'running' && !currentTaskIds.length && !hasRunningAssignedTask;
    worker.lastSeenAt = nowIso();
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
    const workerItems = workers.map(compactWorkerSnapshot);
    const sessions = this.listSessions();
    const tasks = this.listTasks();
    const taskItems = tasks.map(compactTaskSnapshot);
    const batches = this.listBatches();
    const taskCounts = tasks.reduce((acc, task) => {
      acc[task.status] = (acc[task.status] || 0) + 1;
      return acc;
    }, {});
    const batchCounts = batches.reduce((acc, batch) => {
      acc[batch.status] = (acc[batch.status] || 0) + 1;
      return acc;
    }, {});
    const attentionTasks = tasks.filter(taskNeedsAttention);
    return {
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
          routingIssues: attentionTasks.length,
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
    const active = (counts.queued || 0) + (counts.running || 0);
    if (tasks.length && terminal === tasks.length) {
      status = (counts.failed || counts.cancelled) ? 'completed_with_errors' : 'succeeded';
    } else if (!active && (counts.failed || counts.cancelled || counts.blocked)) {
      status = 'completed_with_errors';
    } else if (counts.running) {
      status = 'running';
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
        const bytes = await fs.readFile(artifact.storagePath);
        files.push({
          path: `${policy.prefix}/${dependencyLabel}/${artifact.path}`,
          contentBase64: bytes.toString('base64'),
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
      resources: workerResourceDiagnostics(worker),
      readiness: workerReadinessDiagnostics(worker),
    };
  }

  appendWorkerEvent(worker, event = {}) {
    const item = {
      at: event.at || nowIso(),
      type: event.type || 'log',
      level: event.level || 'info',
      message: String(event.message || ''),
      workerId: worker.id,
      data: event.data || undefined,
    };
    worker.events = normalizeWorkerEvents(worker.events);
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
    const item = this.appendWorkerEvent(worker, event);
    worker.lastEventAt = item.at;
    if (item.type === 'agent_self_test') {
      worker.diagnostics ??= {};
      worker.diagnostics.agentSelfTest = {
        at: item.at,
        status: event.data?.status || 'unknown',
        taskId: event.data?.taskId || null,
        exitCode: event.data?.exitCode ?? null,
        error: event.data?.error || null,
      };
    }
    if (item.type === 'self_test') {
      worker.diagnostics ??= {};
      worker.diagnostics.selfTest = {
        at: item.at,
        status: event.data?.status || 'unknown',
        taskId: event.data?.taskId || null,
        exitCode: event.data?.exitCode ?? null,
        error: event.data?.error || null,
      };
    }
    await this.save();
    return item;
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
    const now = nowIso();
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
      env: normalizeEnv(input.env),
      sandboxProfile: normalizeSandboxProfile(input.sandboxProfile ?? input.sandbox),
      artifactPolicy: normalizeArtifactPolicy(input.artifactPolicy),
      dependencyArtifacts: normalizeDependencyArtifacts(input.dependencyArtifacts),
      dependencyInputFiles: [],
      inputFiles: input.inputFiles || [],
      attemptSeq: Number(input.attemptSeq || 0),
      currentAttemptId: input.currentAttemptId || null,
      attempts: Array.isArray(input.attempts) ? input.attempts : [],
      keepWorkspace: typeof input.keepWorkspace === 'boolean' ? input.keepWorkspace : undefined,
      timeoutMs: Number(input.timeoutMs || 10 * 60 * 1000),
      maxOutputChars: Number(input.maxOutputChars || 80_000),
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      exitCode: null,
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

    if (task.status === 'blocked') {
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
    return task;
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

  async pruneTaskHistory(options = {}) {
    const preview = this.listPrunableTasks(options);
    const pruned = [];
    for (const task of preview.tasks) {
      delete this.state.tasks[task.id];
      pruned.push({
        id: task.id,
        title: task.title,
        status: task.status,
        completedAt: task.completedAt || null,
      });
      await fs.rm(path.join(this.artifactDir, safeName(task.id)), { recursive: true, force: true });
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
      prunedTasks.push({
        id: task.id,
        title: task.title,
        status: task.status,
        completedAt: task.completedAt || null,
      });
      await fs.rm(path.join(this.artifactDir, safeName(task.id)), { recursive: true, force: true });
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

  async claimTask(workerId) {
    const worker = this.state.workers[workerId];
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    worker.maxConcurrency = maxConcurrency(worker.maxConcurrency);
    worker.currentTaskIds = normalizeTaskIds(worker.currentTaskIds, worker.currentTaskId);
    worker.currentTaskId = worker.currentTaskIds[0] || null;
    const runningSlots = this.listTasks()
      .filter((candidate) => candidate.assignedWorkerId === workerId && candidate.status === 'running')
      .reduce((sum, candidate) => sum + taskSlotCost(candidate), 0);
    if (runningSlots >= worker.maxConcurrency) {
      worker.lastSeenAt = nowIso();
      await this.save();
      return null;
    }

    const task = this.listTasks().find((candidate) => {
      if (candidate.status !== 'queued') {
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
      if (runningSlots + taskSlotCost(candidate) > worker.maxConcurrency) {
        return false;
      }
      return isSubset(effectiveRequiredCapabilities(candidate), worker.capabilities)
        && !missingRequiredTools(candidate, worker).length
        && hasLabels(candidate.requiredLabels || {}, worker.labels || {});
    });

    if (!task) {
      worker.lastSeenAt = nowIso();
      await this.save();
      return null;
    }

    const now = nowIso();
    const attemptId = newId('attempt');
    task.status = 'running';
    task.assignedWorkerId = workerId;
    task.attemptSeq = Number(task.attemptSeq || 0) + 1;
    task.currentAttemptId = attemptId;
    task.attempts ??= [];
    task.attempts.push({
      id: attemptId,
      seq: task.attemptSeq,
      workerId,
      claimedAt: now,
      completedAt: null,
      status: 'running',
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
    await this.save();
    return task;
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
    const allowed = new Set(['pause', 'resume', 'drain', 'shutdown', 'cancel_current']);
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

  async acknowledgeCommand(workerId, commandId, status = 'acknowledged', message = '') {
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
      },
    });
    await this.save();
    return command;
  }

  async addTaskEvent(taskId, event) {
    const task = this.getTask(taskId);
    if (task.currentAttemptId && event.attemptId !== task.currentAttemptId) {
      return {
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
      at: event.at || nowIso(),
      type: event.type || 'event',
      message: event.message || '',
      workerId: event.workerId || task.assignedWorkerId || null,
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
    const artifacts = await this.saveArtifacts(task.id, result.artifacts || []);
    task.status = result.status || (result.exitCode === 0 ? 'succeeded' : 'failed');
    task.exitCode = result.exitCode ?? null;
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
    await this.save();
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
      return task;
    }

    if (action === 'requeue') {
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
        reason: options.reason || 'Task requeued by gateway task management',
        touchWorker: activeWorker,
      });
        await this.refreshBatchDependencyStates(task.batchId, now);
      await this.save();
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
    task.currentAttemptId = null;
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
    this.clearTaskRuntime(task, now, { touchWorker: options.touchWorker });
    task.assignedWorkerId = null;
    task.startedAt = null;
    task.completedAt = null;
    task.exitCode = null;
    task.stdout = '';
    task.stderr = '';
    task.error = null;
    task.workspace = null;
    task.workspaceCleaned = false;
    task.artifacts = [];
    task.currentAttemptId = null;
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
        return !lastSeen || Date.now() - lastSeen > ACTIVE_WINDOW_MS;
      })
      .map((task) => {
        const worker = this.state.workers[task.assignedWorkerId] || null;
        const lastSeen = worker?.lastSeenAt ? Date.parse(worker.lastSeenAt) : 0;
        return {
          task,
          worker: worker ? this.decorateWorker(worker) : null,
          offlineMs: lastSeen ? Date.now() - lastSeen : null,
        };
      });
  }

  async recoverOfflineTasks(options = {}) {
    const action = options.action || 'list';
    const allowed = new Set(['list', 'requeue']);
    if (!allowed.has(action)) {
      throw new Error(`Unsupported recovery action: ${action}`);
    }
    const candidates = this.listOfflineRunningTasks({ workerId: options.workerId });
    if (action === 'list') {
      return { action, candidates, recovered: [], skipped: [] };
    }

    const now = nowIso();
    const recovered = [];
    const skipped = [];
    for (const item of candidates) {
      const task = this.getTask(item.task.id);
      if (task.sessionId && !options.includeSessions) {
        skipped.push({
          task,
          reason: 'session task recovery requires --include-sessions because its worker-local session workspace may be unavailable',
        });
        continue;
      }

      const session = task.sessionId ? this.getSession(task.sessionId) : null;
      this.clearTaskRuntime(task, now, { touchWorker: false });
      task.status = 'queued';
      task.assignedWorkerId = null;
      task.startedAt = null;
      task.completedAt = null;
      task.exitCode = null;
      task.stdout = '';
      task.stderr = '';
      task.error = null;
      task.workspace = null;
      task.workspaceCleaned = false;
      task.artifacts = [];
      task.currentAttemptId = null;
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
      task.requestedWorkerId = options.targetWorkerId || null;
      if (session) {
        session.assignedWorkerId = options.targetWorkerId || null;
        session.requestedWorkerId = options.targetWorkerId || null;
        session.workspace = null;
        session.updatedAt = now;
        session.events.push({
          at: now,
          type: 'offline_recovered',
          message: `Recovered offline task ${task.id}`,
          taskId: task.id,
          workerId: options.targetWorkerId || null,
        });
      }
      task.updatedAt = now;
      task.events.push({
        at: now,
        type: 'offline_recovered',
        message: options.reason || `Recovered from offline worker ${item.worker?.id || task.assignedWorkerId || 'unknown'}`,
        data: {
          previousWorkerId: item.worker?.id || item.task.assignedWorkerId,
          targetWorkerId: options.targetWorkerId || null,
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
          reason: 'recovered to explicit worker',
          candidates: [],
        };
      }
      await this.refreshBatchDependencyStates(task.batchId, now);
      recovered.push(task);
    }

    await this.save();
    return { action, candidates, recovered, skipped };
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

  async saveArtifacts(taskId, artifacts) {
    const saved = [];
    const dir = path.join(this.artifactDir, safeName(taskId));
    await ensureDir(dir);

    for (const artifact of artifacts) {
      const record = {
        id: newId('artifact'),
        taskId,
        path: artifact.path,
        size: artifact.size || 0,
        sha256: artifact.sha256 || null,
        skipped: Boolean(artifact.skipped),
        reason: artifact.reason || null,
        storedAt: nowIso(),
      };
      if (!record.skipped && artifact.contentBase64) {
        const fileName = `${record.id}.bin`;
        await fs.writeFile(path.join(dir, fileName), Buffer.from(artifact.contentBase64, 'base64'));
        record.storagePath = path.join(dir, fileName);
      }
      saved.push(record);
    }
    return saved;
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
      this.state = normalizeStateShape(loaded);
      return;
    }
    const jsonFallback = JsonStore.defaultPath(this.dataDir);
    this.state = normalizeStateShape(await readJson(jsonFallback, initialState()));
    await this.save();
  }

  migrate() {
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
    `);
  }

  loadStateFromDatabase() {
    const state = initialState();
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
      ['tasks', snapshot.taskOrder || Object.keys(snapshot.tasks || {})],
    ];
    const metaKeys = [
      'workerTokenOrder',
      'workerEnrollmentTokenOrder',
      'sessionOrder',
      'batchOrder',
      'taskOrder',
      'commandOrder',
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
          insertMeta.run([key, JSON.stringify(snapshot[key] || [])]);
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
    const bytes = Buffer.from(this.sqlite.export());
    await ensureDir(path.dirname(this.file));
    const tmp = `${this.file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, bytes);
    try {
      await fs.rename(tmp, this.file);
    } catch (error) {
      if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EEXIST')) {
        await fs.rm(this.file, { force: true });
        await fs.rename(tmp, this.file);
        return;
      }
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
