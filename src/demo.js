#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { startControlServer } from './control-server.js';
import { NadoClient } from './http-client.js';
import { startWorker } from './worker-client.js';
import { buildAgentContext, writeAgentContext } from './context.js';
import { collectLocalInputFiles } from './input-files.js';
import { formatBatchReport } from './batch-report.js';

async function waitForTask(client, taskId, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { task } = await client.getTask(taskId);
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${taskId}`);
}

async function waitForTaskWhere(client, taskId, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { task } = await client.getTask(taskId);
    if (predicate(task)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${taskId}`);
}

async function waitForWorkerWhere(client, workerId, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { worker } = await client.getWorker(workerId);
    if (predicate(worker)) {
      return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for worker ${workerId}`);
}

async function waitForBatch(client, batchId, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { batch, tasks } = await client.getBatch(batchId);
    if (batch.status === 'succeeded' || batch.status === 'completed_with_errors') {
      return { batch, tasks };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for batch ${batchId}`);
}

async function printBatchReport(client, batchId) {
  const report = await client.getBatchReport(batchId, { stdoutChars: 400, stderrChars: 400 });
  console.log(formatBatchReport(report));
}

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const root = path.resolve('.nado', `demo-${runId}`);
  const token = 'demo-token';
  const { server, store, port } = await startControlServer({
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
      id: 'demo-code',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code', 'docs'],
      labels: { zone: 'desk', role: 'builder' },
      maxConcurrency: 2,
      pollMs: 100,
      onLog: (line) => console.log(`[demo-code] ${line}`),
    }));
    workers.push(await startWorker({
      id: 'demo-gpu',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['gpu', 'code'],
      labels: { zone: 'gpu-lab', role: 'accelerator' },
      pollMs: 100,
      agentCommand: 'node -e "const fs=require(\'fs\'); const p=process.argv[1]; fs.writeFileSync(\'agent-output.md\', fs.readFileSync(p,\'utf8\'))" {promptFile}',
      onLog: (line) => console.log(`[demo-gpu] ${line}`),
    }));

    const workersList = await client.listWorkers();
    console.log('\nWorkers:');
    for (const worker of workersList.workers) {
      const labels = Object.entries(worker.labels || {}).map(([key, value]) => `${key}=${value}`).join(', ');
      console.log(`- ${worker.id}: ${worker.capabilities.join(', ')}; labels: ${labels || '-'}`);
    }

    const explicit = await client.createTask({
      title: 'write docs on demo-code',
      type: 'shell',
      workerId: 'demo-code',
      command: 'node -e "require(\'fs\').writeFileSync(\'note.md\', \'# Demo Note\\n\\nWorker: \'+process.env.NADO_WORKER_ID+\'\\n\'); console.log(\'created note.md\')"',
    });

    const gpu = await client.createTask({
      title: 'route by gpu capability',
      type: 'shell',
      requiredCapabilities: ['gpu'],
      command: 'node -e "require(\'fs\').writeFileSync(\'gpu.txt\', process.env.NADO_WORKER_ID); console.log(\'gpu worker is \'+process.env.NADO_WORKER_ID)"',
    });

    const labeled = await client.createTask({
      title: 'route by worker label',
      type: 'shell',
      requiredCapabilities: ['code'],
      requiredLabels: { zone: 'desk' },
      command: 'node -e "require(\'fs\').writeFileSync(\'label-route.txt\', process.env.NADO_WORKER_ID); console.log(\'label worker is \'+process.env.NADO_WORKER_ID)"',
    });

    const agent = await client.createTask({
      title: 'run agent command hook',
      type: 'agent',
      workerId: 'demo-gpu',
      prompt: 'This prompt was delivered through Nado to the worker agent hook.',
    });

    const results = [];
    for (const item of [explicit.task, gpu.task, labeled.task, agent.task]) {
      results.push(await waitForTask(client, item.id));
    }

    console.log('\nInput files: send control-side material to a worker');
    const inputTask = await client.createTask({
      title: 'process input file',
      type: 'shell',
      workerId: 'demo-code',
      inputFiles: [
        {
          path: 'brief.txt',
          contentBase64: Buffer.from('brief from control', 'utf8').toString('base64'),
        },
      ],
      command: 'node -e "const fs=require(\'fs\'); const value=fs.readFileSync(\'brief.txt\',\'utf8\'); fs.writeFileSync(\'brief-result.txt\', value.toUpperCase()); console.log(value)"',
    });
    results.push(await waitForTask(client, inputTask.task.id));

    console.log('\nParallel capacity: demo-code runs two independent tasks at once');
    const parallelA = await client.createTask({
      title: 'parallel capacity A',
      type: 'shell',
      workerId: 'demo-code',
      command: 'node -e "setTimeout(() => { console.log(\'parallel A done\') }, 800)"',
    });
    const parallelB = await client.createTask({
      title: 'parallel capacity B',
      type: 'shell',
      workerId: 'demo-code',
      command: 'node -e "setTimeout(() => { console.log(\'parallel B done\') }, 800)"',
    });
    await waitForTaskWhere(client, parallelA.task.id, (task) => task.status === 'running');
    await waitForTaskWhere(client, parallelB.task.id, (task) => task.status === 'running');
    const parallelWorker = await waitForWorkerWhere(
      client,
      'demo-code',
      (worker) => worker.runningTasks === 2 && worker.availableSlots === 0,
    );
    console.log(`- ${parallelWorker.id} slots=${parallelWorker.runningTasks}/${parallelWorker.maxConcurrency}`);
    results.push(await waitForTask(client, parallelA.task.id));
    results.push(await waitForTask(client, parallelB.task.id));

    console.log('\nBatch dispatch: submit multiple independent subtasks at once');
    const batchCreated = await client.createBatch({
      title: 'demo batch shards',
      tasks: [
        {
          key: 'docs',
          title: 'batch shard docs',
          type: 'shell',
          requiredCapabilities: ['docs'],
          command: 'node -e "require(\'fs\').writeFileSync(\'batch-docs.txt\', process.env.NADO_BATCH_KEY+\':\'+process.env.NADO_WORKER_ID); console.log(\'docs shard on \'+process.env.NADO_WORKER_ID)"',
        },
        {
          key: 'code',
          title: 'batch shard code',
          type: 'shell',
          requiredCapabilities: ['code'],
          command: 'node -e "require(\'fs\').writeFileSync(\'batch-code.txt\', process.env.NADO_BATCH_KEY+\':\'+process.env.NADO_WORKER_ID); console.log(\'code shard on \'+process.env.NADO_WORKER_ID)"',
        },
        {
          key: 'extra',
          title: 'batch shard any code',
          type: 'shell',
          requiredCapabilities: ['code'],
          command: 'node -e "require(\'fs\').writeFileSync(\'batch-extra.txt\', process.env.NADO_BATCH_KEY+\':\'+process.env.NADO_WORKER_ID); console.log(\'extra shard on \'+process.env.NADO_WORKER_ID)"',
        },
      ],
    });
    console.log(`- batch=${batchCreated.batch.id} tasks=${batchCreated.tasks.length}`);
    const batchDone = await waitForBatch(client, batchCreated.batch.id);
    console.log(`- batch status=${batchDone.batch.status} completed=${batchDone.batch.completedTasks}/${batchDone.batch.totalTasks}`);
    console.log('\nBatch report: one-page operator summary');
    await printBatchReport(client, batchCreated.batch.id);
    results.push(...batchDone.tasks);

    console.log('\nBatch retry: rerun only failed shards');
    const retryBatch = await client.createBatch({
      title: 'demo retry batch',
      tasks: [
        {
          title: 'retry shard succeeds',
          type: 'shell',
          workerId: 'demo-code',
          command: 'node -e "require(\'fs\').writeFileSync(\'retry-stable.txt\', \'ok\'); console.log(\'stable shard\')"',
        },
        {
          title: 'retry shard fails once',
          type: 'shell',
          workerId: 'demo-code',
          command: 'node -e "const fs=require(\'fs\'); if (!fs.existsSync(\'retry-marker.txt\')) { fs.writeFileSync(\'retry-marker.txt\', \'seen\'); process.exit(4); } fs.writeFileSync(\'retry-after-failure.txt\', \'ok\'); console.log(\'retry shard ok\')"',
        },
      ],
    });
    const retryErrored = await waitForBatch(client, retryBatch.batch.id);
    console.log(`- first attempt status=${retryErrored.batch.status}`);
    const retryResult = await client.manageBatch(retryBatch.batch.id, 'retry_failed', {
      workerId: 'demo-code',
      reason: 'demo retry failed shard',
    });
    console.log(`- retry_failed retried=${retryResult.retried.length}`);
    const retryDone = await waitForBatch(client, retryBatch.batch.id);
    console.log(`- retry batch status=${retryDone.batch.status}`);
    results.push(...retryDone.tasks);

    console.log('\nBatch DAG: keep dependent shards blocked until parents succeed');
    const dagBatch = await client.createBatch({
      title: 'demo dependency batch',
      tasks: [
        {
          key: 'prepare',
          title: 'dag prepare',
          type: 'shell',
          workerId: 'demo-code',
          command: 'node -e "setTimeout(() => { console.log(\'prepared\') }, 600)"',
        },
        {
          key: 'consume',
          dependsOn: ['prepare'],
          title: 'dag consume',
          type: 'shell',
          workerId: 'demo-code',
          command: 'node -e "console.log(\'consumed after prepare\')"',
        },
      ],
    });
    const dagInitial = await client.getBatch(dagBatch.batch.id);
    const dagBlocked = dagInitial.tasks.find((task) => task.batchKey === 'consume');
    console.log(`- child initial status=${dagBlocked.status} reason=${dagBlocked.blockedReason}`);
    const dagDone = await waitForBatch(client, dagBatch.batch.id);
    console.log(`- dag batch status=${dagDone.batch.status}`);
    results.push(...dagDone.tasks);

    console.log('\nSession: keep multi-step work on one worker/workspace');
    const { session } = await client.createSession({
      title: 'demo shared workspace',
      requiredCapabilities: ['code'],
    });
    const sessionFirst = await client.createTask({
      title: 'session step 1',
      type: 'shell',
      sessionId: session.id,
      command: 'node -e "require(\'fs\').writeFileSync(\'session-state.txt\', process.env.NADO_WORKER_ID); console.log(process.env.NADO_SESSION_ID)"',
    });
    const sessionFirstDone = await waitForTask(client, sessionFirst.task.id);
    const sessionSecond = await client.createTask({
      title: 'session step 2',
      type: 'shell',
      sessionId: session.id,
      command: 'node -e "const fs=require(\'fs\'); const state=fs.readFileSync(\'session-state.txt\',\'utf8\'); fs.writeFileSync(\'session-result.txt\', state+\':\'+process.env.NADO_WORKER_ID); console.log(state+\':\'+process.env.NADO_WORKER_ID)"',
    });
    const sessionSecondDone = await waitForTask(client, sessionSecond.task.id);
    results.push(sessionFirstDone, sessionSecondDone);
    const latestSession = (await client.getSession(session.id)).session;
    console.log(`- ${session.id} assignedWorker=${latestSession.assignedWorkerId} workspace=${latestSession.workspace}`);

    console.log('\nOffline recovery: requeue stranded work from a lost worker');
    await client.registerWorker({
      id: 'lost-demo',
      capabilities: ['code'],
      maxConcurrency: 1,
      observedState: 'idle',
    });
    const stranded = await client.createTask({
      title: 'stranded on lost worker',
      type: 'shell',
      workerId: 'lost-demo',
      command: 'node -e "require(\'fs\').writeFileSync(\'offline-recovered.txt\', process.env.NADO_WORKER_ID); console.log(\'recovered on \'+process.env.NADO_WORKER_ID)"',
    });
    await client.claimTask('lost-demo');
    store.state.workers['lost-demo'].lastSeenAt = new Date(Date.now() - 90_000).toISOString();
    await store.save();
    const offlineList = await client.listOfflineRunningTasks('lost-demo');
    console.log(`- stranded tasks=${offlineList.candidates.length}`);
    const recovered = await client.recoverOfflineTasks({
      action: 'requeue',
      workerId: 'lost-demo',
      targetWorkerId: 'demo-code',
      reason: 'demo offline recovery',
    });
    console.log(`- recovered=${recovered.recovered.length} target=demo-code`);
    results.push(await waitForTask(client, stranded.task.id));

    console.log('\nAgent session memory: second agent turn sees prior transcript');
    const agentSession = await client.createSession({
      title: 'demo agent memory',
      workerId: 'demo-gpu',
    });
    const agentMemoryFirst = await client.createTask({
      title: 'agent memory step 1',
      type: 'agent',
      sessionId: agentSession.session.id,
      prompt: 'remember this phrase: orchard-blue',
    });
    results.push(await waitForTask(client, agentMemoryFirst.task.id));
    const agentMemorySecond = await client.createTask({
      title: 'agent memory step 2',
      type: 'agent',
      sessionId: agentSession.session.id,
      prompt: 'use the prior transcript',
    });
    results.push(await waitForTask(client, agentMemorySecond.task.id));

    console.log('\nDirectory sync: send a small project into the session workspace');
    const localProject = path.join(root, 'control-project');
    await fs.mkdir(path.join(localProject, 'src'), { recursive: true });
    await fs.writeFile(path.join(localProject, 'src', 'message.txt'), 'project from control', 'utf8');
    const projectTask = await client.createTask({
      title: 'process synced project',
      type: 'shell',
      sessionId: session.id,
      inputFiles: await collectLocalInputFiles({ dirs: [localProject] }),
      command: 'node -e "const fs=require(\'fs\'); const value=fs.readFileSync(\'src/message.txt\',\'utf8\'); fs.mkdirSync(\'dist\',{recursive:true}); fs.writeFileSync(\'dist/message.txt\', value.toUpperCase()); console.log(value)"',
    });
    results.push(await waitForTask(client, projectTask.task.id));

    console.log('\nManagement: pause demo-code, reschedule queued work, then resume');
    await client.manageWorker('demo-code', 'pause', 'demo pause');
    await waitForWorkerWhere(client, 'demo-code', (worker) => worker.gatewayState === 'paused');
    const paused = await client.createTask({
      title: 'queued while paused',
      type: 'shell',
      workerId: 'demo-code',
      command: 'node -e "console.log(\'ran on \'+process.env.NADO_WORKER_ID)"',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    console.log(`- paused task status: ${(await client.getTask(paused.task.id)).task.status}`);
    const rescheduled = await client.manageTask(paused.task.id, 'reschedule', {
      reason: 'move queued task away from paused worker',
    });
    console.log(`- rescheduled requestedWorker=${rescheduled.task.requestedWorkerId} reason=${rescheduled.task.scheduler.reason}`);
    results.push(await waitForTask(client, paused.task.id));
    await client.manageWorker('demo-code', 'resume', 'demo resume');
    await waitForWorkerWhere(client, 'demo-code', (worker) => worker.gatewayState === 'idle');

    console.log('\nManagement: observe and cancel a running task');
    const longTask = await client.createTask({
      title: 'cancel running task',
      type: 'shell',
      workerId: 'demo-gpu',
      command: 'node -e "setTimeout(() => {}, 10000)"',
    });
    await waitForTaskWhere(client, longTask.task.id, (task) => task.status === 'running');
    const running = await waitForWorkerWhere(
      client,
      'demo-gpu',
      (worker) => worker.gatewayState === 'running' && worker.currentTaskId === longTask.task.id,
    );
    console.log(`- ${running.id} gatewayState=${running.gatewayState} currentTask=${running.currentTaskId}`);
    await client.manageWorker('demo-gpu', 'cancel_current', 'demo cancel');
    results.push(await waitForTask(client, longTask.task.id));

    console.log('\nResults:');
    for (const task of results) {
      console.log(`- ${task.id}: ${task.status} on ${task.assignedWorkerId}; workspace=${task.workspace}`);
      if (task.stdout.trim()) {
        console.log(`  stdout: ${task.stdout.trim()}`);
      }
      const storedArtifacts = (await client.listArtifacts(task.id)).artifacts.filter((artifact) => !artifact.skipped);
      if (storedArtifacts.length) {
        console.log(`  artifacts: ${storedArtifacts.map((artifact) => `${artifact.path} (${artifact.id})`).join(', ')}`);
      }
    }

    const context = buildAgentContext({
      controlUrl,
      workers: (await client.listWorkers()).workers,
      sessions: (await client.listSessions()).sessions,
    });
    const contextFile = path.join(root, 'AGENTS.md');
    await writeAgentContext(contextFile, context);
    console.log(`\nAgent context: ${contextFile}`);
    console.log(`Demo data: ${root}`);
  } finally {
    for (const worker of workers) {
      worker.stop();
    }
    await Promise.allSettled(workers.map((worker) => worker.done));
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
