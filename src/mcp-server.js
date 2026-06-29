import { NadoClient } from './http-client.js';
import { buildWorkerInvite } from './invite.js';
import { buildWorkerBootstrapBundle, buildWorkerBundle } from './worker-bundle.js';
import { runDoctor } from './doctor.js';
import { runVerify } from './verify.js';
import { listAgentPresets, resolveAgentCommand } from './agent-presets.js';
import { buildBatchPlan } from './batch-plan.js';
import { parseCsvValues } from './utils.js';
import { MCP_TOOL_NAMES } from './mcp-tool-catalog.js';
import {
  routeStatusForTask,
  routingActionHint,
  selectedWorkerIdForTask,
  targetEligibleForTask,
  targetWorkerIdForTask,
} from './routing-diagnostics.js';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function makeConfig() {
  const args = parseArgs(process.argv.slice(2));
  const controlUrl = args.control || process.env.NADO_CONTROL || 'http://127.0.0.1:8765';
  const token = args.token || process.env.NADO_TOKEN;
  if (!token) {
    throw new Error('NADO_TOKEN or --token is required for nado mcp');
  }
  return { controlUrl, token };
}

function makeClient(config = makeConfig()) {
  return new NadoClient(config);
}

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

function toolErrorResult(error) {
  return {
    isError: true,
    ...textResult({
      error: error.message || 'Tool failed',
      status: error.status || null,
      nextActions: error.nextActions || [],
      dispatchPlan: error.dispatchPlan || error.response?.dispatchPlan || null,
      response: error.response || null,
    }),
  };
}

function routingSummaryFromTask(task = {}) {
  const scheduler = task.scheduler || {};
  const candidates = scheduler.candidates || [];
  const selectedWorkerId = selectedWorkerIdForTask(task);
  const targetWorkerId = targetWorkerIdForTask(task);
  return {
    taskId: task.id || null,
    selectedWorkerId,
    targetWorkerId,
    targetEligible: targetEligibleForTask(task),
    requestedWorkerId: task.requestedWorkerId || null,
    assignedWorkerId: task.assignedWorkerId || null,
    routeStatus: routeStatusForTask(task),
    reason: scheduler.reason || null,
    nextAction: routingActionHint(task),
    inferredCapabilities: scheduler.inferredCapabilities || [],
    effectiveRequiredCapabilities: scheduler.effectiveRequiredCapabilities || task.requiredCapabilities || [],
    inferenceReasons: scheduler.inferenceReasons || [],
    warnings: scheduler.warnings || [],
    candidates: candidates.map((candidate) => ({
      workerId: candidate.workerId,
      eligible: Boolean(candidate.eligible),
      score: candidate.score ?? null,
      reasons: candidate.reasons || [],
    })),
    rejectedCandidates: candidates
      .filter((candidate) => !candidate.eligible)
      .map((candidate) => ({
        workerId: candidate.workerId,
        reasons: candidate.reasons || [],
      })),
  };
}

function labelsFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, labelValue]) => key && labelValue !== undefined && labelValue !== null)
      .map(([key, labelValue]) => [String(key), String(labelValue)]),
  );
}

function envFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, envValue]) => key && envValue !== undefined && envValue !== null)
      .map(([key, envValue]) => [String(key), String(envValue)]),
  );
}

function stringListFromValue(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : parseCsvValues([value]);
}

function toolsFromValue(value) {
  return stringListFromValue(value);
}

function loopbackControlUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || host.startsWith('127.');
  } catch {
    return false;
  }
}

async function remoteBundleControl(args = {}, client, fallbackControlUrl) {
  const explicit = args.bundleControlUrl || args.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL || '';
  if (explicit) {
    return {
      controlUrl: explicit,
      source: args.bundleControlUrl ? 'bundleControlUrl' : 'publicControlUrl',
      warning: null,
    };
  }
  if (!loopbackControlUrl(fallbackControlUrl)) {
    return { controlUrl: fallbackControlUrl, source: 'controlUrl', warning: null };
  }
  try {
    const network = await client.networkInfo();
    if (network.preferredRemoteControlUrl) {
      return {
        controlUrl: network.preferredRemoteControlUrl,
        source: network.nextAction?.code || 'network',
        warning: null,
      };
    }
    return {
      controlUrl: fallbackControlUrl,
      source: 'controlUrl',
      warning: network.nextAction?.message || 'No usable remote Control URL candidate was detected.',
    };
  } catch (error) {
    return {
      controlUrl: fallbackControlUrl,
      source: 'controlUrl',
      warning: `Could not inspect remote Control URL candidates: ${error.message}`,
    };
  }
}

function taskCreateRequestFromMcpArgs(args = {}) {
  const requiredCapabilities = Array.isArray(args.capabilities)
    ? args.capabilities
    : parseCsvValues([args.capabilities || '']);
  return {
    title: args.title,
    type: args.type || (args.prompt && !args.command ? 'agent' : 'shell'),
    command: args.command,
    prompt: args.prompt,
    workerId: args.workerId,
    sessionId: args.sessionId,
    requiredCapabilities,
    requiredTools: toolsFromValue(args.tools),
    requiredLabels: labelsFromObject(args.labels || args.requiredLabels),
    env: envFromObject(args.env),
    artifactPolicy: artifactPolicyFromObject(args.artifactPolicy),
    dependencyArtifacts: args.dependencyArtifacts,
    sandboxProfile: args.sandboxProfile || args.sandbox,
    slots: args.slots,
    priority: args.priority,
    keepWorkspace: args.keepWorkspace,
    requireRoutable: args.requireRoutable,
    inputFiles: args.inputFiles || [],
    timeoutMs: args.timeoutMs,
  };
}

