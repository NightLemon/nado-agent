import { sleep } from './utils.js';

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const TERMINAL_BATCH_STATUSES = new Set(['succeeded', 'completed_with_errors']);

function checkZipBytes(bytes) {
  return Buffer.isBuffer(bytes)
    && bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b;
}

async function waitForTask(client, taskId, timeoutMs) {
  const started = Date.now();
  let lastTask = null;
  while (Date.now() - started <= timeoutMs) {
    const { task } = await client.getTask(taskId);
    lastTask = task;
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      return task;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for task ${taskId}; last status=${lastTask?.status || 'unknown'}`);
}

async function waitForBatch(client, batchId, timeoutMs) {
  const started = Date.now();
  let lastBatch = null;
  while (Date.now() - started <= timeoutMs) {
    const { batch } = await client.getBatch(batchId);
    lastBatch = batch;
    if (TERMINAL_BATCH_STATUSES.has(batch.status)) {
      return batch;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for batch ${batchId}; last status=${lastBatch?.status || 'unknown'}`);
}

function routingOptions(options = {}) {
  return {
    workerId: options.workerId || undefined,
    requiredCapabilities: options.requiredCapabilities || [],
    requiredTools: options.requiredTools || [],
    requiredLabels: options.requiredLabels || {},
  };
}

function assertFeature(manifest, key) {
  if (!manifest.features?.[key]) {
    throw new Error(`capabilities manifest missing feature ${key}`);
  }
}

async function runCheck(checks, problems, name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const check = {
      name,
      ok: true,
      durationMs: Date.now() - started,
      detail: detail || {},
    };
    checks.push(check);
    return check;
  } catch (error) {
    const check = {
      name,
      ok: false,
      durationMs: Date.now() - started,
      error: error.message,
    };
    checks.push(check);
    problems.push(`${name}: ${error.message}`);
    return check;
  }
}

