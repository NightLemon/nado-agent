import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { buildDispatchPlan } from '../src/dispatch-plan.js';
import { NadoClient } from '../src/http-client.js';
import {
  explainRequiredCapabilityInferenceForTask,
  inferRequiredCapabilitiesForTask,
  normalizeToolName,
  scheduleTask,
} from '../src/scheduler.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-scheduler-'));
}

async function waitForTask(client, taskId, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  let lastTask = null;
  while (Date.now() - started < timeoutMs) {
    const { task } = await client.getTask(taskId);
    lastTask = task;
    if (predicate(task)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for task ${taskId}; last=${JSON.stringify(lastTask)}`);
}

test('scheduler infers GPU requirements from accelerator-specific task text', () => {
  const lastSeenAt = new Date().toISOString();
  const workers = [
    {
      id: 'cpu-worker',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code'],
      maxConcurrency: 1,
      inventory: { tools: {} },
    },
    {
      id: 'gpu-worker',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code', 'gpu'],
      maxConcurrency: 1,
      inventory: { tools: {} },
    },
  ];

  const task = {
    id: 'task-gpu',
    title: 'Run CUDA inference for a PyTorch model',
    type: 'shell',
    command: 'python infer.py',
    requiredCapabilities: ['code'],
  };

  assert.deepEqual(inferRequiredCapabilitiesForTask(task), ['gpu']);
  assert.deepEqual(explainRequiredCapabilityInferenceForTask(task), [{
    capability: 'gpu',
    reason: 'CUDA keyword',
    evidence: 'run cuda inference for a pytorch model python infer.py',
  }]);
  const scheduling = scheduleTask({ task, workers, tasks: [] });
  assert.equal(scheduling.workerId, 'gpu-worker');
  assert.deepEqual(scheduling.inferredCapabilities, ['gpu']);
  assert.equal(scheduling.inferenceReasons[0].reason, 'CUDA keyword');
  assert.deepEqual(scheduling.effectiveRequiredCapabilities, ['code', 'gpu']);
  assert.ok(scheduling.candidates.some(
    (candidate) => candidate.workerId === 'cpu-worker'
      && candidate.eligible === false
      && candidate.reasons.includes('missing required capabilities: gpu'),
  ));
  assert.ok(scheduling.candidates.some(
    (candidate) => candidate.workerId === 'gpu-worker'
      && candidate.reasons.includes('inferred capability: gpu')
      && candidate.reasons.includes('gpu match'),
  ));
});

test('scheduler does not infer GPU for ordinary code tasks', () => {
  assert.deepEqual(inferRequiredCapabilitiesForTask({
    title: 'Update dashboard copy',
    type: 'agent',
    prompt: 'Refine the task list UI and add tests.',
  }), []);
  assert.deepEqual(inferRequiredCapabilitiesForTask({
    title: 'Draft GPU market notes',
    type: 'agent',
    prompt: 'Write a short document about NVIDIA GPU industry news.',
  }), []);
});

test('scheduler infers docs and PPT requirements from authoring task text', () => {
  const lastSeenAt = new Date().toISOString();
  const workers = [
    {
      id: 'code-worker',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code'],
      maxConcurrency: 1,
      inventory: { tools: {} },
    },
    {
      id: 'docs-worker',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code', 'docs', 'ppt'],
      agentCommandConfigured: true,
      maxConcurrency: 1,
      inventory: { tools: {} },
    },
  ];

  const docsTask = {
    id: 'task-docs',
    title: 'Draft README documentation',
    type: 'agent',
    prompt: '编写项目使用文档和安装说明。',
  };
  const pptTask = {
    id: 'task-ppt',
    title: 'Design a PowerPoint deck',
    type: 'agent',
    prompt: '请生成产品演示文稿。',
  };

  assert.deepEqual(inferRequiredCapabilitiesForTask(docsTask), ['docs']);
  assert.equal(explainRequiredCapabilityInferenceForTask(docsTask)[0].capability, 'docs');
  assert.deepEqual(inferRequiredCapabilitiesForTask(pptTask), ['ppt']);
  assert.equal(explainRequiredCapabilityInferenceForTask(pptTask)[0].capability, 'ppt');

  const docsScheduling = scheduleTask({ task: docsTask, workers, tasks: [] });
  assert.equal(docsScheduling.workerId, 'docs-worker');
  assert.ok(docsScheduling.candidates.some(
    (candidate) => candidate.workerId === 'code-worker'
      && candidate.eligible === false
      && candidate.reasons.includes('missing required capabilities: docs'),
  ));
  assert.ok(docsScheduling.candidates.some(
    (candidate) => candidate.workerId === 'docs-worker'
      && candidate.reasons.includes('inferred capability: docs'),
  ));

  const pptScheduling = scheduleTask({ task: pptTask, workers, tasks: [] });
  assert.equal(pptScheduling.workerId, 'docs-worker');
  assert.ok(pptScheduling.candidates.some(
    (candidate) => candidate.workerId === 'code-worker'
      && candidate.eligible === false
      && candidate.reasons.includes('missing required capabilities: ppt'),
  ));
});

test('scheduler infers GPU requirements from Chinese model workload text', () => {
  const task = {
    title: '用 CUDA 跑大模型推理',
    type: 'agent',
    prompt: '请在有显卡的工作端运行 vLLM benchmark，并输出显存占用。',
    requiredCapabilities: ['code'],
  };

  const reasons = explainRequiredCapabilityInferenceForTask(task);
  assert.deepEqual(inferRequiredCapabilitiesForTask(task), ['gpu']);
  assert.equal(reasons[0].capability, 'gpu');
  assert.match(reasons[0].reason, /CUDA|GPU|VRAM|Chinese/);
  assert.match(reasons[0].evidence, /cuda|显卡|显存|vllm/);
});

test('scheduler prefers probe-detected GPU workers over advertised-only GPU workers', () => {
  const lastSeenAt = new Date().toISOString();
  const workers = [
    {
      id: 'advertised-gpu',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code', 'gpu'],
      maxConcurrency: 1,
      inventory: { tools: {} },
    },
    {
      id: 'probed-gpu',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code', 'gpu'],
      maxConcurrency: 1,
      inventory: { tools: { nvidiaSmi: { available: true, version: 'NVIDIA A100, 40960 MiB' } } },
    },
  ];

  const scheduling = scheduleTask({
    task: {
      id: 'task-real-gpu',
      title: 'Run CUDA inference for a PyTorch model',
      type: 'shell',
      command: 'python infer.py',
    },
    workers,
    tasks: [],
  });

  assert.equal(scheduling.workerId, 'probed-gpu');
  assert.deepEqual(scheduling.warnings, []);
  assert.ok(scheduling.candidates.some(
    (candidate) => candidate.workerId === 'probed-gpu'
      && candidate.reasons.includes('gpu probe detected'),
  ));
  assert.ok(scheduling.candidates.some(
    (candidate) => candidate.workerId === 'advertised-gpu'
      && candidate.reasons.includes('gpu advertised without probe'),
  ));
});

test('scheduler records selected worker warnings for advertised GPU and demo echo agent routes', () => {
  const lastSeenAt = new Date().toISOString();
  const scheduling = scheduleTask({
    task: {
      id: 'warn-demo-gpu',
      title: 'Run CUDA benchmark',
      type: 'agent',
      prompt: 'Run CUDA benchmark and report results.',
    },
    workers: [
      {
        id: 'demo-gpu-agent',
        adminState: 'enabled',
        lastSeenAt,
        capabilities: ['gpu', 'code'],
        maxConcurrency: 1,
        agentCommandConfigured: true,
        agentPreset: 'node-copy',
        inventory: { tools: {} },
      },
    ],
    tasks: [],
  });

  assert.equal(scheduling.workerId, 'demo-gpu-agent');
  assert.ok(scheduling.warnings.some((warning) => warning.code === 'gpu_advertised_without_probe'));
  assert.ok(scheduling.warnings.some((warning) => warning.code === 'demo_echo_agent'));
});

test('scheduler explains explicit worker targets that cannot satisfy inferred requirements', () => {
  const lastSeenAt = new Date().toISOString();
  const workers = [
    {
      id: 'cpu-worker',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code'],
      maxConcurrency: 1,
      inventory: { tools: {} },
    },
    {
      id: 'gpu-worker',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code', 'gpu'],
      maxConcurrency: 1,
      inventory: { tools: {} },
    },
  ];

  const scheduling = scheduleTask({
    task: {
      id: 'task-explicit-gpu',
      title: 'Run CUDA inference for a PyTorch model',
      type: 'shell',
      command: 'python infer.py',
      requestedWorkerId: 'cpu-worker',
      requiredCapabilities: ['code'],
    },
    workers,
    tasks: [],
  });

  assert.equal(scheduling.workerId, null);
  assert.equal(scheduling.reason, 'explicit worker requested; target not eligible');
  assert.deepEqual(scheduling.inferredCapabilities, ['gpu']);
  assert.deepEqual(scheduling.effectiveRequiredCapabilities, ['code', 'gpu']);
  assert.deepEqual(scheduling.candidates.map((candidate) => candidate.workerId), ['cpu-worker']);
  assert.equal(scheduling.candidates[0].eligible, false);
  assert.ok(scheduling.candidates[0].reasons.includes('missing required capabilities: gpu'));
});

test('scheduler requires configured agent commands and prefers recent agent self-tests', () => {
  const lastSeenAt = new Date().toISOString();
  const now = new Date().toISOString();
  const workers = [
    {
      id: 'no-agent-command',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code'],
      maxConcurrency: 1,
      inventory: { tools: {} },
    },
    {
      id: 'stale-agent',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code'],
      maxConcurrency: 1,
      agentCommandConfigured: true,
      diagnostics: {
        agentSelfTest: {
          status: 'succeeded',
          at: '2020-01-01T00:00:00.000Z',
        },
      },
      inventory: { tools: {} },
    },
    {
      id: 'ready-agent',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code'],
      maxConcurrency: 1,
      agentCommandConfigured: true,
      diagnostics: {
        agentSelfTest: {
          status: 'succeeded',
          at: now,
        },
      },
      inventory: { tools: {} },
    },
    {
      id: 'failed-agent',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code'],
      maxConcurrency: 1,
      agentCommandConfigured: true,
      diagnostics: {
        agentSelfTest: {
          status: 'failed',
          at: now,
        },
      },
      inventory: { tools: {} },
    },
  ];

  const scheduling = scheduleTask({
    task: {
      id: 'agent-readiness',
      title: 'agent route should prefer verified execution',
      type: 'agent',
      prompt: 'change code and return artifacts',
      requiredCapabilities: ['code'],
    },
    workers,
    tasks: [],
  });

  assert.equal(scheduling.workerId, 'ready-agent');
  assert.ok(scheduling.candidates.some(
    (candidate) => candidate.workerId === 'no-agent-command'
      && candidate.eligible === false
      && candidate.reasons.includes('no agent command configured'),
  ));
  assert.ok(scheduling.candidates.some(
    (candidate) => candidate.workerId === 'ready-agent'
      && candidate.eligible === true
      && candidate.reasons.includes('agent self-test succeeded recently'),
  ));
  assert.ok(scheduling.candidates.some(
    (candidate) => candidate.workerId === 'stale-agent'
      && candidate.eligible === true
      && candidate.reasons.includes('agent self-test succeeded but stale'),
  ));
  assert.ok(scheduling.candidates.some(
    (candidate) => candidate.workerId === 'failed-agent'
      && candidate.eligible === true
      && candidate.reasons.includes('agent self-test failed'),
  ));
});

test('scheduler prefers real terminal agents and rejects missing preset tools', () => {
  const lastSeenAt = new Date().toISOString();
  const workers = [
    {
      id: 'demo-echo-agent',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code'],
      maxConcurrency: 1,
      agentCommandConfigured: true,
      agentPreset: 'node-copy',
      inventory: { tools: { claude: { available: true, version: 'Claude Code' } } },
    },
    {
      id: 'real-claude-agent',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code'],
      maxConcurrency: 1,
      agentCommandConfigured: true,
      agentPreset: 'claude',
      inventory: { tools: { claude: { available: true, version: 'Claude Code' } } },
    },
    {
      id: 'missing-codex-agent',
      adminState: 'enabled',
      lastSeenAt,
      capabilities: ['code'],
      maxConcurrency: 1,
      agentCommandConfigured: true,
      agentPreset: 'codex',
      inventory: { tools: { codex: { available: false } } },
    },
  ];

  const scheduling = scheduleTask({
    task: {
      id: 'agent-real-terminal-preference',
      title: 'agent route should prefer a real terminal agent',
      type: 'agent',
      prompt: 'implement a small code change',
      requiredCapabilities: ['code'],
    },
    workers,
    tasks: [],
  });

  assert.equal(scheduling.workerId, 'real-claude-agent');
  assert.ok(scheduling.candidates.some(
    (candidate) => candidate.workerId === 'real-claude-agent'
      && candidate.eligible === true
      && candidate.reasons.includes('real terminal agent'),
  ));
  assert.ok(scheduling.candidates.some(
    (candidate) => candidate.workerId === 'demo-echo-agent'
      && candidate.eligible === true
      && candidate.reasons.includes('demo echo agent'),
  ));
  assert.ok(scheduling.candidates.some(
    (candidate) => candidate.workerId === 'missing-codex-agent'
      && candidate.eligible === false
      && candidate.reasons.includes('agent preset tool missing: codex'),
  ));
});

test('dispatch routability rejects agent workers whose preset CLI is missing', () => {
  const lastSeenAt = new Date().toISOString();
  const plan = buildDispatchPlan({
    title: 'agent missing tool routability',
    tasks: [
      {
        key: 'agent',
        title: 'agent task',
        type: 'agent',
        prompt: 'change code',
      },
    ],
  }, {
    workers: [
      {
        id: 'missing-codex-agent',
        adminState: 'enabled',
        lastSeenAt,
        capabilities: ['code'],
        maxConcurrency: 1,
        agentCommandConfigured: true,
        agentPreset: 'codex',
        inventory: { tools: { codex: { available: false } } },
      },
    ],
    tasks: [],
    sessions: [],
  });

  const item = plan.items[0];
  assert.equal(item.scheduler.workerId, null);
  assert.equal(item.routability.routable, false);
  assert.ok(item.routability.candidates[0].reasons.includes('agent preset tool missing: codex'));
  assert.equal(item.nextAction.code, 'add_worker_or_relax_constraints');
});

test('scheduler binds unassigned tasks to the best eligible worker with explanation', async () => {
  const root = await makeTempDir();
  const token = 'scheduler-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });
  const workers = [];

  try {
    workers.push(await startWorker({
      id: 'plain-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
    }));
    workers.push(await startWorker({
      id: 'agent-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      agentCommand: 'node -e "const fs=require(\'fs\'); const p=process.argv[1]; fs.writeFileSync(\'agent.txt\', fs.readFileSync(p,\'utf8\')); console.log(process.env.NADO_WORKER_ID)" {promptFile}',
      pollMs: 50,
    }));

    const agentTask = await client.createTask({
      title: 'agent should prefer configured worker',
      type: 'agent',
      prompt: 'do agent work',
      requiredCapabilities: ['code'],
    });
    assert.equal(agentTask.task.requestedWorkerId, 'agent-worker');
    assert.match(agentTask.task.scheduler.reason, /scheduled by score/);
    assert.ok(agentTask.task.scheduler.candidates.some((candidate) => candidate.workerId === 'agent-worker'));
    assert.ok(agentTask.task.scheduler.candidates.some(
      (candidate) => candidate.workerId === 'plain-worker'
        && candidate.eligible === false
        && candidate.reasons.includes('no agent command configured'),
    ));
    const explained = await client.explainSchedule(agentTask.task.id);
    assert.equal(explained.taskId, agentTask.task.id);
    assert.equal(explained.scheduler.workerId, 'agent-worker');

    const done = await waitForTask(client, agentTask.task.id, (task) => task.status === 'succeeded');
    assert.equal(done.assignedWorkerId, 'agent-worker');

    await client.manageWorker('agent-worker', 'pause', 'scheduler should avoid paused worker');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const shellTask = await client.createTask({
      title: 'shell should avoid paused worker',
      type: 'shell',
      command: 'node -e "console.log(process.env.NADO_WORKER_ID)"',
      requiredCapabilities: ['code'],
    });
    assert.equal(shellTask.task.requestedWorkerId, 'plain-worker');
    assert.ok(shellTask.task.events.some((event) => event.type === 'scheduled'));
    await waitForTask(client, shellTask.task.id, (task) => task.status === 'succeeded');

    const stuckTask = await client.createTask({
      title: 'explicit task can be rescheduled away from paused worker',
      type: 'shell',
      workerId: 'agent-worker',
      command: 'node -e "console.log(process.env.NADO_WORKER_ID)"',
      requiredCapabilities: ['code'],
    });
    assert.equal(stuckTask.task.status, 'queued');
    assert.equal(stuckTask.task.requestedWorkerId, 'agent-worker');

    const rescheduled = await client.manageTask(stuckTask.task.id, 'reschedule', {
      reason: 'paused worker should not hold queued work',
    });
    assert.equal(rescheduled.task.requestedWorkerId, 'plain-worker');
    assert.ok(rescheduled.task.events.some((event) => event.type === 'rescheduled'));
    assert.ok(rescheduled.task.scheduler.candidates.some(
      (candidate) => candidate.workerId === 'agent-worker' && candidate.eligible === false,
    ));

    const rescheduledDone = await waitForTask(client, stuckTask.task.id, (task) => task.status === 'succeeded');
    assert.equal(rescheduledDone.assignedWorkerId, 'plain-worker');
  } finally {
    for (const worker of workers) {
      worker.stop();
    }
    await Promise.allSettled(workers.map((worker) => worker.done));
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scheduler filters workers by required labels', async () => {
  const root = await makeTempDir();
  const token = 'scheduler-label-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });
  const workers = [];

  try {
    workers.push(await startWorker({
      id: 'lab-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      labels: { zone: 'lab', role: 'builder' },
      pollMs: 50,
    }));
    workers.push(await startWorker({
      id: 'office-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      labels: { zone: 'office', role: 'builder' },
      pollMs: 50,
    }));

    const routed = await client.createTask({
      title: 'label-routed task',
      type: 'shell',
      command: 'node -e "console.log(process.env.NADO_WORKER_ID)"',
      requiredCapabilities: ['code'],
      requiredLabels: { zone: 'lab' },
    });
    assert.equal(routed.task.requestedWorkerId, 'lab-worker');
    assert.equal(routed.task.requiredLabels.zone, 'lab');
    assert.ok(routed.task.scheduler.candidates.some(
      (candidate) => candidate.workerId === 'office-worker' && candidate.eligible === false && candidate.reasons.includes('missing required labels'),
    ));

    const done = await waitForTask(client, routed.task.id, (task) => task.status === 'succeeded');
    assert.equal(done.assignedWorkerId, 'lab-worker');

    const { session } = await client.createSession({
      title: 'label session',
      requiredCapabilities: ['code'],
      requiredLabels: { zone: 'office' },
    });
    const sessionTask = await client.createTask({
      title: 'session inherits labels',
      type: 'shell',
      sessionId: session.id,
      command: 'node -e "console.log(process.env.NADO_WORKER_ID)"',
    });
    assert.equal(sessionTask.task.requiredLabels.zone, 'office');
    assert.equal(sessionTask.task.requestedWorkerId, 'office-worker');
    const sessionDone = await waitForTask(client, sessionTask.task.id, (task) => task.status === 'succeeded');
    assert.equal(sessionDone.assignedWorkerId, 'office-worker');

    const impossible = await client.createTask({
      title: 'unmatched label task',
      type: 'shell',
      command: 'node -e "console.log(\'no label\')"',
      requiredCapabilities: ['code'],
      requiredLabels: { zone: 'gpu-room' },
    });
    assert.equal(impossible.task.status, 'queued');
    assert.equal(impossible.task.requestedWorkerId, null);
    assert.equal(impossible.task.scheduler.reason, 'no eligible worker');
    assert.ok(impossible.task.scheduler.candidates.every((candidate) => candidate.eligible === false));
    const snapshot = await client.status();
    assert.equal(snapshot.tasks.attention.total, 1);
    assert.equal(snapshot.tasks.attention.routingIssues, 1);
    assert.equal(snapshot.tasks.attention.items[0].id, impossible.task.id);
    assert.equal(snapshot.tasks.attention.items[0].schedulerReason, 'no eligible worker');
    assert.equal(snapshot.tasks.attention.items[0].nextAction.code, 'add_worker_or_relax_constraints');
    assert.equal(snapshot.tasks.items.find((task) => task.id === impossible.task.id).nextAction.code, 'add_worker_or_relax_constraints');
    assert.ok(snapshot.tasks.attention.items[0].candidateReasons.includes('missing required labels'));
  } finally {
    for (const worker of workers) {
      worker.stop();
    }
    await Promise.allSettled(workers.map((worker) => worker.done));
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('explicit worker tasks keep target but surface target incompatibility in schedule detail', async () => {
  const root = await makeTempDir();
  const token = 'scheduler-explicit-incompatible-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    await client.registerWorker({
      id: 'cpu-worker',
      capabilities: ['code'],
      maxConcurrency: 1,
      inventory: { tools: { node: { available: true, version: process.version } } },
    });
    await client.registerWorker({
      id: 'gpu-worker',
      capabilities: ['code', 'gpu'],
      maxConcurrency: 1,
      inventory: { tools: { node: { available: true, version: process.version } } },
    });

    const created = await client.createTask({
      title: 'Run CUDA inference for a PyTorch model',
      type: 'shell',
      workerId: 'cpu-worker',
      requiredCapabilities: ['code'],
      command: 'echo should-not-run-on-cpu',
    });

    assert.equal(created.task.requestedWorkerId, 'cpu-worker');
    assert.equal(created.task.scheduler.workerId, null);
    assert.equal(created.task.scheduler.reason, 'explicit worker requested; target not eligible');
    assert.deepEqual(created.task.scheduler.inferredCapabilities, ['gpu']);
    assert.ok(created.task.scheduler.candidates.some(
      (candidate) => candidate.workerId === 'cpu-worker'
        && candidate.eligible === false
        && candidate.reasons.includes('missing required capabilities: gpu'),
    ));

    const claimed = await client.claimTask('cpu-worker');
    assert.equal(claimed.task, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dispatch plan previews scheduler choices without creating tasks', async () => {
  const root = await makeTempDir();
  const token = 'dispatch-plan-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });
  const workers = [];

  try {
    workers.push(await startWorker({
      id: 'z-code-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      maxConcurrency: 1,
      pollMs: 50,
    }));
    workers.push(await startWorker({
      id: 'a-gpu-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code', 'gpu'],
      maxConcurrency: 1,
      pollMs: 50,
    }));

    const before = await client.status();
    assert.equal(before.tasks.total, 0);
    const { plan } = await client.planDispatch({
      title: 'dispatch preview',
      defaults: {
        capabilities: ['code'],
        slots: 1,
      },
      tasks: [
        { key: 'one', title: 'first code task', type: 'shell', command: 'echo one' },
        { key: 'two', title: 'second code task', type: 'shell', command: 'echo two' },
      ],
    });

    assert.equal(plan.totalTasks, 2);
    assert.equal(plan.counts.assigned, 2);
    assert.equal(plan.items[0].scheduler.workerId, 'z-code-worker');
    assert.equal(plan.items[1].scheduler.workerId, 'a-gpu-worker');
    assert.ok(plan.items[0].scheduler.candidates.some(
      (candidate) => candidate.workerId === 'a-gpu-worker'
        && candidate.eligible === true
        && candidate.reasons.includes('preserve gpu capacity'),
    ));
    assert.ok(plan.items[1].scheduler.candidates.some(
      (candidate) => candidate.workerId === 'z-code-worker' && candidate.eligible === false,
    ));

    const capacityPlan = await client.planDispatch({
      title: 'gpu capacity preview',
      defaults: {
        capabilities: ['gpu'],
      },
      tasks: [
        { key: 'gpu-one', title: 'first gpu task', type: 'shell', command: 'echo one' },
        { key: 'gpu-two', title: 'second gpu task', type: 'shell', command: 'echo two' },
      ],
    });
    assert.equal(capacityPlan.plan.counts.assigned, 1);
    assert.equal(capacityPlan.plan.counts.unassigned, 1);
    assert.equal(capacityPlan.plan.items[1].nextAction.code, 'wait_or_add_capacity');

    const missingCapabilityPlan = await client.planDispatch({
      title: 'missing capability preview',
      tasks: [
        { key: 'fpga', title: 'needs fpga', type: 'shell', command: 'echo fpga', requiredCapabilities: ['fpga'] },
      ],
    });
    assert.equal(missingCapabilityPlan.plan.items[0].nextAction.code, 'add_worker_or_relax_constraints');

    const after = await client.status();
    assert.equal(after.tasks.total, 0);

    await assert.rejects(
      () => client.createBatch({
        title: 'unroutable batch should be rejected',
        requireRoutable: true,
        tasks: [
          {
            key: 'missing-fpga',
            title: 'needs missing fpga',
            type: 'shell',
            command: 'echo fpga',
            requiredCapabilities: ['fpga'],
          },
        ],
      }),
      /No routable worker.*nextAction=add_worker_or_relax_constraints/,
    );
    assert.equal((await client.status()).tasks.total, 0);

    await assert.rejects(
      async () => {
        try {
          await client.createTask({
            title: 'unroutable task should be rejected',
            type: 'shell',
            command: 'echo fpga',
            requiredCapabilities: ['fpga'],
            requireRoutable: true,
          });
        } catch (error) {
          assert.equal(error.status, 409);
          assert.deepEqual(error.nextActions, ['add_worker_or_relax_constraints']);
          assert.equal(error.dispatchPlan.items[0].nextAction.code, 'add_worker_or_relax_constraints');
          throw error;
        }
      },
      /No routable worker.*nextAction=add_worker_or_relax_constraints/,
    );
    assert.equal((await client.status()).tasks.total, 0);
  } finally {
    for (const worker of workers) {
      worker.stop();
    }
    await Promise.allSettled(workers.map((worker) => worker.done));
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dispatch plan previews inferred docs and PPT capability routing', async () => {
  const root = await makeTempDir();
  const token = 'dispatch-inference-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    await client.registerWorker({
      id: 'plain-code',
      capabilities: ['code'],
      maxConcurrency: 2,
      inventory: { tools: { node: { available: true, version: process.version } } },
    });
    await client.registerWorker({
      id: 'authoring-worker',
      capabilities: ['code', 'docs', 'ppt'],
      agentCommandConfigured: true,
      maxConcurrency: 2,
      inventory: { tools: { node: { available: true, version: process.version } } },
    });

    const { plan } = await client.planDispatch({
      title: 'authoring preview',
      defaults: {
        type: 'agent',
      },
      tasks: [
        {
          key: 'docs',
          title: 'Draft README documentation',
          prompt: '编写项目使用文档。',
        },
        {
          key: 'deck',
          title: 'Design a PowerPoint deck',
          prompt: '请生成产品演示文稿。',
        },
      ],
    });

    assert.equal(plan.totalTasks, 2);
    assert.deepEqual(plan.items.map((item) => item.scheduler.workerId), ['authoring-worker', 'authoring-worker']);
    assert.deepEqual(plan.items[0].inferredCapabilities, ['docs']);
    assert.deepEqual(plan.items[0].effectiveRequiredCapabilities, ['docs']);
    assert.equal(plan.items[0].scheduler.inferenceReasons[0].capability, 'docs');
    assert.deepEqual(plan.items[1].inferredCapabilities, ['ppt']);
    assert.deepEqual(plan.items[1].effectiveRequiredCapabilities, ['ppt']);
    assert.equal(plan.items[1].scheduler.inferenceReasons[0].capability, 'ppt');
    assert.ok(plan.items[0].scheduler.candidates.some(
      (candidate) => candidate.workerId === 'plain-code'
        && candidate.eligible === false
        && candidate.reasons.includes('missing required capabilities: docs'),
    ));
    assert.ok(plan.items[1].scheduler.candidates.some(
      (candidate) => candidate.workerId === 'plain-code'
        && candidate.eligible === false
        && candidate.reasons.includes('missing required capabilities: ppt'),
    ));
    assert.equal((await client.status()).tasks.total, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scheduler filters workers by explicit required tools', async () => {
  const root = await makeTempDir();
  const token = 'scheduler-tools-token';
  const { server } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const address = server.address();
  const controlUrl = `http://127.0.0.1:${address.port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    await client.registerWorker({
      id: 'node-worker',
      capabilities: ['shell'],
      maxConcurrency: 1,
      inventory: {
        tools: {
          node: { available: true, version: process.version },
          gh: { available: false },
        },
      },
    });
    await client.registerWorker({
      id: 'gh-worker',
      capabilities: ['shell'],
      maxConcurrency: 3,
      inventory: {
        tools: {
          node: { available: true, version: process.version },
          gh: { available: true, version: 'gh test' },
        },
      },
    });

    const routed = await client.createTask({
      title: 'needs explicit github cli',
      type: 'shell',
      command: 'echo gh',
      requiredCapabilities: ['shell'],
      requiredTools: ['github'],
    });
    assert.deepEqual(routed.task.requiredTools, ['gh']);
    assert.equal(routed.task.requestedWorkerId, 'gh-worker');
    assert.ok(routed.task.scheduler.candidates.some(
      (candidate) => candidate.workerId === 'node-worker'
        && candidate.eligible === false
        && candidate.reasons.some((reason) => reason.includes('missing required tools: gh')),
    ));

    const explicitWrongWorker = await client.createTask({
      title: 'explicit worker still honors required tools at claim time',
      type: 'shell',
      workerId: 'node-worker',
      command: 'echo should-not-claim',
      requiredCapabilities: ['shell'],
      requiredTools: ['gh'],
    });
    assert.equal(explicitWrongWorker.task.requestedWorkerId, 'node-worker');
    const claimed = await client.claimTask('node-worker');
    assert.equal(claimed.task, null);

    const impossible = await client.createTask({
      title: 'missing tool task',
      type: 'shell',
      command: 'echo impossible',
      requiredCapabilities: ['shell'],
      requiredTools: ['not-a-real-tool'],
    });
    assert.equal(impossible.task.requestedWorkerId, null);
    assert.equal(impossible.task.scheduler.reason, 'no eligible worker');

    const batch = await client.createBatch({
      title: 'tool defaults batch',
      defaults: {
        requiredCapabilities: ['shell'],
        requiredTools: ['node'],
      },
      tasks: [
        {
          key: 'github',
          title: 'github child',
          tools: ['github'],
          command: 'echo child',
        },
      ],
    });
    assert.deepEqual(batch.tasks[0].requiredTools, ['node', 'gh']);
    assert.equal(batch.tasks[0].requestedWorkerId, 'gh-worker');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scheduler normalizes GPU tool aliases', () => {
  assert.equal(normalizeToolName('nvidia-smi'), 'nvidiaSmi');
  assert.equal(normalizeToolName('nvidia'), 'nvidiaSmi');
  assert.equal(normalizeToolName('rocm-smi'), 'rocmSmi');
  assert.equal(normalizeToolName('rocm'), 'rocmSmi');
});
