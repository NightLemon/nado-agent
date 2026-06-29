import { hasLabels, isSubset } from './utils.js';
import { agentReadinessDiagnostic, gpuResourceDiagnostic } from './worker-diagnostics.js';

const ACTIVE_WINDOW_MS = 45_000;
const AGENT_SELF_TEST_RECENT_MS = 24 * 60 * 60 * 1000;
const PRESERVE_GPU_CAPACITY_PENALTY = 30;
const GPU_PROBE_DETECTED_BONUS = 15;
const GPU_ADVERTISED_ONLY_PENALTY = 5;
const REAL_TERMINAL_AGENT_BONUS = 20;
const DEMO_ECHO_AGENT_PENALTY = 20;

function active(worker) {
  const lastSeen = worker.lastSeenAt ? Date.parse(worker.lastSeenAt) : 0;
  return Boolean(lastSeen && Date.now() - lastSeen <= ACTIVE_WINDOW_MS);
}

export function normalizeToolName(toolName) {
  const value = String(toolName || '').trim();
  const normalized = value.toLowerCase().replaceAll('_', '-');
  if (normalized === 'github' || normalized === 'github-cli') {
    return 'gh';
  }
  if (normalized === 'nvidia-smi' || normalized === 'nvidia') {
    return 'nvidiaSmi';
  }
  if (normalized === 'rocm-smi' || normalized === 'rocm') {
    return 'rocmSmi';
  }
  return normalized;
}

function uniqueTools(values = []) {
  return Array.from(new Set((values || []).map(normalizeToolName).filter(Boolean)));
}

const GPU_TEXT_PATTERNS = [
  { label: 'CUDA keyword', pattern: /\bcuda\b/ },
  { label: 'cuDNN keyword', pattern: /\bcudnn\b/ },
  { label: 'NVIDIA GPU probe', pattern: /\bnvidia-smi\b/ },
  { label: 'VRAM keyword', pattern: /\bvram\b/ },
  { label: 'ROCm keyword', pattern: /\brocm\b/ },
  { label: 'TensorRT keyword', pattern: /\btensorrt\b/ },
  { label: 'Stable Diffusion workload', pattern: /\bstable diffusion\b/ },
  { label: 'ComfyUI workload', pattern: /\bcomfyui\b/ },
  { label: 'Diffusers workload', pattern: /\bdiffusers\b/ },
  { label: 'ML framework with accelerator wording', pattern: /\b(pytorch|torch|tensorflow|jax|vllm|ollama|llama\.cpp).{0,48}\b(gpu|cuda|nvidia|vram)\b/ },
  { label: 'Accelerator wording with ML framework', pattern: /\b(gpu|cuda|nvidia|vram).{0,48}\b(pytorch|torch|tensorflow|jax|vllm|ollama|llama\.cpp)\b/ },
  { label: 'Chinese VRAM keyword', pattern: /显存/ },
  { label: 'GPU execution verb', pattern: /(run|train|fine-tune|finetune|inference|infer|serve|render|generate|benchmark|profile).{0,80}\b(gpu|cuda|nvidia|vram|rocm)\b/ },
  { label: 'GPU keyword with execution verb', pattern: /\b(gpu|cuda|nvidia|vram|rocm)\b.{0,80}(run|train|fine-tune|finetune|inference|infer|serve|render|generate|benchmark|profile)/ },
  { label: 'Chinese GPU execution wording', pattern: /(运行|训练|微调|推理|部署|渲染|生成|压测|基准测试).{0,80}(显卡|显存|cuda|gpu|英伟达)/ },
  { label: 'Chinese GPU keyword with execution wording', pattern: /(显卡|显存|cuda|gpu|英伟达).{0,80}(运行|训练|微调|推理|部署|渲染|生成|压测|基准测试)/ },
  { label: 'Chinese model workload with GPU wording', pattern: /(模型|大模型).{0,24}(训练|微调|推理).{0,48}(显卡|显存|cuda|gpu|英伟达)/ },
  { label: 'Chinese GPU wording with model workload', pattern: /(显卡|显存|cuda|gpu|英伟达).{0,48}(模型|大模型).{0,24}(训练|微调|推理)/ },
];