function batchCreateRequestFromMcpArgs(args = {}) {
  return {
    title: args.title,
    defaults: args.defaults ? mapMcpTaskInput(args.defaults) : undefined,
    tasks: (args.tasks || []).map((task) => mapMcpTaskInput(task)),
    requireRoutable: Boolean(args.requireRoutable),
  };
}

function artifactPolicyFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const include = stringListFromValue(value.include || value.includes || value.paths);
  const exclude = stringListFromValue(value.exclude || value.excludes);
  if (!include.length && !exclude.length) {
    return undefined;
  }
  return { include, exclude };
}

const artifactPolicySchema = {
  type: 'object',
  properties: {
    include: {
      type: 'array',
      items: { type: 'string' },
    },
    exclude: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  additionalProperties: false,
};

const dependencyArtifactsSchema = {
  oneOf: [
    { type: 'boolean' },
    {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        prefix: { type: 'string' },
        include: {
          type: 'array',
          items: { type: 'string' },
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      additionalProperties: false,
    },
  ],
};

const taskSubmitProperties = {
  title: { type: 'string' },
  type: { type: 'string', enum: ['shell', 'agent'] },
  command: { type: 'string' },
  prompt: { type: 'string' },
  workerId: { type: 'string' },
  sessionId: { type: 'string' },
  inputFiles: {
    type: 'array',
    items: {
      type: 'object',
      required: ['path', 'contentBase64'],
      properties: {
        path: { type: 'string' },
        contentBase64: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  capabilities: {
    type: 'array',
    items: { type: 'string' },
  },
  tools: {
    type: 'array',
    items: { type: 'string' },
  },
  labels: {
    type: 'object',
    additionalProperties: { type: 'string' },
  },
  env: {
    type: 'object',
    additionalProperties: { type: 'string' },
  },
  artifactPolicy: artifactPolicySchema,
  dependencyArtifacts: dependencyArtifactsSchema,
  sandboxProfile: { type: 'string', enum: ['default', 'isolated'] },
  sandbox: {
    oneOf: [
      { type: 'boolean' },
      { type: 'string', enum: ['default', 'isolated'] },
    ],
  },
  slots: { type: 'number' },
  priority: { type: 'number' },
  keepWorkspace: { type: 'boolean' },
  requireRoutable: { type: 'boolean' },
  timeoutMs: { type: 'number' },
};

const batchDefaultsProperties = {
  type: { type: 'string', enum: ['shell', 'agent'] },
  workerId: { type: 'string' },
  sessionId: { type: 'string' },
  capabilities: {
    type: 'array',
    items: { type: 'string' },
  },
  tools: {
    type: 'array',
    items: { type: 'string' },
  },
  labels: {
    type: 'object',
    additionalProperties: { type: 'string' },
  },
  env: {
    type: 'object',
    additionalProperties: { type: 'string' },
  },
  artifactPolicy: artifactPolicySchema,
  dependencyArtifacts: dependencyArtifactsSchema,
  sandboxProfile: { type: 'string', enum: ['default', 'isolated'] },
  sandbox: {
    oneOf: [
      { type: 'boolean' },
      { type: 'string', enum: ['default', 'isolated'] },
    ],
  },
  slots: { type: 'number' },
  priority: { type: 'number' },
  keepWorkspace: { type: 'boolean' },
  timeoutMs: { type: 'number' },
  requireRoutable: { type: 'boolean' },
  maxOutputChars: { type: 'number' },
  inputFiles: {
    type: 'array',
    items: {
      type: 'object',
      required: ['path', 'contentBase64'],
      properties: {
        path: { type: 'string' },
        contentBase64: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
};

const batchTaskProperties = {
  key: { type: 'string' },
  dependsOn: {
    type: 'array',
    items: { type: 'string' },
  },
  title: { type: 'string' },
  type: { type: 'string', enum: ['shell', 'agent'] },
  command: { type: 'string' },
  prompt: { type: 'string' },
  workerId: { type: 'string' },
  sessionId: { type: 'string' },
  capabilities: {
    type: 'array',
    items: { type: 'string' },
  },
  tools: {
    type: 'array',
    items: { type: 'string' },
  },
  labels: {
    type: 'object',
    additionalProperties: { type: 'string' },
  },
  env: {
    type: 'object',
    additionalProperties: { type: 'string' },
  },
  artifactPolicy: artifactPolicySchema,
  dependencyArtifacts: dependencyArtifactsSchema,
  sandboxProfile: { type: 'string', enum: ['default', 'isolated'] },
  sandbox: {
    oneOf: [
      { type: 'boolean' },
      { type: 'string', enum: ['default', 'isolated'] },
    ],
  },
  slots: { type: 'number' },
  priority: { type: 'number' },
  keepWorkspace: { type: 'boolean' },
  maxOutputChars: { type: 'number' },
  inputFiles: {
    type: 'array',
    items: {
      type: 'object',
      required: ['path', 'contentBase64'],
      properties: {
        path: { type: 'string' },
        contentBase64: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  timeoutMs: { type: 'number' },
  requireRoutable: { type: 'boolean' },
};

const batchSubmitProperties = {
  title: { type: 'string' },
  defaults: {
    type: 'object',
    properties: batchDefaultsProperties,
    additionalProperties: false,
  },
  tasks: {
    type: 'array',
    items: {
      type: 'object',
      required: ['title'],
      properties: batchTaskProperties,
      additionalProperties: false,
    },
  },
  requireRoutable: { type: 'boolean' },
};

function mapMcpTaskInput(input = {}) {
  const mapped = { ...input };
  if (input.capabilities !== undefined) {
    mapped.requiredCapabilities = Array.isArray(input.capabilities)
      ? input.capabilities
      : parseCsvValues([input.capabilities || '']);
    delete mapped.capabilities;
  }
  if (input.labels !== undefined || input.requiredLabels !== undefined) {
    mapped.requiredLabels = labelsFromObject(input.labels || input.requiredLabels);
    delete mapped.labels;
  }
  if (input.env !== undefined) {
    mapped.env = envFromObject(input.env);
  }
  if (input.tools !== undefined || input.requiredTools !== undefined) {
    mapped.requiredTools = toolsFromValue(input.tools || input.requiredTools);
    delete mapped.tools;
  }
  if (input.artifactPolicy !== undefined) {
    mapped.artifactPolicy = artifactPolicyFromObject(input.artifactPolicy);
  }
  if (input.dependencyArtifacts !== undefined) {
    mapped.dependencyArtifacts = input.dependencyArtifacts;
  }
  if (input.sandbox !== undefined && input.sandboxProfile === undefined) {
    mapped.sandboxProfile = input.sandbox === true ? 'isolated' : input.sandbox;
    delete mapped.sandbox;
  }
  return mapped;
}

const toolSchemas = [
  {
    name: 'nado_list_workers',
    description: 'List gateway workers, including admin state, observed state, active/offline state, capabilities, capacity slots, and current tasks.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'nado_worker_preflight',
    description: 'Verify control reachability and token binding for a specific worker ID before starting that worker on a remote host.',
    inputSchema: {
      type: 'object',
      required: ['workerId'],
      properties: {
        workerId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_list_worker_events',
    description: 'List worker runtime events and logs, including registration, claims, completions, worker errors, and management command acknowledgements.',
    inputSchema: {
      type: 'object',
      required: ['workerId'],
      properties: {
        workerId: { type: 'string' },
        tail: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_status',
    description: 'Return one gateway status snapshot with workers, sessions, tasks, and batch aggregate counts plus current items.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'nado_network',
    description: 'Return Control URL network diagnostics for remote worker onboarding, including IPv4/IPv6 candidates, public URL configuration, and the next recommended operator action.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'nado_capabilities',
    description: 'Return the machine-readable gateway capability manifest, including supported surfaces, feature flags, endpoint templates, worker summaries, and session summaries.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'nado_doctor',
    description: 'Run gateway diagnostics, optionally submitting shell and agent self-test tasks to verify worker claim, execution, artifact return, and terminal-agent command readiness.',
    inputSchema: {
      type: 'object',
      properties: {
        selfTest: { type: 'boolean' },
        agentSelfTest: { type: 'boolean' },
        allWorkers: { type: 'boolean' },
        workerId: { type: 'string' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
        },
        slots: { type: 'number' },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        timeoutMs: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_verify',
    description: 'Run end-to-end gateway readiness verification: health, status, manifest, agent context, MCP config, doctor self-test, task artifact download, task events, and batch ZIP download.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string' },
        allWorkers: { type: 'boolean' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        timeoutMs: { type: 'number' },
        skipDoctor: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_demo_health',
    description: 'Return one operator-oriented live demo health summary with Dashboard URL, network diagnostics, worker inventory, automatic GPU/docs/PPT route checks, optional readiness verification, and optional diagnostic history cleanup.',
    inputSchema: {
      type: 'object',
      properties: {
        skipVerify: { type: 'boolean' },
        noPrune: { type: 'boolean' },
        timeoutMs: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_list_agent_presets',
    description: 'List supported terminal-agent presets for worker start and invite generation.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'nado_create_worker_invite',
    description: 'Generate a copy-paste worker start script for a remote Ubuntu/WSL or PowerShell host.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        format: { type: 'string', enum: ['bash', 'powershell'] },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        agent: { type: 'string', enum: ['codex', 'claude', 'node-copy'] },
        agentPreset: { type: 'string', enum: ['codex', 'claude', 'node-copy'] },
        agentCommand: { type: 'string' },
        maxConcurrency: { type: 'number' },
        cleanupWorkspaces: { type: 'boolean' },
        pollMs: { type: 'number' },
        dataDir: { type: 'string' },
        bundleControlUrl: { type: 'string' },
        publicControlUrl: { type: 'string' },
        issueToken: { type: 'boolean' },
        workerToken: { type: 'string' },
        tokenLabel: { type: 'string' },
        expiresAt: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_create_worker_bundle',
    description: 'Build a portable zip bundle containing the real Nado worker runtime plus start scripts for a remote Ubuntu/WSL or PowerShell host.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        agent: { type: 'string', enum: ['codex', 'claude', 'node-copy'] },
        agentPreset: { type: 'string', enum: ['codex', 'claude', 'node-copy'] },
        agentCommand: { type: 'string' },
        maxConcurrency: { type: 'number' },
        cleanupWorkspaces: { type: 'boolean' },
        pollMs: { type: 'number' },
        dataDir: { type: 'string' },
        bundleControlUrl: { type: 'string' },
        publicControlUrl: { type: 'string' },
        issueToken: { type: 'boolean' },
        workerToken: { type: 'string' },
        tokenLabel: { type: 'string' },
        expiresAt: { type: 'string' },
        includeContent: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_create_worker_bootstrap_bundle',
    description: 'Build a self-service worker zip bundle. The remote worker generates a keypair, enrolls with the control server, receives a worker-scoped token, and stores its assigned worker ID locally.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        agent: { type: 'string', enum: ['codex', 'claude', 'node-copy'] },
        agentPreset: { type: 'string', enum: ['codex', 'claude', 'node-copy'] },
        agentCommand: { type: 'string' },
        maxConcurrency: { type: 'number' },
        cleanupWorkspaces: { type: 'boolean' },
        pollMs: { type: 'number' },
        dataDir: { type: 'string' },
        bundleControlUrl: { type: 'string' },
        publicControlUrl: { type: 'string' },
        enrollmentToken: { type: 'string' },
        issueEnrollmentToken: { type: 'boolean' },
        tokenLabel: { type: 'string' },
        maxUses: { type: 'number' },
        expiresAt: { type: 'string' },
        includeContent: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_list_worker_tokens',
    description: 'List redacted worker-specific tokens issued by the control gateway.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_revoke_worker_token',
    description: 'Revoke a worker-specific token so the worker can no longer register, heartbeat, claim work, or report results with it.',
    inputSchema: {
      type: 'object',
      required: ['tokenId'],
      properties: {
        tokenId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_list_worker_enrollment_tokens',
    description: 'List redacted self-service worker enrollment tokens created for bootstrap bundles, including use counts, expiry, and revocation state.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'nado_revoke_worker_enrollment_token',
    description: 'Revoke a self-service worker enrollment token so no additional first-time worker registrations can use that bootstrap credential.',
    inputSchema: {
      type: 'object',
      required: ['tokenId'],
      properties: {
        tokenId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_prune_worker_enrollment_tokens',
    description: 'Preview or revoke unused self-service worker enrollment tokens left behind by generated bootstrap bundles. Used enrollment tokens and already revoked tokens are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_list_tasks',
    description: 'List gateway tasks and lifecycle status.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'nado_prune_system_history',
    description: 'Preview or clear completed verify/doctor system history so routine readiness probes do not bury user work. Preserves user tasks, user batches, and sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_plan_batch',
    description: 'Draft a submit-ready batch JSON plan from short task lines before submitting it.',
    inputSchema: {
      type: 'object',
      required: ['title', 'tasks'],
      properties: {
        title: { type: 'string' },
        tasks: {
          type: 'array',
          items: { type: 'string' },
        },
        type: { type: 'string', enum: ['shell', 'agent'] },
        commandTemplate: { type: 'string' },
        workerId: { type: 'string' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        slots: { type: 'number' },
        priority: { type: 'number' },
        keepWorkspace: { type: 'boolean' },
        sandboxProfile: { type: 'string', enum: ['default', 'isolated'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_submit_batch',
    description: 'Submit multiple shell or terminal-agent tasks as one durable batch.',
    inputSchema: {
      type: 'object',
      required: ['title', 'tasks'],
      properties: batchSubmitProperties,
      additionalProperties: false,
    },
  },
  {
    name: 'nado_run_batch',
    description: 'Submit a durable batch, wait for terminal aggregate status, and optionally return a batch report plus grouped artifact content in one MCP call for control-side agents.',
    inputSchema: {
      type: 'object',
      required: ['title', 'tasks'],
      properties: {
        ...batchSubmitProperties,
        waitTimeoutMs: { type: 'number' },
        includeReport: { type: 'boolean' },
        includeArtifacts: { type: 'boolean' },
        includeArtifactContent: { type: 'boolean' },
        stdoutChars: { type: 'number' },
        stderrChars: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_plan_dispatch',
    description: 'Preview how the scheduler would assign a task list or batch JSON to workers without creating tasks. Returns selected workers, scores, and candidate reasons.',
    inputSchema: {
      type: 'object',
      required: ['tasks'],
      properties: {
        title: { type: 'string' },
        defaults: { type: 'object' },
        tasks: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              { type: 'object' },
            ],
          },
        },
        type: { type: 'string', enum: ['shell', 'agent'] },
        commandTemplate: { type: 'string' },
        workerId: { type: 'string' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        slots: { type: 'number' },
        priority: { type: 'number' },
        keepWorkspace: { type: 'boolean' },
        sandboxProfile: { type: 'string', enum: ['default', 'isolated'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_list_batches',
    description: 'List durable task batches and aggregate completion counts.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'nado_get_batch',
    description: 'Get a batch, including aggregate status and child tasks.',
    inputSchema: {
      type: 'object',
      required: ['batchId'],
      properties: {
        batchId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_wait_batch',
    description: 'Wait for a durable task batch to reach a terminal aggregate state.',
    inputSchema: {
      type: 'object',
      required: ['batchId'],
      properties: {
        batchId: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_list_batch_artifacts',
    description: 'List collected artifact metadata for every child task in a batch.',
    inputSchema: {
      type: 'object',
      required: ['batchId'],
      properties: {
        batchId: { type: 'string' },
        includeSkipped: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_get_batch_artifacts',
    description: 'Fetch all stored artifacts for every child task in a batch as grouped base64 content.',
    inputSchema: {
      type: 'object',
      required: ['batchId'],
      properties: {
        batchId: { type: 'string' },
        includeSkipped: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_batch_report',
    description: 'Summarize a batch for control-side supervision, including child status, blockers, output excerpts, and artifact paths.',
    inputSchema: {
      type: 'object',
      required: ['batchId'],
      properties: {
        batchId: { type: 'string' },
        stdoutChars: { type: 'number' },
        stderrChars: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_list_batch_events',
    description: 'List a merged timeline of batch lifecycle events and child task events.',
    inputSchema: {
      type: 'object',
      required: ['batchId'],
      properties: {
        batchId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_manage_batch',
    description: 'Manage a durable task batch, including cancelling remaining work or retrying failed/cancelled child tasks.',
    inputSchema: {
      type: 'object',
      required: ['batchId', 'action'],
      properties: {
        batchId: { type: 'string' },
        action: { type: 'string', enum: ['retry_failed', 'cancel'] },
        workerId: { type: 'string' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_create_session',
    description: 'Create a long-lived gateway session that keeps related tasks on the same worker and workspace, optionally constrained by capabilities or labels.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        workerId: { type: 'string' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
        },
        slots: { type: 'number' },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_list_sessions',
    description: 'List long-lived gateway sessions and their assigned worker/current task/workspace.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'nado_get_session',
    description: 'Get a session, including task history and workspace.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_close_session',
    description: 'Close a gateway session so no new tasks can be queued into it.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_list_session_artifacts',
    description: 'List the latest stored artifact snapshot for a long-lived session.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' },
        includeSkipped: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_get_session_artifacts',
    description: 'Fetch the latest stored session artifact snapshot as base64 content.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' },
        includeSkipped: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_get_task',
    description: 'Get full task detail, including stdout, stderr, error, workspace, and events.',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_list_task_events',
    description: 'List lifecycle and stdout/stderr events recorded for a task, optionally limited to the most recent events.',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        tail: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_explain_schedule',
    description: 'Show the scheduler decision for a task, including selected worker and scored candidates.',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_manage_task',
    description: 'Cancel, requeue, or reschedule a gateway task. Requeue/reschedule can optionally target a new worker, capabilities, or labels.',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'action'],
      properties: {
        taskId: { type: 'string' },
        action: { type: 'string', enum: ['cancel', 'requeue', 'reschedule'] },
        workerId: { type: 'string' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_recover_offline_tasks',
    description: 'List or requeue tasks that are still marked running on workers that have gone offline.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'requeue'] },
        workerId: { type: 'string' },
        targetWorkerId: { type: 'string' },
        includeSessions: { type: 'boolean' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_list_artifacts',
    description: 'List files collected from a completed worker task and stored on the control gateway.',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        includeSkipped: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_get_task_artifacts',
    description: 'Fetch all stored artifacts for one task as base64 content.',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        includeSkipped: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_get_artifact',
    description: 'Fetch one collected task artifact as base64 content plus metadata.',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'artifactId'],
      properties: {
        taskId: { type: 'string' },
        artifactId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_submit_task',
    description: 'Submit a shell or terminal-agent task to a worker or to any worker matching capabilities and labels.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: taskSubmitProperties,
      additionalProperties: false,
    },
  },
  {
    name: 'nado_run_task',
    description: 'Submit a shell or terminal-agent task, wait for terminal status, and optionally return stored artifacts in one MCP call for control-side agents.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        ...taskSubmitProperties,
        waitTimeoutMs: { type: 'number' },
        includeArtifacts: { type: 'boolean' },
        includeArtifactContent: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_manage_worker',
    description: 'Pause, resume, drain, shutdown, or cancel the current task on a worker.',
    inputSchema: {
      type: 'object',
      required: ['workerId', 'action'],
      properties: {
        workerId: { type: 'string' },
        action: { type: 'string', enum: ['pause', 'resume', 'drain', 'shutdown', 'cancel_current', 'forget'] },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nado_wait_task',
    description: 'Wait for a task to reach a terminal state.',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
];

const schemaToolNames = toolSchemas.map((tool) => tool.name);
const missingCatalogTools = MCP_TOOL_NAMES.filter((name) => !schemaToolNames.includes(name));
const extraSchemaTools = schemaToolNames.filter((name) => !MCP_TOOL_NAMES.includes(name));
if (missingCatalogTools.length || extraSchemaTools.length) {
  throw new Error(`MCP tool catalog mismatch: missing=${missingCatalogTools.join(',') || '-'} extra=${extraSchemaTools.join(',') || '-'}`);
}

async function waitTask(client, taskId, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { task } = await client.getTask(taskId);
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

async function collectTaskArtifacts(client, taskId, { includeSkipped = false, includeContent = false } = {}) {
  if (!includeContent) {
    const listed = await client.listTaskArtifacts(taskId, { includeSkipped });
    const artifacts = (listed.artifacts || []).filter((artifact) => includeSkipped || !artifact.skipped);
    return { ...listed, artifacts };
  }
  return client.getTaskArtifacts(taskId, { includeSkipped });
}

function isTerminalBatch(batch) {
  return ['succeeded', 'completed_with_errors'].includes(batch.status);
}

async function waitBatch(client, batchId, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await client.getBatch(batchId);
    if (isTerminalBatch(result.batch)) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for batch ${batchId}`);
}

async function listBatchEvents(client, batchId) {
  return client.listBatchEvents(batchId);
}

async function callTool(client, name, args = {}, config = {}) {
  if (name === 'nado_list_workers') {
    return textResult(await client.listWorkers());
  }
  if (name === 'nado_worker_preflight') {
    return textResult(await client.workerPreflight(args.workerId));
  }
  if (name === 'nado_list_worker_events') {
    return textResult(await client.listWorkerEvents(args.workerId, {
      tail: args.tail,
    }));
  }
  if (name === 'nado_status') {
    return textResult(await client.status());
  }
  if (name === 'nado_network') {
    return textResult(await client.networkInfo());
  }
  if (name === 'nado_capabilities') {
    return textResult(await client.capabilities());
  }
  if (name === 'nado_doctor') {
    return textResult(await runDoctor(client, {
      selfTest: Boolean(args.selfTest),
      agentSelfTest: Boolean(args.agentSelfTest),
      allWorkers: Boolean(args.allWorkers),
      workerId: args.workerId || undefined,
      requiredCapabilities: Array.isArray(args.capabilities)
        ? args.capabilities
        : parseCsvValues([args.capabilities || '']),
      requiredTools: toolsFromValue(args.tools),
      requiredLabels: labelsFromObject(args.labels),
      timeoutMs: args.timeoutMs || 15_000,
    }));
  }
  if (name === 'nado_verify') {
    return textResult(await runVerify(client, {
      allWorkers: Boolean(args.allWorkers),
      workerId: args.workerId || undefined,
      requiredCapabilities: Array.isArray(args.capabilities)
        ? args.capabilities
        : parseCsvValues([args.capabilities || '']),
      requiredTools: toolsFromValue(args.tools),
      requiredLabels: labelsFromObject(args.labels),
      timeoutMs: args.timeoutMs || 30_000,
      skipDoctor: Boolean(args.skipDoctor),
    }));
  }
  if (name === 'nado_demo_health') {
    return textResult(await client.demoHealth({
      skipVerify: Boolean(args.skipVerify),
      noPrune: Boolean(args.noPrune),
      timeoutMs: args.timeoutMs || 60_000,
    }));
  }
  if (name === 'nado_list_agent_presets') {
    return textResult({ presets: listAgentPresets() });
  }
  if (name === 'nado_create_worker_invite') {
    const labels = args.labels && typeof args.labels === 'object'
      ? Object.entries(args.labels).map(([key, value]) => `${key}=${value}`)
      : [];
    let token = args.workerToken || config.token;
    let issued = null;
    if (args.issueToken) {
      const result = await client.createWorkerToken({
        workerId: args.id,
        label: args.tokenLabel || '',
        expiresAt: args.expiresAt || undefined,
      });
      token = result.token;
      issued = result.workerToken;
    }
    const agentOptions = resolveAgentCommand({
      agentPreset: args.agentPreset || args.agent,
      agentCommand: args.agentCommand || null,
    });
    const bundleControl = await remoteBundleControl(args, client, config.controlUrl);
    const invite = buildWorkerInvite({
      token,
      controlUrl: bundleControl.controlUrl,
      id: args.id,
      format: args.format || 'bash',
      capabilities: Array.isArray(args.capabilities) ? args.capabilities : [],
      labels,
      agentPreset: agentOptions.agentPreset,
      agentCommand: args.agentCommand || null,
      maxConcurrency: args.maxConcurrency || null,
      cleanupWorkspaces: Boolean(args.cleanupWorkspaces),
      pollMs: args.pollMs || null,
      dataDir: args.dataDir || '.nado',
    });
    return textResult(issued
      ? { workerToken: issued, invite, controlUrl: bundleControl.controlUrl, controlSource: bundleControl.source, warning: bundleControl.warning }
      : `${bundleControl.warning ? `# Warning: ${bundleControl.warning}\n` : ''}${invite}`);
  }
  if (name === 'nado_create_worker_bundle') {
    const labels = args.labels && typeof args.labels === 'object'
      ? Object.entries(args.labels).map(([key, value]) => `${key}=${value}`)
      : [];
    let token = args.workerToken || config.token;
    let issued = null;
    if (args.issueToken) {
      const result = await client.createWorkerToken({
        workerId: args.id,
        label: args.tokenLabel || '',
        expiresAt: args.expiresAt || undefined,
      });
      token = result.token;
      issued = result.workerToken;
    }
    const agentOptions = resolveAgentCommand({
      agentPreset: args.agentPreset || args.agent,
      agentCommand: args.agentCommand || null,
    });
    const bundleControl = await remoteBundleControl(args, client, config.controlUrl);
    const bundle = await buildWorkerBundle({
      token,
      controlUrl: bundleControl.controlUrl,
      id: args.id,
      capabilities: Array.isArray(args.capabilities) ? args.capabilities : [],
      labels,
      agentPreset: agentOptions.agentPreset,
      agentCommand: args.agentCommand || null,
      maxConcurrency: args.maxConcurrency || null,
      cleanupWorkspaces: Boolean(args.cleanupWorkspaces),
      pollMs: args.pollMs || null,
      dataDir: args.dataDir || '.nado',
      issuedWorkerToken: issued,
    });
    return textResult({
      workerToken: issued || null,
      manifest: bundle.manifest,
      bundleRoot: bundle.bundleRoot,
      files: bundle.files.length,
      bytes: bundle.bytes.length,
      fileName: `${bundle.bundleRoot}.zip`,
      controlUrl: bundleControl.controlUrl,
      controlSource: bundleControl.source,
      warning: bundleControl.warning,
      ...(args.includeContent === false ? {} : { contentBase64: bundle.bytes.toString('base64') }),
    });
  }
  if (name === 'nado_create_worker_bootstrap_bundle') {
    const labels = args.labels && typeof args.labels === 'object'
      ? Object.entries(args.labels).map(([key, value]) => `${key}=${value}`)
      : [];
    let enrollmentToken = args.enrollmentToken || '';
    let issued = null;
    if (args.issueEnrollmentToken !== false || !enrollmentToken) {
      const result = await client.createWorkerEnrollmentToken({
        label: args.tokenLabel || 'mcp bootstrap bundle',
        expiresAt: args.expiresAt || undefined,
        maxUses: args.maxUses || undefined,
      });
      enrollmentToken = result.token;
      issued = result.enrollmentToken;
    }
    const agentOptions = resolveAgentCommand({
      agentPreset: args.agentPreset || args.agent,
      agentCommand: args.agentCommand || null,
    });
    const bundleControl = await remoteBundleControl(args, client, config.controlUrl);
    const bundle = await buildWorkerBootstrapBundle({
      enrollmentToken,
      controlUrl: bundleControl.controlUrl,
      name: args.name || 'bootstrap',
      capabilities: Array.isArray(args.capabilities) ? args.capabilities : [],
      labels,
      agentPreset: agentOptions.agentPreset,
      agentCommand: args.agentCommand || null,
      maxConcurrency: args.maxConcurrency || null,
      cleanupWorkspaces: Boolean(args.cleanupWorkspaces),
      pollMs: args.pollMs || null,
      dataDir: args.dataDir || '.nado',
      issuedEnrollmentToken: issued,
    });
    return textResult({
      enrollmentToken: issued || null,
      manifest: bundle.manifest,
      bundleRoot: bundle.bundleRoot,
      files: bundle.files.length,
      bytes: bundle.bytes.length,
      fileName: `${bundle.bundleRoot}.zip`,
      controlUrl: bundleControl.controlUrl,
      controlSource: bundleControl.source,
      warning: bundleControl.warning,
      ...(args.includeContent === false ? {} : { contentBase64: bundle.bytes.toString('base64') }),
    });
  }
  if (name === 'nado_list_worker_tokens') {
    return textResult(await client.listWorkerTokens({ workerId: args.workerId }));
  }
  if (name === 'nado_revoke_worker_token') {
    return textResult(await client.revokeWorkerToken(args.tokenId));
  }
  if (name === 'nado_list_worker_enrollment_tokens') {
    return textResult(await client.listWorkerEnrollmentTokens());
  }
  if (name === 'nado_revoke_worker_enrollment_token') {
    return textResult(await client.revokeWorkerEnrollmentToken(args.tokenId));
  }
  if (name === 'nado_prune_worker_enrollment_tokens') {
    return textResult(args.dryRun
      ? await client.previewWorkerEnrollmentTokenPrune()
      : await client.pruneWorkerEnrollmentTokens());
  }
  if (name === 'nado_list_tasks') {
    return textResult(await client.listTasks());
  }
  if (name === 'nado_prune_system_history') {
    return textResult(args.dryRun
      ? await client.previewSystemHistoryPrune()
      : await client.pruneSystemHistory());
  }
  if (name === 'nado_plan_batch') {
    return textResult({
      batch: buildBatchPlan({
        title: args.title,
        tasks: args.tasks,
        type: args.type || 'agent',
        commandTemplate: args.commandTemplate,
        workerId: args.workerId,
        capabilities: Array.isArray(args.capabilities) ? args.capabilities : [],
        tools: toolsFromValue(args.tools),
        labels: labelsFromObject(args.labels),
        slots: args.slots,
        priority: args.priority,
        keepWorkspace: args.keepWorkspace,
        sandboxProfile: args.sandboxProfile,
      }),
    });
  }
  if (name === 'nado_plan_dispatch') {
    return textResult(await client.planDispatch(args));
  }
  if (name === 'nado_submit_batch') {
    const created = await client.createBatch(batchCreateRequestFromMcpArgs(args));
    return textResult({
      ...created,
      routing: created.tasks.map(routingSummaryFromTask),
    });
  }
  if (name === 'nado_run_batch') {
    const created = await client.createBatch(batchCreateRequestFromMcpArgs(args));
    const waited = await waitBatch(client, created.batch.id, args.waitTimeoutMs || 60_000);
    const result = {
      submittedBatch: created.batch,
      submittedTasks: created.tasks,
      batch: waited.batch,
      tasks: waited.tasks,
      routing: created.tasks.map(routingSummaryFromTask),
      finalRouting: waited.tasks.map(routingSummaryFromTask),
    };
    if (args.includeReport !== false) {
      result.report = await client.getBatchReport(created.batch.id, {
        stdoutChars: args.stdoutChars,
        stderrChars: args.stderrChars,
      });
    }
    if (args.includeArtifacts !== false) {
      result.artifacts = args.includeArtifactContent === false
        ? await client.listBatchArtifacts(created.batch.id)
        : await client.getBatchArtifacts(created.batch.id);
    }
    return textResult(result);
  }
  if (name === 'nado_list_batches') {
    return textResult(await client.listBatches());
  }
  if (name === 'nado_get_batch') {
    return textResult(await client.getBatch(args.batchId));
  }
  if (name === 'nado_wait_batch') {
    return textResult(await waitBatch(client, args.batchId, args.timeoutMs || 60_000));
  }
  if (name === 'nado_list_batch_artifacts') {
    return textResult(await client.listBatchArtifacts(args.batchId, {
      includeSkipped: Boolean(args.includeSkipped),
    }));
  }
  if (name === 'nado_get_batch_artifacts') {
    return textResult(await client.getBatchArtifacts(args.batchId, {
      includeSkipped: Boolean(args.includeSkipped),
    }));
  }
  if (name === 'nado_batch_report') {
    return textResult(await client.getBatchReport(args.batchId, {
      stdoutChars: args.stdoutChars,
      stderrChars: args.stderrChars,
    }));
  }
  if (name === 'nado_list_batch_events') {
    return textResult(await listBatchEvents(client, args.batchId));
  }
  if (name === 'nado_manage_batch') {
    const options = {
      reason: args.reason || '',
    };
    if (args.workerId !== undefined) {
      options.workerId = args.workerId;
    }
    if (args.capabilities !== undefined) {
      options.requiredCapabilities = Array.isArray(args.capabilities)
        ? args.capabilities
        : parseCsvValues([args.capabilities || '']);
    }
    if (args.tools !== undefined) {
      options.requiredTools = toolsFromValue(args.tools);
    }
    if (args.slots !== undefined) {
      options.slots = args.slots;
    }
    if (args.labels !== undefined) {
      options.requiredLabels = labelsFromObject(args.labels);
    }
    return textResult(await client.manageBatch(args.batchId, args.action, options));
  }
  if (name === 'nado_create_session') {
    const requiredCapabilities = Array.isArray(args.capabilities)
      ? args.capabilities
      : parseCsvValues([args.capabilities || '']);
    return textResult(await client.createSession({
      title: args.title,
      workerId: args.workerId,
      requiredCapabilities,
      requiredTools: toolsFromValue(args.tools),
      requiredLabels: labelsFromObject(args.labels || args.requiredLabels),
    }));
  }
  if (name === 'nado_list_sessions') {
    return textResult(await client.listSessions());
  }
  if (name === 'nado_get_session') {
    return textResult(await client.getSession(args.sessionId));
  }
  if (name === 'nado_close_session') {
    return textResult(await client.closeSession(args.sessionId));
  }
  if (name === 'nado_list_session_artifacts') {
    return textResult(await client.listSessionArtifacts(args.sessionId, {
      includeSkipped: Boolean(args.includeSkipped),
    }));
  }
  if (name === 'nado_get_session_artifacts') {
    return textResult(await client.getSessionArtifacts(args.sessionId, {
      includeSkipped: Boolean(args.includeSkipped),
    }));
  }
  if (name === 'nado_get_task') {
    return textResult(await client.getTask(args.taskId));
  }
  if (name === 'nado_list_task_events') {
    return textResult(await client.listTaskEvents(args.taskId, {
      tail: args.tail,
    }));
  }
  if (name === 'nado_explain_schedule') {
    return textResult(await client.explainSchedule(args.taskId));
  }
  if (name === 'nado_manage_task') {
    const options = {
      reason: args.reason || '',
    };
    if (args.workerId !== undefined) {
      options.workerId = args.workerId;
    }
    if (args.capabilities !== undefined) {
      options.requiredCapabilities = Array.isArray(args.capabilities)
        ? args.capabilities
        : parseCsvValues([args.capabilities || '']);
    }
    if (args.tools !== undefined) {
      options.requiredTools = toolsFromValue(args.tools);
    }
    if (args.slots !== undefined) {
      options.slots = args.slots;
    }
    if (args.labels !== undefined) {
      options.requiredLabels = labelsFromObject(args.labels);
    }
    return textResult(await client.manageTask(args.taskId, args.action, options));
  }
  if (name === 'nado_recover_offline_tasks') {
    if ((args.action || 'list') === 'list') {
      return textResult(await client.listOfflineRunningTasks(args.workerId || ''));
    }
    const options = {
      action: 'requeue',
      workerId: args.workerId || undefined,
      targetWorkerId: args.targetWorkerId || undefined,
      includeSessions: Boolean(args.includeSessions),
      reason: args.reason || '',
    };
    if (args.capabilities !== undefined) {
      options.requiredCapabilities = Array.isArray(args.capabilities)
        ? args.capabilities
        : parseCsvValues([args.capabilities || '']);
    }
    if (args.tools !== undefined) {
      options.requiredTools = toolsFromValue(args.tools);
    }
    if (args.slots !== undefined) {
      options.slots = args.slots;
    }
    if (args.labels !== undefined) {
      options.requiredLabels = labelsFromObject(args.labels);
    }
    return textResult(await client.recoverOfflineTasks(options));
  }
  if (name === 'nado_list_artifacts') {
    return textResult(await client.listTaskArtifacts(args.taskId, {
      includeSkipped: Boolean(args.includeSkipped),
    }));
  }
  if (name === 'nado_get_task_artifacts') {
    return textResult(await client.getTaskArtifacts(args.taskId, {
      includeSkipped: Boolean(args.includeSkipped),
    }));
  }
  if (name === 'nado_get_artifact') {
    return textResult(await client.getArtifact(args.taskId, args.artifactId));
  }
  if (name === 'nado_submit_task') {
    const created = await client.createTask(taskCreateRequestFromMcpArgs(args));
    return textResult({
      ...created,
      routing: routingSummaryFromTask(created.task),
    });
  }
  if (name === 'nado_run_task') {
    const created = await client.createTask(taskCreateRequestFromMcpArgs(args));
    const task = await waitTask(client, created.task.id, args.waitTimeoutMs || 60_000);
    const result = {
      submittedTask: created.task,
      task,
      routing: routingSummaryFromTask(created.task),
      finalRouting: routingSummaryFromTask(task),
    };
    if (args.includeArtifacts !== false) {
      result.artifacts = await collectTaskArtifacts(client, task.id, {
        includeContent: args.includeArtifactContent !== false,
      });
    }
    return textResult(result);
  }
  if (name === 'nado_manage_worker') {
    if (args.action === 'forget') {
      return textResult(await client.forgetWorker(args.workerId, args.reason || 'mcp forget retired worker'));
    }
    return textResult(await client.manageWorker(args.workerId, args.action, args.reason || ''));
  }
  if (name === 'nado_wait_task') {
    return textResult({ task: await waitTask(client, args.taskId, args.timeoutMs || 60_000) });
  }
  throw new Error(`Unknown tool: ${name}`);
}

function encodeMessage(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function createParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const header = buffer.slice(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        throw new Error('Missing Content-Length header');
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) {
        return;
      }
      const body = buffer.slice(bodyStart, bodyEnd).toString('utf8');
      buffer = buffer.slice(bodyEnd);
      onMessage(JSON.parse(body));
    }
  };
}

async function handleMessage(client, config, message) {
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'nado-agent-gateway',
          version: '0.1.0',
        },
      },
    };
  }
  if (message.method === 'notifications/initialized') {
    return null;
  }
  if (message.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: toolSchemas },
    };
  }
  if (message.method === 'tools/call') {
    let result;
    try {
      result = await callTool(
        client,
        message.params?.name,
        message.params?.arguments || {},
        config,
      );
    } catch (error) {
      result = toolErrorResult(error);
    }
    return {
      jsonrpc: '2.0',
      id: message.id,
      result,
    };
  }
  if (message.id === undefined) {
    return null;
  }
  return {
    jsonrpc: '2.0',
    id: message.id,
    error: {
      code: -32601,
      message: `Unknown method: ${message.method}`,
    },
  };
}

export async function startMcpServer() {
  const config = makeConfig();
  const client = makeClient(config);
  const parser = createParser(async (message) => {
    try {
      const response = await handleMessage(client, config, message);
      if (response) {
        process.stdout.write(encodeMessage(response));
      }
    } catch (error) {
      if (message.id !== undefined) {
        process.stdout.write(encodeMessage({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32000,
            message: error.message,
          },
        }));
      }
    }
  });
  process.stdin.on('data', parser);
  process.stdin.resume();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
