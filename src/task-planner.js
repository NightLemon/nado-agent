import { safeName } from './utils.js';

const MODES = new Set(['auto', 'parallel', 'pipeline', 'map_reduce', 'review']);
const DEFAULT_ARTIFACT_POLICY = {
  include: ['result.md', 'final.md', 'review.md', 'summary.md'],
  exclude: [],
};

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

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(1, Math.floor(number));
}

function cleanKey(value, fallback) {
  return safeName(String(value || fallback || 'task')).replace(/^[-_.]+|[-_.]+$/g, '') || fallback || 'task';
}

function normalizeMode(value, prompt, subtasks) {
  const requested = String(value || 'auto').trim().toLowerCase().replace(/-/g, '_');
  if (!MODES.has(requested)) {
    throw new Error(`Unknown planner mode: ${value}`);
  }
  if (requested !== 'auto') {
    return requested;
  }
  const text = `${prompt || ''} ${subtasks.map((item) => item.title).join(' ')}`.toLowerCase();
  if (/(review|compare|evaluate|audit|评审|审核|对比|复核)/.test(text)) {
    return 'review';
  }
  if (/(pipeline|step by step|phase|阶段|先.*再|依赖|流程)/.test(text)) {
    return 'pipeline';
  }
  if (subtasks.length > 1) {
    return 'map_reduce';
  }
  return 'map_reduce';
}

function parseSubtask(value, index) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      key: cleanKey(value.key || value.id, `shard_${index + 1}`),
      title: String(value.title || value.prompt || value.command || `Shard ${index + 1}`),
      prompt: String(value.prompt || value.title || `Shard ${index + 1}`),
      capabilities: list(value.capabilities || value.requiredCapabilities),
      tools: list(value.tools || value.requiredTools),
      labels: labels(value.labels || value.requiredLabels),
      workerId: value.workerId || value.worker || null,
      slots: value.slots || value.taskSlots,
    };
  }
  const text = String(value || '').trim();
  const colon = text.indexOf(':');
  if (colon > 0) {
    const key = cleanKey(text.slice(0, colon), `shard_${index + 1}`);
    const title = text.slice(colon + 1).trim() || key;
    return { key, title, prompt: title };
  }
  return {
    key: cleanKey(`shard_${index + 1}`, `shard_${index + 1}`),
    title: text || `Shard ${index + 1}`,
    prompt: text || `Shard ${index + 1}`,
  };
}

function defaultShardCount(input, workers = []) {
  if (input.shards || input.shardCount) {
    return Math.min(16, positiveInteger(input.shards || input.shardCount, 4));
  }
  const activeWorkers = workers.filter((worker) => {
    const lastSeen = worker.lastSeenAt ? Date.parse(worker.lastSeenAt) : 0;
    return worker.adminState === 'enabled' && lastSeen && Date.now() - lastSeen <= 45_000;
  });
  if (activeWorkers.length) {
    return Math.max(2, Math.min(6, activeWorkers.length));
  }
  return 4;
}

function defaultFocusAreas(prompt, count) {
  const text = String(prompt || '').toLowerCase();
  const code = /(code|implement|refactor|bug|test|api|代码|实现|重构|测试)/.test(text);
  const deploy = /(deploy|azure|vm|docker|kubernetes|production|部署|上线|生产|运维)/.test(text);
  const docs = /(doc|readme|ppt|slide|report|文档|报告|演示|幻灯片)/.test(text);
  const research = /(research|compare|survey|market|调研|分析|对比)/.test(text);
  let areas;
  if (code) {
    areas = ['architecture and interfaces', 'implementation changes', 'tests and verification', 'developer documentation'];
  } else if (deploy) {
    areas = ['infrastructure plan', 'security and networking', 'deployment commands', 'operations and rollback'];
  } else if (docs || research) {
    areas = ['source research', 'technical synthesis', 'risk and gap analysis', 'final deliverable outline'];
  } else {
    areas = ['problem framing', 'solution options', 'execution plan', 'validation and risks'];
  }
  while (areas.length < count) {
    areas.push(`workstream ${areas.length + 1}`);
  }
  return areas.slice(0, count).map((title, index) => ({
    key: cleanKey(title, `shard_${index + 1}`),
    title,
    prompt: title,
  }));
}

function normalizeSubtasks(input, workers) {
  const raw = input.subtasks || input.tasks || input.subtask || input.task || [];
  const values = Array.isArray(raw) ? raw : list(raw);
  const provided = values.map(parseSubtask);
  if (provided.length) {
    return provided;
  }
  return defaultFocusAreas(input.prompt || input.title, defaultShardCount(input, workers));
}