const PPT_TEXT_PATTERNS = [
  { label: 'PPT keyword', pattern: /\bpptx?\b/ },
  { label: 'PowerPoint keyword', pattern: /\bpowerpoint\b/ },
  { label: 'Slide deck keyword', pattern: /\bslide deck\b/ },
  { label: 'Presentation deck keyword', pattern: /\bpresentation deck\b/ },
  { label: 'Slides creation wording', pattern: /\b(create|draft|design|generate|build|make|produce).{0,64}\b(slides|deck|presentation)\b/ },
  { label: 'Slides artifact wording', pattern: /\b(slides|deck|presentation).{0,64}\b(create|draft|design|generate|build|make|produce)\b/ },
  { label: 'Chinese PPT keyword', pattern: /ppt/ },
  { label: 'Chinese slide keyword', pattern: /幻灯片/ },
  { label: 'Chinese presentation document keyword', pattern: /演示文稿/ },
  { label: 'Chinese deck creation wording', pattern: /(制作|设计|生成|创建|撰写).{0,48}(ppt|幻灯片|演示文稿)/ },
  { label: 'Chinese deck artifact wording', pattern: /(ppt|幻灯片|演示文稿).{0,48}(制作|设计|生成|创建|撰写)/ },
];

const DOCS_TEXT_PATTERNS = [
  { label: 'Documentation keyword', pattern: /\bdocumentation\b/ },
  { label: 'Docs keyword', pattern: /\bdocs\b/ },
  { label: 'README keyword', pattern: /\breadme\b/ },
  { label: 'User guide keyword', pattern: /\buser guide\b/ },
  { label: 'Manual keyword', pattern: /\bmanual\b/ },
  { label: 'Word document artifact', pattern: /\bdocx\b|\bword document\b/ },
  { label: 'Documentation writing wording', pattern: /\b(write|draft|generate|create|update|produce).{0,64}\b(docs|documentation|readme|manual|user guide)\b/ },
  { label: 'Documentation artifact wording', pattern: /\b(docs|documentation|readme|manual|user guide).{0,64}\b(write|draft|generate|create|update|produce)\b/ },
  { label: 'Chinese docs keyword', pattern: /文档/ },
  { label: 'Chinese manual keyword', pattern: /使用手册|说明书/ },
  { label: 'Chinese documentation writing wording', pattern: /(撰写|编写|生成|创建|更新|整理).{0,48}(文档|使用手册|说明书)/ },
  { label: 'Chinese documentation artifact wording', pattern: /(文档|使用手册|说明书).{0,48}(撰写|编写|生成|创建|更新|整理)/ },
];

const CAPABILITY_INFERENCE_GROUPS = [
  { capability: 'gpu', patterns: GPU_TEXT_PATTERNS, includeCommand: true },
  { capability: 'ppt', patterns: PPT_TEXT_PATTERNS, includeCommand: false },
  { capability: 'docs', patterns: DOCS_TEXT_PATTERNS, includeCommand: false },
];

export const CAPABILITY_INFERENCE_POLICY = CAPABILITY_INFERENCE_GROUPS.map((group) => ({
  capability: group.capability,
  sources: group.includeCommand
    ? ['title', 'prompt', 'description', 'command']
    : ['title', 'prompt', 'description'],
  rules: group.patterns.map((item) => item.label),
}));

export const AGENT_READINESS_POLICY = {
  agentTasksRequireConfiguredCommand: true,
  recentSelfTestWindowMs: AGENT_SELF_TEST_RECENT_MS,
  successfulRecentSelfTestBonus: 25,
  successfulStaleSelfTestBonus: 10,
  failedSelfTestPenalty: 25,
  preferRealTerminalAgent: true,
  realTerminalAgentBonus: REAL_TERMINAL_AGENT_BONUS,
  demoEchoAgentPenalty: DEMO_ECHO_AGENT_PENALTY,
};

