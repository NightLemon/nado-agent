import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectInventory } from './inventory.js';
import { normalizeResourceRequirements, resourceFitForTask, workerResourceCapacity } from './resource-model.js';
import { normalizeToolName } from './scheduler.js';
import { workerReadinessDiagnostics } from './worker-diagnostics.js';
import { readWorkerIdentity, workerIdentityKeyPairStatus } from './worker-enrollment.js';

function check(key, status, summary, evidence = {}, nextAction = null, required = true) {
  return { key, status, required, summary, evidence, nextAction };
}

async function writableDataDirectory(dataDir) {
  const directory = path.resolve(dataDir || '.nado');
  const probe = path.join(
    directory,
    `.nado-worker-inspect-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(probe, 'nado-worker-inspect', { flag: 'wx', mode: 0o600 });
    const content = await fs.readFile(probe, 'utf8');
    if (content !== 'nado-worker-inspect') {
      throw new Error('write verification returned unexpected content');
    }
    return { ok: true, directory };
  } catch (error) {
    return { ok: false, directory, error: error.message };
  } finally {
    await fs.rm(probe, { force: true }).catch(() => {});
  }
}

function identitySummary(identity) {
  if (!identity || typeof identity !== 'object') {
    return {
      present: false,
      workerId: null,
      workerTokenId: null,
      controlUrl: null,
      signedKeyReady: false,
      error: 'worker identity is not enrolled in this data directory',
    };
  }
  const keyStatus = workerIdentityKeyPairStatus(identity);
  return {
    present: Boolean(identity.workerId && identity.workerToken),
    workerId: identity.workerId || null,
    workerTokenId: identity.workerTokenId || null,
    controlUrl: identity.controlUrl || null,
    signedKeyReady: keyStatus.ready,
    error: keyStatus.error,
  };
}

function listValues(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

export async function inspectLocalWorker(options = {}) {
  const requiredResources = normalizeResourceRequirements(options.requiredResources || {});
  const requiredTools = Array.from(new Set(listValues(options.requiredTools).map(normalizeToolName)));
  const requiredCapabilities = Array.from(new Set(listValues(options.requiredCapabilities).map((item) => item.toLowerCase())));
  const inventory = options.inventory || await collectInventory(options.capabilities || []);
  const identity = options.identity === undefined
    ? await readWorkerIdentity(options.dataDir || '.nado')
    : options.identity;
  const dataDirectory = options.dataDirectoryCheck || await writableDataDirectory(options.dataDir || '.nado');
  const worker = {
    capabilities: inventory.inferredCapabilities || [],
    inventory,
    agentCommandConfigured: Boolean(options.agentCommand),
    agentPreset: options.agentPreset || null,
  };
  const capacity = workerResourceCapacity(worker);
  const readiness = workerReadinessDiagnostics(worker);
  const localIdentity = identitySummary(identity);
  const checks = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(check(
    'nodeRuntime',
    nodeMajor >= 20 ? 'passed' : 'failed',
    'Node.js 20 or newer is available',
    { version: process.version },
    nodeMajor >= 20 ? null : 'Install Node.js 20+ before starting the Worker',
  ));
  checks.push(check(
    'dataDirectory',
    dataDirectory.ok ? 'passed' : 'failed',
    'The Worker data directory is readable and writable',
    dataDirectory,
    dataDirectory.ok ? null : 'Choose a writable --data-dir and verify filesystem permissions plus free space',
  ));

  const missingCapabilities = requiredCapabilities.filter((item) => !worker.capabilities.includes(item));
  checks.push(check(
    'requiredCapabilities',
    missingCapabilities.length ? 'failed' : 'passed',
    'Configured and inferred Worker capabilities satisfy local requirements',
    { required: requiredCapabilities, available: worker.capabilities, missing: missingCapabilities },
    missingCapabilities.length ? `Install/configure the missing capabilities: ${missingCapabilities.join(', ')}` : null,
    requiredCapabilities.length > 0,
  ));

  const missingTools = requiredTools.filter((tool) => !inventory.tools?.[tool]?.available);
  checks.push(check(
    'requiredTools',
    missingTools.length ? 'failed' : 'passed',
    'Required executables are present in Worker inventory',
    { required: requiredTools, missing: missingTools },
    missingTools.length ? `Install or expose the missing tools on PATH: ${missingTools.join(', ')}` : null,
    requiredTools.length > 0,
  ));

  const resourceFit = resourceFitForTask({ requiredResources }, worker, [], { ignoreCurrentCapacity: true });
  checks.push(check(
    'requiredResources',
    resourceFit.eligible ? 'passed' : 'failed',
    'CPU, RAM, GPU count, VRAM, and GPU model satisfy local requirements',
    resourceFit,
    resourceFit.eligible ? null : resourceFit.reasons.join('; '),
    Object.keys(requiredResources).length > 0,
  ));

  const gpuReady = capacity.gpuCount > 0 && capacity.gpuMemoryBytes > 0;
  checks.push(check(
    'gpuRuntime',
    options.requireGpu ? (gpuReady ? 'passed' : 'failed') : 'skipped',
    'A vendor GPU probe reports at least one device with VRAM',
    { count: capacity.gpuCount, memoryTotalBytes: capacity.gpuMemoryBytes, devices: capacity.allGpus },
    options.requireGpu && !gpuReady
      ? 'Install/repair nvidia-smi, amd-smi, or rocm-smi and verify the vendor runtime can query VRAM'
      : null,
    Boolean(options.requireGpu),
  ));

  const agentReady = readiness.agent.realTerminalAgent && readiness.agent.readyForAgentTasks;
  checks.push(check(
    'terminalAgentRuntime',
    options.requireAgent ? (agentReady ? 'passed' : 'failed') : 'skipped',
    'A configured Codex or Claude terminal Agent executable is locally available',
    readiness.agent,
    options.requireAgent && !agentReady
      ? 'Configure --agent codex|claude and install/authenticate the matching CLI; run online doctor --agent-self-test afterward'
      : null,
    Boolean(options.requireAgent),
  ));

  const identityReady = localIdentity.present && localIdentity.signedKeyReady;
  checks.push(check(
    'workerIdentity',
    options.requireIdentity ? (identityReady ? 'passed' : 'failed') : 'skipped',
    'A matching Ed25519 Worker identity and scoped token are stored locally',
    localIdentity,
    options.requireIdentity && !identityReady
      ? 'Run worker bootstrap-start from a fresh self-service bundle to enroll a signed Worker identity'
      : null,
    Boolean(options.requireIdentity),
  ));

  const requiredChecks = checks.filter((item) => item.required);
  const failed = requiredChecks.filter((item) => item.status === 'failed');
  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: failed.length === 0,
    requirements: {
      requireGpu: Boolean(options.requireGpu),
      requireAgent: Boolean(options.requireAgent),
      requireIdentity: Boolean(options.requireIdentity),
      requiredCapabilities,
      requiredTools,
      requiredResources,
    },
    host: inventory.host || {},
    capabilities: worker.capabilities,
    tools: inventory.tools || {},
    resources: capacity,
    readiness,
    identity: localIdentity,
    checks,
    summary: {
      required: requiredChecks.length,
      passed: requiredChecks.filter((item) => item.status === 'passed').length,
      failed: failed.length,
    },
    nextActions: failed.filter((item) => item.nextAction).map((item) => ({
      key: item.key,
      action: item.nextAction,
    })),
  };
}
