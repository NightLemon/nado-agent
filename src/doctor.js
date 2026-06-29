import { hasLabels, isSubset } from './utils.js';
import { missingRequiredTools } from './scheduler.js';

const ACTIVE_WINDOW_MS = 45_000;

function workerActive(worker) {
  const lastSeen = worker.lastSeenAt ? Date.parse(worker.lastSeenAt) : 0;
  return Boolean(lastSeen && Date.now() - lastSeen <= ACTIVE_WINDOW_MS);
}

function workerMatches(worker, options = {}) {
  if (options.workerId && worker.id !== options.workerId) {
    return false;
  }
  if (worker.adminState !== 'enabled') {
    return false;
  }
  if (!workerActive(worker)) {
    return false;
  }
  return isSubset(options.requiredCapabilities || [], worker.capabilities || [])
    && !missingRequiredTools({ requiredTools: options.requiredTools || [] }, worker).length
    && hasLabels(options.requiredLabels || {}, worker.labels || {});
}

function terminal(status) {
  return ['succeeded', 'failed', 'cancelled'].includes(status);
}

async function waitForTask(client, taskId, timeoutMs) {
  const started = Date.now();
  let lastTask = null;
  while (Date.now() - started <= timeoutMs) {
    const { task } = await client.getTask(taskId);
    lastTask = task;
    if (terminal(task.status)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const error = new Error(`Timed out waiting for doctor task ${taskId}; last status=${lastTask?.status || 'unknown'}`);
  error.task = lastTask;
  throw error;
}

async function runSelfTest(client, options = {}) {
  const created = await client.createTask({
    title: 'nado doctor self-test',
    type: 'shell',
    workerId: options.workerId || undefined,
    requiredCapabilities: options.requiredCapabilities || [],
    requiredTools: options.requiredTools || [],
    requiredLabels: options.requiredLabels || {},
    artifactPolicy: {
      include: ['doctor.txt'],
    },
    timeoutMs: Math.min(Number(options.timeoutMs || 15_000), 60_000),
    command: 'node -e "const fs=require(\'fs\'); const worker=process.env.NADO_WORKER_ID || \'unknown\'; fs.writeFileSync(\'doctor.txt\', worker); console.log(\'nado-doctor \' + worker)"',
  });
  const taskId = created.task.id;
  try {
    const task = await waitForTask(client, taskId, Number(options.timeoutMs || 15_000));
    return {
      taskId,
      status: task.status,
      workerId: task.assignedWorkerId || null,
      exitCode: task.exitCode,
      stdout: task.stdout || '',
      error: task.error || null,
      artifacts: (task.artifacts || []).map((artifact) => ({
        path: artifact.path,
        size: artifact.size,
        skipped: Boolean(artifact.skipped),
        reason: artifact.reason || null,
      })),
    };
  } catch (error) {
    await client.manageTask(taskId, 'cancel', {
      reason: 'Doctor self-test timed out',
    }).catch(() => {});
    return {
      taskId,
      status: 'timeout',
      workerId: error.task?.assignedWorkerId || null,
      exitCode: null,
      stdout: error.task?.stdout || '',
      error: error.message,
      artifacts: [],
    };
  }
}

async function runAgentSelfTest(client, options = {}) {
  const created = await client.createTask({
    title: 'nado doctor agent self-test',
    type: 'agent',
    workerId: options.workerId || undefined,
    requiredCapabilities: options.requiredCapabilities || [],
    requiredTools: options.requiredTools || [],
    requiredLabels: options.requiredLabels || {},
    artifactPolicy: {
      include: ['doctor-agent.txt', 'agent-output.md'],
    },
    timeoutMs: Math.min(Number(options.timeoutMs || 15_000), 60_000),
    prompt: [
      'Nado doctor agent self-test.',
      'Reply briefly. If you can create files, write doctor-agent.txt with the text nado-agent-ok.',
    ].join(' '),
  });
  const taskId = created.task.id;
  try {
    const task = await waitForTask(client, taskId, Number(options.timeoutMs || 15_000));
    return {
      taskId,
      status: task.status,
      workerId: task.assignedWorkerId || null,
      exitCode: task.exitCode,
      stdout: task.stdout || '',
      stderr: task.stderr || '',
      error: task.error || null,
      artifacts: (task.artifacts || []).map((artifact) => ({
        path: artifact.path,
        size: artifact.size,
        skipped: Boolean(artifact.skipped),
        reason: artifact.reason || null,
      })),
    };
  } catch (error) {
    await client.manageTask(taskId, 'cancel', {
      reason: 'Doctor agent self-test timed out',
    }).catch(() => {});
    return {
      taskId,
      status: 'timeout',
      workerId: error.task?.assignedWorkerId || null,
      exitCode: null,
      stdout: error.task?.stdout || '',
      stderr: error.task?.stderr || '',
      error: error.message,
      artifacts: [],
    };
  }
}

async function recordSelfTestEvent(client, test, type) {
  if (!test?.workerId) {
    return;
  }
  const agent = type === 'agent_self_test';
  await client.addWorkerEvent(test.workerId, {
    type,
    level: test.status === 'succeeded' ? 'info' : 'error',
    message: `${agent ? 'Agent self-test' : 'Self-test'} ${test.status} for ${test.workerId}`,
    data: {
      status: test.status,
      taskId: test.taskId,
      exitCode: test.exitCode,
      error: test.error || null,
      artifacts: (test.artifacts || []).map((artifact) => artifact.path),
    },
  }).catch(() => {});
}

export async function runDoctor(client, options = {}) {
  const problems = [];
  let health = null;
  let workers = [];
  try {
    health = await client.health();
  } catch (error) {
    problems.push(`control health failed: ${error.message}`);
  }

  if (health) {
    try {
      workers = (await client.listWorkers()).workers;
    } catch (error) {
      problems.push(`worker listing failed: ${error.message}`);
    }
  }

  if (!workers.length) {
    problems.push('no workers registered');
  }

  const unhealthy = workers.filter((worker) => !workerActive(worker) || worker.gatewayState === 'offline');
  if (unhealthy.length) {
    problems.push(`unhealthy workers: ${unhealthy.map((worker) => worker.id).join(', ')}`);
  }

  let selfTest = null;
  let selfTests = [];
  let agentSelfTest = null;
  let agentSelfTests = [];
  if (options.selfTest) {
    const eligibleWorkers = workers.filter((worker) => workerMatches(worker, options));
    if (!eligibleWorkers.length) {
      problems.push('self-test has no eligible active worker');
    } else {
      const targets = options.allWorkers ? eligibleWorkers : [eligibleWorkers[0]];
      selfTests = [];
      for (const worker of targets) {
        selfTests.push(await runSelfTest(client, {
          ...options,
          workerId: worker.id,
        }));
      }
      selfTest = selfTests[0] || null;
      for (const test of selfTests) {
        await recordSelfTestEvent(client, test, 'self_test');
        if (test.status !== 'succeeded') {
          problems.push(`self-test task ${test.taskId} ended with ${test.status}`);
        }
        if (!test.artifacts.some((artifact) => artifact.path === 'doctor.txt' && !artifact.skipped)) {
          problems.push(`self-test task ${test.taskId} did not return doctor.txt`);
        }
      }
    }
  }
  if (options.agentSelfTest) {
    const eligibleWorkers = workers
      .filter((worker) => workerMatches(worker, options))
      .filter((worker) => worker.agentCommandConfigured);
    if (!eligibleWorkers.length) {
      problems.push('agent self-test has no eligible active worker with an agent command configured');
    } else {
      const targets = options.allWorkers ? eligibleWorkers : [eligibleWorkers[0]];
      agentSelfTests = [];
      for (const worker of targets) {
        agentSelfTests.push(await runAgentSelfTest(client, {
          ...options,
          workerId: worker.id,
        }));
      }
      agentSelfTest = agentSelfTests[0] || null;
      for (const test of agentSelfTests) {
        await recordSelfTestEvent(client, test, 'agent_self_test');
        if (test.status !== 'succeeded') {
          problems.push(`agent self-test task ${test.taskId} ended with ${test.status}${test.error ? `: ${test.error}` : ''}`);
        }
      }
    }
  }

  return {
    ok: problems.length === 0,
    health: {
      ok: Boolean(health?.ok),
      service: health?.service || null,
    },
    workers: {
      total: workers.length,
      active: workers.filter(workerActive).length,
      eligibleForSelfTest: options.selfTest
        ? workers.filter((worker) => workerMatches(worker, options)).map((worker) => worker.id)
        : undefined,
      items: workers,
    },
    selfTest,
    selfTests,
    agentSelfTest,
    agentSelfTests,
    problems,
  };
}