export const RESOURCE_PREFERENCE_POLICY = {
  preserveGpuCapacityWhenGpuNotRequired: true,
  preserveGpuCapacityPenalty: PRESERVE_GPU_CAPACITY_PENALTY,
  preferProbeDetectedGpuWhenGpuRequired: true,
  gpuProbeDetectedBonus: GPU_PROBE_DETECTED_BONUS,
  gpuAdvertisedOnlyPenalty: GPU_ADVERTISED_ONLY_PENALTY,
};

function taskSearchText(task = {}, { includeCommand = true } = {}) {
  return [
    task.title,
    includeCommand ? task.command : null,
    task.prompt,
    task.description,
  ].filter(Boolean).join('\n').toLowerCase();
}

export function inferRequiredCapabilitiesForTask(task = {}) {
  return explainRequiredCapabilityInferenceForTask(task).map((item) => item.capability);
}

function evidenceSnippet(text, index) {
  const start = Math.max(0, index - 36);
  const end = Math.min(text.length, index + 84);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`.replace(/\s+/g, ' ').trim();
}

export function explainRequiredCapabilityInferenceForTask(task = {}) {
  const reasons = [];
  for (const { capability, patterns, includeCommand } of CAPABILITY_INFERENCE_GROUPS) {
    const text = taskSearchText(task, { includeCommand });
    if (!text) {
      continue;
    }
    for (const { label, pattern } of patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) {
        reasons.push({
          capability,
          reason: label,
          evidence: evidenceSnippet(text, match.index),
        });
        break;
      }
    }
  }
  return reasons;
}

export function effectiveRequiredCapabilities(task = {}) {
  return Array.from(new Set([
    ...(task.requiredCapabilities || []),
    ...inferRequiredCapabilitiesForTask(task),
  ]));
}

export function toolAvailable(worker, toolName) {
  const normalized = normalizeToolName(toolName);
  return Boolean(worker.inventory?.tools?.[normalized]?.available);
}

export function missingRequiredTools(task, worker) {
  return uniqueTools(task.requiredTools || []).filter((tool) => !toolAvailable(worker, tool));
}

function maxConcurrencyForWorker(worker) {
  return Math.max(1, Number(worker.maxConcurrency || 1));
}

export function taskSlotCost(task) {
  const raw = Number(task?.slots ?? task?.taskSlots ?? 1);
  if (!Number.isFinite(raw)) {
    return 1;
  }
  return Math.max(1, Math.ceil(raw));
}

function runningTaskIdsForWorker(worker, tasks) {
  const ids = new Set(worker.currentTaskIds || []);
  if (worker.currentTaskId) {
    ids.add(worker.currentTaskId);
  }
  for (const task of tasks) {
    if (task.assignedWorkerId === worker.id && task.status === 'running') {
      ids.add(task.id);
    }
  }
  return [...ids];
}

function runningSlotLoadForWorker(worker, tasks) {
  const ids = new Set(runningTaskIdsForWorker(worker, tasks));
  return tasks
    .filter((task) => ids.has(task.id))
    .reduce((sum, task) => sum + taskSlotCost(task), 0);
}

function reservedTasksForWorker(tasks, workerId) {
  return tasks.filter((task) => (
    task.requestedWorkerId === workerId
    && task.status === 'queued'
  ));
}

function reservedSlotLoadForWorker(tasks, workerId) {
  return reservedTasksForWorker(tasks, workerId)
    .reduce((sum, task) => sum + taskSlotCost(task), 0);
}

function runningTasksForWorker(tasks, workerId) {
  return tasks.filter((task) => task.assignedWorkerId === workerId && task.status === 'running').length;
}

function recentFailuresForWorker(tasks, workerId) {
  const cutoff = Date.now() - 30 * 60 * 1000;
  return tasks.filter((task) => (
    task.assignedWorkerId === workerId
    && task.status === 'failed'
    && task.completedAt
    && Date.parse(task.completedAt) >= cutoff
  )).length;
}

function requiredToolsForTask(task) {
  const tools = [];
  const text = taskSearchText(task);
  if (task.type === 'agent') {
    tools.push('codex', 'claude');
  }
  if (text.includes('github') || text.includes(' gh ') || text.includes('pull request')) {
    tools.push('gh');
  }
  if (text.includes('git ')) {
    tools.push('git');
  }
  return tools;
}

export function agentReadinessForTask(task = {}, worker = {}, nowMs = Date.now()) {
  if (task.type !== 'agent') {
    return { eligible: true, score: 0, reasons: [] };
  }
  if (!worker.agentCommandConfigured) {
    return { eligible: false, score: null, reasons: ['no agent command configured'] };
  }

  const diagnostic = agentReadinessDiagnostic(worker);
  if (diagnostic.mode === 'missing-tool') {
    return {
      eligible: false,
      score: null,
      reasons: [`agent preset tool missing: ${diagnostic.expectedTool || 'unknown'}`],
    };
  }
  let score = 0;
  const reasons = [];
  if (diagnostic.realTerminalAgent) {
    score += REAL_TERMINAL_AGENT_BONUS;
    reasons.push('real terminal agent');
  } else if (diagnostic.mode === 'demo-echo') {
    score -= DEMO_ECHO_AGENT_PENALTY;
    reasons.push('demo echo agent');
  } else if (diagnostic.mode === 'custom') {
    reasons.push('custom agent command');
  }

  const selfTest = worker.diagnostics?.agentSelfTest || null;
  if (!selfTest) {
    return { eligible: true, score, reasons: [...reasons, 'agent self-test not recorded'] };
  }

  const status = String(selfTest.status || '').toLowerCase();
  const atMs = selfTest.at ? Date.parse(selfTest.at) : NaN;
  const hasValidTime = Number.isFinite(atMs);
  const recent = hasValidTime && nowMs - atMs <= AGENT_SELF_TEST_RECENT_MS;
  if (status === 'succeeded') {
    return {
      eligible: true,
      score: score + (recent
        ? AGENT_READINESS_POLICY.successfulRecentSelfTestBonus
        : AGENT_READINESS_POLICY.successfulStaleSelfTestBonus),
      reasons: [...reasons, recent ? 'agent self-test succeeded recently' : 'agent self-test succeeded but stale'],
    };
  }
  if (status) {
    return {
      eligible: true,
      score: score - AGENT_READINESS_POLICY.failedSelfTestPenalty,
      reasons: [...reasons, `agent self-test ${status}`],
    };
  }
  return { eligible: true, score, reasons: [...reasons, 'agent self-test status unknown'] };
}

export function scoreWorkerForTask({ task, worker, tasks, ignoreCurrentCapacity = false }) {
  const peerTasks = (tasks || []).filter((candidate) => candidate.id !== task.id);
  const reasons = [];
  if (!active(worker)) {
    return { eligible: false, score: null, reasons: ['worker offline'] };
  }
  if (worker.adminState !== 'enabled') {
    return { eligible: false, score: null, reasons: [`worker adminState=${worker.adminState}`] };
  }
  const explicitCapabilities = task.requiredCapabilities || [];
  const inferredCapabilities = inferRequiredCapabilitiesForTask(task);
  const requiredCapabilities = effectiveRequiredCapabilities(task);
  if (!isSubset(requiredCapabilities, worker.capabilities || [])) {
    const missing = requiredCapabilities.filter((capability) => !(worker.capabilities || []).includes(capability));
    return { eligible: false, score: null, reasons: [`missing required capabilities: ${missing.join(',')}`] };
  }
  if (!hasLabels(task.requiredLabels || {}, worker.labels || {})) {
    return { eligible: false, score: null, reasons: ['missing required labels'] };
  }
  const missingTools = missingRequiredTools(task, worker);
  if (missingTools.length) {
    return { eligible: false, score: null, reasons: [`missing required tools: ${missingTools.join(',')}`] };
  }
  const agentReadiness = agentReadinessForTask(task, worker);
  if (!agentReadiness.eligible) {
    return { eligible: false, score: null, reasons: agentReadiness.reasons };
  }

  const maxConcurrency = maxConcurrencyForWorker(worker);
  const runningIds = runningTaskIdsForWorker(worker, peerTasks);
  const reservedTasks = reservedTasksForWorker(peerTasks, worker.id);
  const runningLoad = runningSlotLoadForWorker(worker, peerTasks);
  const reservedLoad = reservedSlotLoadForWorker(peerTasks, worker.id);
  const taskSlots = taskSlotCost(task);
  const load = runningLoad + reservedLoad;
  const availableSlots = maxConcurrency - load;
  if (runningIds.length) {
    reasons.push(`running=${runningIds.length}`);
  }
  if (reservedTasks.length) {
    reasons.push(`reserved=${reservedTasks.length}`);
  }
  if (taskSlots > maxConcurrency) {
    return { eligible: false, score: null, reasons: [...reasons, `task slots ${taskSlots} exceed worker capacity ${maxConcurrency}`] };
  }
  if (availableSlots < taskSlots && !ignoreCurrentCapacity) {
    return { eligible: false, score: null, reasons: [...reasons, `capacity full ${load}/${maxConcurrency}; needs ${taskSlots}`] };
  }
  if (availableSlots < taskSlots) {
    reasons.push(`capacity full ${load}/${maxConcurrency}; will wait for ${taskSlots}`);
  }

  let score = 100;
  const failures = recentFailuresForWorker(tasks, worker.id);
  score -= load * 25;
  score -= failures * 10;
  score += availableSlots * 5;
  reasons.push(`slots=${availableSlots}/${maxConcurrency}`);
  if (taskSlots > 1) {
    reasons.push(`needs=${taskSlots}`);
  }
  if (!runningIds.length && !reservedTasks.length) {
    score += 15;
    reasons.push('idle');
  }
  for (const capability of inferredCapabilities) {
    if (!explicitCapabilities.includes(capability)) {
      reasons.push(`inferred capability: ${capability}`);
    }
  }
  if (requiredCapabilities.includes('gpu') && worker.capabilities?.includes('gpu')) {
    score += 20;
    reasons.push('gpu match');
    const gpu = gpuResourceDiagnostic(worker);
    if (gpu.detected) {
      score += GPU_PROBE_DETECTED_BONUS;
      reasons.push('gpu probe detected');
    } else if (gpu.advertised) {
      score -= GPU_ADVERTISED_ONLY_PENALTY;
      reasons.push('gpu advertised without probe');
    }
  } else if (!requiredCapabilities.includes('gpu') && worker.capabilities?.includes('gpu')) {
    score -= PRESERVE_GPU_CAPACITY_PENALTY;
    reasons.push('preserve gpu capacity');
  }
  const requiredLabelCount = Object.keys(task.requiredLabels || {}).length;
  if (requiredLabelCount) {
    score += requiredLabelCount * 5;
    reasons.push(`labels=${requiredLabelCount}`);
  }
  for (const tool of uniqueTools([...(task.requiredTools || []), ...requiredToolsForTask(task)])) {
    if (tool === 'codex' || tool === 'claude') {
      if (toolAvailable(worker, tool)) {
        score += 15;
        reasons.push(`${tool} available`);
      }
    } else if (toolAvailable(worker, tool)) {
      score += 10;
      reasons.push(`${tool} available`);
    }
  }
  if (worker.agentCommandConfigured && task.type === 'agent') {
    score += 30;
    reasons.push('agent command configured');
  }
  if (task.type === 'agent') {
    score += agentReadiness.score;
    reasons.push(...agentReadiness.reasons);
  }

  return { eligible: true, score, reasons };
}

function schedulerWarningsForWorker(task = {}, worker = {}, requiredCapabilities = []) {
  const warnings = [];
  if (requiredCapabilities.includes('gpu')) {
    const gpu = gpuResourceDiagnostic(worker);
    if (gpu.warning) {
      warnings.push({
        code: 'gpu_advertised_without_probe',
        severity: 'warning',
        workerId: worker.id,
        message: gpu.warning,
      });
    }
  }
  if (task.type === 'agent') {
    const agent = agentReadinessDiagnostic(worker);
    if (agent.warning) {
      warnings.push({
        code: agent.mode === 'demo-echo' ? 'demo_echo_agent' : 'agent_readiness_warning',
        severity: agent.status === 'self-test-failed' ? 'error' : 'warning',
        workerId: worker.id,
        message: agent.warning,
      });
    }
  }
  return warnings;
}

export function scheduleTask({ task, workers, tasks, session }) {
  const inferenceReasons = explainRequiredCapabilityInferenceForTask(task);
  const inferredCapabilities = inferenceReasons.map((item) => item.capability);
  const requiredCapabilities = effectiveRequiredCapabilities(task);
  if (task.requestedWorkerId) {
    const worker = (workers || []).find((candidate) => candidate.id === task.requestedWorkerId);
    const candidate = worker
      ? {
        workerId: worker.id,
        ...scoreWorkerForTask({ task, worker, tasks, ignoreCurrentCapacity: true }),
      }
      : {
        workerId: task.requestedWorkerId,
        eligible: false,
        score: null,
        reasons: ['target worker not found'],
      };
    return {
      workerId: candidate.eligible ? task.requestedWorkerId : null,
      reason: candidate.eligible ? 'explicit worker requested' : 'explicit worker requested; target not eligible',
      inferredCapabilities,
      inferenceReasons,
      effectiveRequiredCapabilities: requiredCapabilities,
      warnings: candidate.eligible && worker ? schedulerWarningsForWorker(task, worker, requiredCapabilities) : [],
      candidates: [candidate],
    };
  }
  if (session?.assignedWorkerId || session?.requestedWorkerId) {
    const workerId = session.assignedWorkerId || session.requestedWorkerId;
    const worker = (workers || []).find((candidate) => candidate.id === workerId);
    return {
      workerId,
      reason: 'session worker affinity',
      inferredCapabilities,
      inferenceReasons,
      effectiveRequiredCapabilities: requiredCapabilities,
      warnings: worker ? schedulerWarningsForWorker(task, worker, requiredCapabilities) : [],
      candidates: [],
    };
  }

  const candidates = workers
    .map((worker) => ({
      workerId: worker.id,
      ...scoreWorkerForTask({ task, worker, tasks }),
    }))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) {
        return a.eligible ? -1 : 1;
      }
      return (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.workerId.localeCompare(b.workerId);
    });

  const eligible = candidates.filter((candidate) => candidate.eligible);
  if (!eligible.length) {
    return {
      workerId: null,
      reason: 'no eligible worker',
      inferredCapabilities,
      inferenceReasons,
      effectiveRequiredCapabilities: requiredCapabilities,
      warnings: [],
      candidates,
    };
  }

  const selectedWorker = (workers || []).find((worker) => worker.id === eligible[0].workerId);
  return {
    workerId: eligible[0].workerId,
    reason: `scheduled by score ${eligible[0].score}`,
    inferredCapabilities,
    inferenceReasons,
    effectiveRequiredCapabilities: requiredCapabilities,
    warnings: selectedWorker ? schedulerWarningsForWorker(task, selectedWorker, requiredCapabilities) : [],
    candidates,
  };
}