function defaultsFromInput(input) {
  const defaults = {
    type: input.type || 'agent',
    capabilities: list(input.capability || input.capabilities || input.requiredCapabilities),
    tools: list(input.tool || input.tools || input.requiredTools),
    labels: labels(input.label || input.labels || input.requiredLabels),
    artifactPolicy: input.artifactPolicy || DEFAULT_ARTIFACT_POLICY,
  };
  if (input.workerId || input.worker) {
    defaults.workerId = input.workerId || input.worker;
  }
  if (input.sessionId || input.session) {
    defaults.sessionId = input.sessionId || input.session;
  }
  if (input.slots || input.taskSlots) {
    defaults.slots = Number(input.slots || input.taskSlots);
  }
  if (input.priority !== undefined) {
    defaults.priority = Number(input.priority);
  }
  if (input.keepWorkspace !== undefined) {
    defaults.keepWorkspace = Boolean(input.keepWorkspace);
  }
  if (input.sandboxProfile || input.sandbox) {
    defaults.sandboxProfile = input.sandboxProfile || input.sandbox;
  }
  return defaults;
}

function workerHint(subtask) {
  return subtask.workerId ? `\nRequested worker: ${subtask.workerId}.` : '';
}

function executableFields(input, prompt, artifact = 'result.md') {
  if ((input.type || 'agent') === 'shell') {
    const script = `require('fs').writeFileSync(${JSON.stringify(artifact)}, ${JSON.stringify(prompt)})`;
    return {
      type: 'shell',
      command: `node -e ${JSON.stringify(script)}`,
    };
  }
  return {
    type: 'agent',
    prompt,
  };
}

function shardPrompt({ prompt, title, index, total, mode, subtask }) {
  return [
    `You are a Nado distributed worker handling shard ${index + 1}/${total}.`,
    `Overall task: ${prompt}`,
    `Your focus: ${title}.`,
    `Planner mode: ${mode}.${workerHint(subtask)}`,
    '',
    'Work independently. Produce concrete output, decisions, commands, code changes, risks, and evidence relevant to your focus.',
    'Write your result to result.md. Keep stdout concise and put the durable deliverable in result.md.',
  ].join('\n');
}

function reducePrompt({ prompt, mode, dependencyKeys }) {
  const dependencyList = dependencyKeys.map((key) => `- .nado/dependencies/${key}/result.md`).join('\n');
  return [
    `You are the Nado reducer for a distributed ${mode} plan.`,
    `Overall task: ${prompt}`,
    '',
    'Read every available shard result from:',
    dependencyList,
    '',
    'Synthesize a single final answer. Resolve conflicts, call out missing evidence, and preserve useful implementation details.',
    'Write the final deliverable to final.md.',
  ].join('\n');
}

function reviewPrompt({ prompt, title, index, total, subtask }) {
  return [
    `You are reviewer ${index + 1}/${total} in a Nado multi-review plan.`,
    `Overall task: ${prompt}`,
    `Review angle: ${title}.${workerHint(subtask)}`,
    '',
    'Independently analyze the task. Produce findings, recommendations, risks, and confidence notes.',
    'Write your review to review.md.',
  ].join('\n');
}

function adjudicatePrompt({ prompt, dependencyKeys }) {
  const dependencyList = dependencyKeys.map((key) => `- .nado/dependencies/${key}/review.md`).join('\n');
  return [
    'You are the Nado adjudicator for independent worker reviews.',
    `Overall task: ${prompt}`,
    '',
    'Read every available review from:',
    dependencyList,
    '',
    'Merge the strongest findings into one final recommendation. Note disagreements and decide what to do next.',
    'Write the final deliverable to final.md.',
  ].join('\n');
}

function mergeTaskOverrides(task, subtask) {
  const merged = { ...task };
  if (subtask.workerId) {
    merged.workerId = subtask.workerId;
  }
  if (subtask.capabilities?.length) {
    merged.capabilities = subtask.capabilities;
  }
  if (subtask.tools?.length) {
    merged.tools = subtask.tools;
  }
  if (subtask.labels && Object.keys(subtask.labels).length) {
    merged.labels = subtask.labels;
  }
  if (subtask.slots !== undefined) {
    merged.slots = Number(subtask.slots);
  }
  return merged;
}

function buildShardTasks(input, subtasks, mode) {
  const overall = input.prompt || input.title || 'distributed task';
  return subtasks.map((subtask, index) => {
    const prompt = shardPrompt({
      prompt: overall,
      title: subtask.prompt || subtask.title,
      index,
      total: subtasks.length,
      mode,
      subtask,
    });
    return mergeTaskOverrides({
      key: subtask.key,
      title: subtask.title,
      ...executableFields(input, prompt, 'result.md'),
      artifactPolicy: DEFAULT_ARTIFACT_POLICY,
    }, subtask);
  });
}

