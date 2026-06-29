import { workerResourceDiagnostics } from './worker-diagnostics.js';

export const DEMO_ROUTE_DEFINITIONS = [
  {
    key: 'gpu',
    capability: 'gpu',
    title: 'Run CUDA model inference benchmark',
  },
  {
    key: 'ppt',
    capability: 'ppt',
    title: 'Create a product presentation PPT outline',
  },
  {
    key: 'docs',
    capability: 'docs',
    title: 'Write the project README documentation',
  },
];

function workerHasCapability(worker, capability) {
  return worker.adminState === 'enabled'
    && worker.gatewayState !== 'offline'
    && (worker.capabilities || []).includes(capability);
}

function routeCheckFromPlanItem(definition, item, workersById = new Map()) {
  const inferred = item.scheduler?.inferredCapabilities || [];
  const effective = item.scheduler?.effectiveRequiredCapabilities || item.effectiveRequiredCapabilities || [];
  const workerId = item.scheduler?.workerId || null;
  const resourceDiagnostics = workerId && workersById.has(workerId)
    ? workerResourceDiagnostics(workersById.get(workerId))
    : {};
  const warnings = [];
  for (const warning of item.scheduler?.warnings || []) {
    const message = warning?.message || warning?.code || '';
    if (message && !warnings.includes(message)) {
      warnings.push(message);
    }
  }
  if (definition.capability === 'gpu' && resourceDiagnostics.gpu?.warning) {
    if (!warnings.includes(resourceDiagnostics.gpu.warning)) {
      warnings.push(resourceDiagnostics.gpu.warning);
    }
  }
  return {
    key: definition.key,
    capability: definition.capability,
    title: definition.title,
    status: workerId ? 'assigned' : 'unassigned',
    workerId,
    reason: item.scheduler?.reason || null,
    inferredCapabilities: inferred,
    effectiveRequiredCapabilities: effective,
    inferenceReasons: item.scheduler?.inferenceReasons || [],
    candidates: item.scheduler?.candidates || [],
    resourceDiagnostics,
    warnings,
  };
}

export async function buildDemoRouteChecks({ workers = [], planDispatch }) {
  const runnable = DEMO_ROUTE_DEFINITIONS.filter((definition) => (
    workers.some((worker) => workerHasCapability(worker, definition.capability))
  ));
  const skipped = DEMO_ROUTE_DEFINITIONS
    .filter((definition) => !runnable.includes(definition))
    .map((definition) => ({
      key: definition.key,
      capability: definition.capability,
      title: definition.title,
      status: 'skipped',
      reason: `no active worker advertises ${definition.capability}`,
      workerId: null,
      inferredCapabilities: [],
      effectiveRequiredCapabilities: [],
      inferenceReasons: [],
      candidates: [],
      resourceDiagnostics: {},
      warnings: [],
    }));

  if (!runnable.length) {
    return skipped;
  }

  const spec = {
    title: 'nado demo route checks',
    tasks: runnable.map((definition) => ({
      key: definition.key,
      title: definition.title,
      type: 'agent',
      prompt: definition.title,
    })),
  };
  const plan = await planDispatch(spec);
  const workersById = new Map(workers.map((worker) => [worker.id, worker]));
  const planned = runnable.map((definition, index) => routeCheckFromPlanItem(definition, plan.items[index], workersById));
  return [...planned, ...skipped];
}

export function demoRouteChecksOk(checks = []) {
  return checks.every((check) => (
    check.status === 'skipped'
    || (
      check.status === 'assigned'
      && check.effectiveRequiredCapabilities.includes(check.capability)
    )
  ));
}