export async function runVerify(client, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 30_000);
  const checks = [];
  const problems = [];
  const routing = routingOptions(options);
  const artifacts = {};
  let health = null;
  let status = null;
  let capabilities = null;
  let doctor = null;
  let probeTask = null;
  let probeBatch = null;

  await runCheck(checks, problems, 'health', async () => {
    health = await client.health();
    if (!health?.ok) {
      throw new Error('control health returned not ok');
    }
    return { service: health.service || 'nado-agent' };
  });

  await runCheck(checks, problems, 'status', async () => {
    status = await client.status();
    const active = Number(status.workers?.active || 0);
    if (active < Number(options.minActiveWorkers || 1)) {
      throw new Error(`expected at least ${options.minActiveWorkers || 1} active worker, got ${active}`);
    }
    return {
      workers: status.workers?.total || 0,
      active,
      tasks: status.tasks?.total || 0,
      batches: status.batches?.total || 0,
    };
  });

  await runCheck(checks, problems, 'capabilities', async () => {
    capabilities = await client.capabilities();
    assertFeature(capabilities, 'workerDiscovery');
    assertFeature(capabilities, 'directArtifactDownload');
    assertFeature(capabilities, 'groupedArtifactZipDownload');
    assertFeature(capabilities, 'eventStreams');
    if (!capabilities.endpoints?.tasks?.artifactDownload) {
      throw new Error('task artifact download endpoint template missing');
    }
    if (!capabilities.endpoints?.tasks?.artifactsJson) {
      throw new Error('task artifact content endpoint template missing');
    }
    if (!capabilities.endpoints?.tasks?.artifactsZip) {
      throw new Error('task artifact zip endpoint template missing');
    }
    if (!capabilities.endpoints?.batches?.artifactsZip) {
      throw new Error('batch zip endpoint template missing');
    }
    return {
      workers: capabilities.workers?.length || 0,
      sessions: capabilities.sessions?.length || 0,
    };
  });

  await runCheck(checks, problems, 'agentContext', async () => {
    const context = await client.context();
    if (!context.includes('Nado Agent Control Context')) {
      throw new Error('context does not look like Nado agent context');
    }
    return { bytes: Buffer.byteLength(context, 'utf8') };
  });

  await runCheck(checks, problems, 'mcpConfig', async () => {
    const config = await client.mcpConfig({ name: 'nado-verify' });
    if (!config.mcpServers?.['nado-verify']) {
      throw new Error('MCP config missing nado-verify server');
    }
    return { server: 'nado-verify' };
  });

  if (!options.skipDoctor) {
    await runCheck(checks, problems, 'doctor', async () => {
      doctor = await client.doctor({
        selfTest: true,
        allWorkers: Boolean(options.allWorkers),
        ...routing,
        timeoutMs,
      });
      if (!doctor.ok) {
        throw new Error((doctor.problems || []).join('; ') || 'doctor failed');
      }
      return {
        selfTests: doctor.selfTests?.length || 0,
        workers: doctor.workers?.active || 0,
      };
    });
  }

  await runCheck(checks, problems, 'taskArtifact', async () => {
    const created = await client.createTask({
      title: 'nado verify raw artifact probe',
      type: 'shell',
      ...routing,
      timeoutMs,
      artifactPolicy: {
        include: ['verify-artifact.txt'],
      },
      command: 'node -e "const fs=require(\'fs\'); const worker=process.env.NADO_WORKER_ID || \'unknown\'; fs.writeFileSync(\'verify-artifact.txt\', \'verify:\' + worker); console.log(\'verify-task \' + worker)"',
    });
    const task = await waitForTask(client, created.task.id, timeoutMs);
    probeTask = task;
    if (task.status !== 'succeeded') {
      throw new Error(`probe task ended with ${task.status}`);
    }
    const artifact = (task.artifacts || []).find((item) => item.path === 'verify-artifact.txt' && !item.skipped);
    if (!artifact) {
      throw new Error('probe task did not return verify-artifact.txt');
    }
    const downloaded = await client.downloadArtifact(task.id, artifact.id);
    const text = downloaded.bytes.toString('utf8');
    if (!text.startsWith('verify:')) {
      throw new Error('raw artifact download returned unexpected content');
    }
    const content = await client.getTaskArtifacts(task.id);
    const contentArtifact = (content.artifacts || []).find((item) => item.path === 'verify-artifact.txt');
    if (!contentArtifact || !Buffer.from(contentArtifact.contentBase64 || '', 'base64').toString('utf8').startsWith('verify:')) {
      throw new Error('task artifact content endpoint returned unexpected content');
    }
    const zipped = await client.downloadTaskArtifactsZip(task.id);
    if (!checkZipBytes(zipped.bytes)) {
      throw new Error('task artifact ZIP download did not return ZIP bytes');
    }
    artifacts.task = {
      taskId: task.id,
      artifactId: artifact.id,
      path: artifact.path,
      bytes: downloaded.bytes.length,
      contentArtifacts: content.totalArtifacts,
      zipBytes: zipped.bytes.length,
      zipFileName: zipped.fileName,
    };
    return {
      taskId: task.id,
      workerId: task.assignedWorkerId || null,
      artifact: artifact.path,
      bytes: downloaded.bytes.length,
      contentArtifacts: content.totalArtifacts,
      zipBytes: zipped.bytes.length,
      zipFileName: zipped.fileName || null,
    };
  });

  await runCheck(checks, problems, 'taskEvents', async () => {
    if (!probeTask?.id) {
      throw new Error('probe task unavailable');
    }
    const { events } = await client.listTaskEvents(probeTask.id);
    if (!events?.some((event) => event.type === 'succeeded')) {
      throw new Error('probe task events missing succeeded event');
    }
    return { events: events.length };
  });

  await runCheck(checks, problems, 'batchZip', async () => {
    const created = await client.createBatch({
      title: 'nado verify batch zip probe',
      defaults: {
        ...routing,
        timeoutMs,
        artifactPolicy: {
          include: ['verify-*.txt'],
        },
      },
      tasks: [
        {
          key: 'alpha',
          title: 'nado verify alpha',
          type: 'shell',
          command: 'node -e "require(\'fs\').writeFileSync(\'verify-alpha.txt\', \'alpha:\' + process.env.NADO_WORKER_ID)"',
        },
        {
          key: 'beta',
          title: 'nado verify beta',
          type: 'shell',
          command: 'node -e "require(\'fs\').writeFileSync(\'verify-beta.txt\', \'beta:\' + process.env.NADO_WORKER_ID)"',
        },
      ],
    });
    const batch = await waitForBatch(client, created.batch.id, timeoutMs);
    probeBatch = batch;
    if (batch.status !== 'succeeded') {
      throw new Error(`probe batch ended with ${batch.status}`);
    }
    const downloaded = await client.downloadBatchArtifactsZip(batch.id);
    if (!checkZipBytes(downloaded.bytes)) {
      throw new Error('batch ZIP download did not return ZIP bytes');
    }
    artifacts.batch = {
      batchId: batch.id,
      bytes: downloaded.bytes.length,
      fileName: downloaded.fileName,
    };
    return {
      batchId: batch.id,
      completed: `${batch.completedTasks}/${batch.totalTasks}`,
      bytes: downloaded.bytes.length,
      fileName: downloaded.fileName || null,
    };
  });

  return {
    ok: problems.length === 0,
    generatedAt: new Date().toISOString(),
    checks,
    problems,
    summary: {
      health: health?.ok || false,
      workers: {
        total: status?.workers?.total || 0,
        active: status?.workers?.active || 0,
      },
      capabilities: {
        directArtifactDownload: Boolean(capabilities?.features?.directArtifactDownload),
        groupedArtifactZipDownload: Boolean(capabilities?.features?.groupedArtifactZipDownload),
        eventStreams: Boolean(capabilities?.features?.eventStreams),
      },
      doctor: doctor
        ? {
          ok: doctor.ok,
          selfTests: doctor.selfTests?.length || 0,
        }
        : null,
      taskId: probeTask?.id || null,
      batchId: probeBatch?.id || null,
      artifacts,
    },
  };
}