function buildPipelineTasks(input, subtasks) {
  const overall = input.prompt || input.title || 'pipeline task';
  return subtasks.map((subtask, index) => {
    const prompt = [
      `You are stage ${index + 1}/${subtasks.length} in a Nado pipeline.`,
      `Overall task: ${overall}`,
      `Stage focus: ${subtask.prompt || subtask.title}.${workerHint(subtask)}`,
      index > 0 ? `Use the previous stage artifacts under .nado/dependencies/${subtasks[index - 1].key}/.` : '',
      'Write your durable stage result to result.md.',
      index === subtasks.length - 1 ? 'This is the final stage; also write final.md.' : '',
    ].filter(Boolean).join('\n');
    const task = mergeTaskOverrides({
      key: subtask.key,
      title: subtask.title,
      ...(index > 0 ? { dependsOn: [subtasks[index - 1].key], dependencyArtifacts: true } : {}),
      ...executableFields(input, prompt, index === subtasks.length - 1 ? 'final.md' : 'result.md'),
      artifactPolicy: DEFAULT_ARTIFACT_POLICY,
    }, subtask);
    return task;
  });
}

function buildReviewTasks(input, subtasks) {
  const overall = input.prompt || input.title || 'review task';
  const reviewTasks = subtasks.map((subtask, index) => {
    const prompt = reviewPrompt({
      prompt: overall,
      title: subtask.prompt || subtask.title,
      index,
      total: subtasks.length,
      subtask,
    });
    return mergeTaskOverrides({
      key: subtask.key,
      title: subtask.title,
      ...executableFields(input, prompt, 'review.md'),
      artifactPolicy: DEFAULT_ARTIFACT_POLICY,
    }, subtask);
  });
  const finalPrompt = adjudicatePrompt({
    prompt: overall,
    dependencyKeys: reviewTasks.map((task) => task.key),
  });
  return [
    ...reviewTasks,
    {
      key: 'final_adjudication',
      title: 'final adjudication',
      dependsOn: reviewTasks.map((task) => task.key),
      dependencyArtifacts: true,
      ...executableFields(input, finalPrompt, 'final.md'),
      artifactPolicy: DEFAULT_ARTIFACT_POLICY,
    },
  ];
}

function buildMapReduceTasks(input, subtasks, mode) {
  const shardTasks = buildShardTasks(input, subtasks, mode);
  return [
    ...shardTasks,
    {
      key: 'final_synthesis',
      title: 'final synthesis',
      dependsOn: shardTasks.map((task) => task.key),
      dependencyArtifacts: true,
      ...executableFields(input, reducePrompt({
        prompt: input.prompt || input.title || 'distributed task',
        mode,
        dependencyKeys: shardTasks.map((task) => task.key),
      }), 'final.md'),
      artifactPolicy: DEFAULT_ARTIFACT_POLICY,
    },
  ];
}

export function buildDistributedTaskPlan(input = {}, snapshot = {}) {
  if (!input.prompt && !input.title) {
    throw new Error('Planner requires a prompt or title');
  }
  const workers = Array.isArray(snapshot.workers) ? snapshot.workers : [];
  const subtasks = normalizeSubtasks(input, workers);
  const mode = normalizeMode(input.mode, input.prompt || input.title, subtasks);
  let tasks;
  if (mode === 'pipeline') {
    tasks = buildPipelineTasks(input, subtasks);
  } else if (mode === 'parallel') {
    tasks = buildShardTasks(input, subtasks, mode);
  } else if (mode === 'review') {
    tasks = buildReviewTasks(input, subtasks);
  } else {
    tasks = buildMapReduceTasks(input, subtasks, mode);
  }
  const title = input.title || String(input.prompt || '').slice(0, 80) || 'distributed task';
  const batch = {
    title,
    defaults: defaultsFromInput(input),
    planner: {
      mode,
      generatedAt: new Date().toISOString(),
    },
    tasks,
  };
  return {
    planner: {
      title,
      mode,
      requestedMode: input.mode || 'auto',
      generatedAt: batch.planner.generatedAt,
      shardCount: subtasks.length,
      taskCount: tasks.length,
      topology: tasks.map((task) => ({
        key: task.key,
        title: task.title,
        dependsOn: task.dependsOn || [],
      })),
      strategy: mode === 'parallel'
        ? 'fan out independent worker tasks'
        : mode === 'pipeline'
          ? 'chain dependent worker stages'
          : mode === 'review'
            ? 'collect independent reviews and adjudicate'
            : 'fan out worker shards and synthesize',
      assumptions: [
        'Generated plan is deterministic; a control-side LLM can edit the batch JSON before submission.',
        'Worker selection is still handled by the normal Nado scheduler at batch creation time.',
        'Shard tasks write result.md or review.md; final tasks read dependency artifacts and write final.md.',
      ],
    },
    batch,
  };
}
