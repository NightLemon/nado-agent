import { buildBatchPlan } from './batch-plan.js';
import {
  agentReadinessForTask,
  effectiveRequiredCapabilities,
  missingRequiredTools,
  scheduleTask,
  taskSlotCost,
} from './scheduler.js';
import { routingActionHint } from './routing-diagnostics.js';
import { hasLabels, isSubset, safeName } from './utils.js';

const ACTIVE_WINDOW_MS = 45_000;

function active(worker) {
  const lastSeen = worker.lastSeenAt ? Date.parse(worker.lastSeenAt) : 0;
  return Boolean(lastSeen && Date.now() - lastSeen <= ACTIVE_WINDOW_MS);
}

function list(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

function labels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, labelValue]) => key && labelValue !== undefined && labelValue !== null)
      .map(([key, labelValue]) => [String(key), String(labelValue)]),
  );
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function mergeTask(defaults = {}, task = {}, index = 0) {
  const merged = {
    ...defaults,
    ...task,
  };
  const key = task.key || task.id || `task_${index + 1}`;
  merged.key = safeName(key).replace(/^[-_.]+|[-_.]+$/g, '') || `task_${index + 1}`;
  merged.title = task.title || task.prompt || task.command || merged.key;
  merged.type = task.type || defaults.type || (task.prompt && !task.command ? 'agent' : 'shell');
  merged.requestedWorkerId = firstDefined(task.requestedWorkerId, task.workerId, task.worker, defaults.workerId, defaults.worker);
  merged.sessionId = firstDefined(task.sessionId, task.session, defaults.sessionId, defaults.session);
  merged.requiredCapabilities = list(firstDefined(
    task.requiredCapabilities,
    task.capabilities,
    defaults.requiredCapabilities,
    defaults.capabilities,
  ));
  merged.requiredTools = Array.from(new Set([
    ...list(firstDefined(defaults.requiredTools, defaults.tools)),
    ...list(firstDefined(task.requiredTools, task.tools)),
  ]));
  merged.requiredLabels = {
    ...labels(defaults.requiredLabels || defaults.labels),
    ...labels(task.requiredLabels || task.labels),
  };
  if (firstDefined(task.slots, task.taskSlots, defaults.slots, defaults.taskSlots) !== undefined) {
    merged.slots = Number(firstDefined(task.slots, task.taskSlots, defaults.slots, defaults.taskSlots));
  }
  delete merged.worker;
  delete merged.workerId;
  delete merged.session;
  delete merged.capabilities;
  delete merged.tools;
  delete merged.labels;
  delete merged.taskSlots;
  return merged;
}

function routeTarget(task, session) {
  return task.requestedWorkerId || session?.assignedWorkerId || session?.requestedWorkerId || null;
}

function routabilityForWorker(task, worker) {
  const reasons = [];
  if (!active(worker)) {
    reasons.push('worker offline');
  }
  if (worker.adminState !== 'enabled') {
    reasons.push(`worker adminState=${worker.adminState}`);
  }
  const agentReadiness = agentReadinessForTask(task, worker);
  if (!agentReadiness.eligible) {
    reasons.push(...agentReadiness.reasons);
  }
  const requiredCapabilities = effectiveRequiredCapabilities(task);
  if (!isSubset(requiredCapabilities, worker.capabilities || [])) {
    const missing = requiredCapabilities.filter((capability) => !(worker.capabilities || []).includes(capability));
    reasons.push(`missing required capabilities: ${missing.join(',')}`);
  }
  if (!hasLabels(task.requiredLabels || {}, worker.labels || {})) {
    reasons.push('missing required labels');
  }
  const missingTools = missingRequiredTools(task, worker);
  if (missingTools.length) {
    reasons.push(`missing required tools: ${missingTools.join(',')}`);
  }
  const taskSlots = taskSlotCost(task);
  const maxConcurrency = Math.max(1, Number(worker.maxConcurrency || 1));
  if (taskSlots > maxConcurrency) {
    reasons.push(`task slots ${taskSlots} exceed worker capacity ${maxConcurrency}`);
  }
  return {
    workerId: worker.id,
    routable: reasons.length === 0,
    reasons,
  };
}

function routabilityForTask({ task, workers, session }) {
  const target = routeTarget(task, session);
  const scopedWorkers = target
    ? workers.filter((worker) => worker.id === target)
    : workers;
  if (target && !scopedWorkers.length) {
    return {
      routable: false,
      reason: `target worker not found: ${target}`,
      candidates: [],
    };
  }
  const candidates = scopedWorkers.map((worker) => routabilityForWorker(task, worker));
  const routable = candidates.some((candidate) => candidate.routable);
  return {
    routable,
    reason: routable ? 'routable' : 'no routable worker',
    candidates,
  };
}

function normalizeSpec(input = {}) {
  if (input.batch && typeof input.batch === 'object') {
    return input.batch;
  }
  if (Array.isArray(input.tasks) && input.tasks.every((task) => typeof task === 'string')) {
    return buildBatchPlan(input);
  }
  return input;
}

export function buildDispatchPlan(input = {}, snapshot = {}) {
  const spec = normalizeSpec(input);
  const rawTasks = Array.isArray(spec.tasks) ? spec.tasks : [];
  if (!rawTasks.length) {
    throw new Error('Dispatch plan requires a tasks array');
  }

  const workers = snapshot.workers || [];
  const existingTasks = [...(snapshot.tasks || [])];
  const sessions = snapshot.sessions || [];
  const items = [];

  rawTasks.forEach((rawTask, index) => {
    const task = mergeTask(spec.defaults || {}, rawTask, index);
    const session = task.sessionId
      ? sessions.find((candidate) => candidate.id === task.sessionId)
      : null;
    const scheduler = scheduleTask({
      task,
      workers,
      tasks: existingTasks,
      session,
    });
    const plannedTask = {
      ...task,
      id: `dispatch_plan_${index}_${task.key}`,
      status: 'queued',
      scheduler,
    };
    const routability = routabilityForTask({ task, workers, session });
    const item = {
      index,
      key: task.key,
      title: task.title,
      type: task.type,
      sessionId: task.sessionId || null,
      requestedWorkerId: task.requestedWorkerId || null,
      requiredCapabilities: task.requiredCapabilities || [],
      inferredCapabilities: scheduler.inferredCapabilities || [],
      effectiveRequiredCapabilities: scheduler.effectiveRequiredCapabilities || task.requiredCapabilities || [],
      requiredTools: task.requiredTools || [],
      requiredLabels: task.requiredLabels || {},
      slots: task.slots || 1,
      scheduler,
      routability,
      nextAction: routingActionHint(plannedTask),
    };
    items.push(item);

    if (scheduler.workerId) {
      existingTasks.push({
        id: `dispatch_plan_${index}_${task.key}`,
        status: 'queued',
        requestedWorkerId: scheduler.workerId,
        slots: task.slots || 1,
      });
    }
  });

  const byWorker = {};
  let unassigned = 0;
  for (const item of items) {
    if (item.scheduler.workerId) {
      byWorker[item.scheduler.workerId] = (byWorker[item.scheduler.workerId] || 0) + 1;
    } else {
      unassigned += 1;
    }
  }

  return {
    title: spec.title || input.title || 'dispatch plan',
    generatedAt: new Date().toISOString(),
    totalTasks: items.length,
    counts: {
      assigned: items.length - unassigned,
      unassigned,
      byWorker,
    },
    items,
  };
}
