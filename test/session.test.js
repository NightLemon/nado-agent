import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-session-'));
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

async function waitForFile(file, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  let content = null;
  while (Date.now() - started < timeoutMs) {
    try {
      content = await fs.readFile(file, 'utf8');
      if (predicate(content)) {
        return content;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for file ${file}; last=${JSON.stringify(content)}`);
}

test('sessions keep related tasks on the same worker and workspace', async () => {
  const root = await makeTempDir();
  const token = 'session-token';
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
      id: 'session-a',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
    }));
    workers.push(await startWorker({
      id: 'session-b',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
    }));

    const { session } = await client.createSession({
      title: 'shared workspace',
      requiredCapabilities: ['code'],
    });
    assert.equal(session.status, 'open');

    const first = await client.createTask({
      title: 'initialize session state',
      type: 'shell',
      sessionId: session.id,
      command: 'node -e "require(\'fs\').writeFileSync(\'state.txt\', process.env.NADO_WORKER_ID); console.log(process.env.NADO_SESSION_ID)"',
    });
    const firstDone = await waitForTask(
      client,
      first.task.id,
      (task) => task.status === 'succeeded',
    );
    assert.equal(firstDone.sessionId, session.id);
    assert.match(firstDone.workspace.replaceAll('\\', '/'), new RegExp(`/sessions/${session.id}$`));

    const second = await client.createTask({
      title: 'reuse session state',
      type: 'shell',
      sessionId: session.id,
      command: 'node -e "const fs=require(\'fs\'); const worker=fs.readFileSync(\'state.txt\',\'utf8\'); fs.writeFileSync(\'result.txt\', worker+\':\'+process.env.NADO_WORKER_ID); console.log(worker+\':\'+process.env.NADO_WORKER_ID)"',
    });
    const secondDone = await waitForTask(
      client,
      second.task.id,
      (task) => task.status === 'succeeded',
    );

    assert.equal(secondDone.assignedWorkerId, firstDone.assignedWorkerId);
    assert.equal(secondDone.workspace, firstDone.workspace);
    assert.equal(secondDone.stdout.trim(), `${firstDone.assignedWorkerId}:${firstDone.assignedWorkerId}`);
    assert.equal(
      await fs.readFile(path.join(secondDone.workspace, 'result.txt'), 'utf8'),
      `${firstDone.assignedWorkerId}:${firstDone.assignedWorkerId}`,
    );

    const latestSession = await client.getSession(session.id);
    assert.equal(latestSession.session.assignedWorkerId, firstDone.assignedWorkerId);
    assert.deepEqual(latestSession.session.taskIds, [first.task.id, second.task.id]);
    assert.equal(latestSession.session.workspace, secondDone.workspace);

    const artifacts = await client.listArtifacts(second.task.id);
    assert.ok(artifacts.artifacts.some((artifact) => artifact.path === 'state.txt'));
    assert.ok(artifacts.artifacts.some((artifact) => artifact.path === 'result.txt'));

    const sessionArtifacts = await client.listSessionArtifacts(session.id);
    assert.equal(sessionArtifacts.sourceTaskId, second.task.id);
    assert.ok(sessionArtifacts.artifacts.some((artifact) => artifact.path === 'state.txt'));
    assert.ok(sessionArtifacts.artifacts.some((artifact) => artifact.path === 'result.txt'));

    const sessionArtifactContent = await client.getSessionArtifacts(session.id);
    const resultArtifact = sessionArtifactContent.artifacts.find((artifact) => artifact.path === 'result.txt');
    assert.ok(resultArtifact);
    assert.equal(Buffer.from(resultArtifact.contentBase64, 'base64').toString('utf8'), `${firstDone.assignedWorkerId}:${firstDone.assignedWorkerId}`);

    const sessionZip = await client.downloadSessionArtifactsZip(session.id);
    assert.match(sessionZip.contentType, /application\/zip/);
    assert.equal(sessionZip.fileName, `${session.id}-artifacts.zip`);
    assert.ok(sessionZip.bytes.includes(Buffer.from('result.txt')));
    assert.ok(sessionZip.bytes.includes(Buffer.from(`${firstDone.assignedWorkerId}:${firstDone.assignedWorkerId}`)));

    const closed = await client.closeSession(session.id);
    assert.equal(closed.session.status, 'closed');
    await assert.rejects(
      () => client.createTask({
        title: 'should not queue',
        type: 'shell',
        sessionId: session.id,
        command: 'echo nope',
      }),
      /Session is not open/,
    );
  } finally {
    for (const worker of workers) {
      worker.stop();
    }
    await Promise.allSettled(workers.map((worker) => worker.done));
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an offline session attempt automatically returns to the same Worker and reuses its workspace', async () => {
  const root = await makeTempDir();
  const token = 'session-recovery-token';
  const running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
    taskLeaseMs: 60_000,
    autoRecoverOfflineMs: 60_000,
    recoveryScanIntervalMs: 600_000,
  });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  const admin = new NadoClient({ controlUrl, token });
  const workerHttp = new NadoClient({ controlUrl, token });
  let transportBlocked = false;
  const workerClient = new Proxy(workerHttp, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') {
        return value;
      }
      return (...args) => {
        if (transportBlocked) {
          return Promise.reject(new Error('simulated home Worker control-link outage'));
        }
        return value.apply(target, args);
      };
    },
  });
  const worker = await startWorker({
    id: 'session-recovery-worker',
    controlUrl,
    token,
    client: workerClient,
    dataDir: root,
    capabilities: ['code'],
    pollMs: 25,
    longPollMs: 50,
    reconnectBaseMs: 25,
    reconnectMaxMs: 50,
    completionRetries: 50,
    completionRetryBaseMs: 25,
    completionRetryMaxMs: 50,
  });

  try {
    const { session } = await admin.createSession({
      title: 'recover session on workspace owner',
      workerId: 'session-recovery-worker',
      requiredCapabilities: ['code'],
    });
    const initialized = await admin.createTask({
      title: 'initialize recoverable session state',
      type: 'shell',
      sessionId: session.id,
      command: 'node -e "require(\'fs\').writeFileSync(\'state.txt\',process.env.NADO_WORKER_ID)"',
    });
    const initializedDone = await waitForTask(
      admin,
      initialized.task.id,
      (task) => task.status === 'succeeded',
    );

    const interrupted = await admin.createTask({
      title: 'recover interrupted session work',
      type: 'shell',
      sessionId: session.id,
      maxAttempts: 2,
      retryBackoffMs: 0,
      command: 'node -e "const fs=require(\'fs\');const f=\'attempt-count.txt\';const n=fs.existsSync(f)?Number(fs.readFileSync(f,\'utf8\'))+1:1;fs.writeFileSync(f,String(n));setTimeout(()=>{fs.writeFileSync(\'recovery-result.txt\',fs.readFileSync(\'state.txt\',\'utf8\')+\':\'+n)},2500)"',
    });
    const firstRunning = await waitForTask(
      admin,
      interrupted.task.id,
      (task) => task.status === 'running',
    );
    const firstAttemptId = firstRunning.currentAttemptId;
    await waitForFile(
      path.join(initializedDone.workspace, 'attempt-count.txt'),
      (content) => content === '1',
      40_000,
    );

    transportBlocked = true;
    const liveTask = running.store.state.tasks[interrupted.task.id];
    running.store.state.workers['session-recovery-worker'].lastSeenAt = new Date(Date.now() - 90_000).toISOString();
    liveTask.lease.expiresAt = new Date(Date.now() - 1).toISOString();
    await running.store.save();

    const recovered = await running.recoverySupervisor.run();
    assert.equal(recovered.recovered.length, 1);
    assert.equal(recovered.skipped.length, 0);
    assert.equal(recovered.recovered[0].requestedWorkerId, 'session-recovery-worker');
    assert.equal(recovered.recovered[0].status, 'queued');
    const sessionAfterRecovery = running.store.getSession(session.id);
    assert.equal(sessionAfterRecovery.assignedWorkerId, 'session-recovery-worker');
    assert.equal(sessionAfterRecovery.workspace, initializedDone.workspace);
    const waiting = await admin.getTask(interrupted.task.id);
    assert.equal(waiting.task.runtimeDiagnostics.state, 'waiting_for_session_worker');
    assert.equal(waiting.task.runtimeDiagnostics.needsAttention, true);
    assert.equal(waiting.task.runtimeDiagnostics.nextAction.code, 'reconnect_session_worker');
    assert.equal(waiting.task.nextAction.code, 'reconnect_session_worker');
    const waitingStatus = await admin.status();
    assert.ok(waitingStatus.tasks.attention.operationalIssues >= 1);
    assert.ok(waitingStatus.tasks.attention.items.some((item) => (
      item.id === interrupted.task.id
      && item.runtimeDiagnostics?.state === 'waiting_for_session_worker'
    )));

    transportBlocked = false;
    const completed = await waitForTask(
      admin,
      interrupted.task.id,
      (task) => task.status === 'succeeded',
      20_000,
    );
    assert.equal(completed.assignedWorkerId, 'session-recovery-worker');
    assert.equal(completed.workspace, initializedDone.workspace);
    assert.equal(completed.attemptSeq, 2);
    assert.equal(completed.attempts[0].id, firstAttemptId);
    assert.equal(completed.attempts[0].status, 'lease_expired');
    assert.equal(completed.runtimeDiagnostics.state, 'terminal');
    assert.equal(
      await fs.readFile(path.join(completed.workspace, 'recovery-result.txt'), 'utf8'),
      'session-recovery-worker:2',
    );
    assert.ok(completed.events.some((event) => (
      event.type === 'lease_recovered'
      && event.attemptId === firstAttemptId
      && event.data?.sessionRecoveryMode === 'same-worker'
      && event.data?.sessionWorkspacePreserved === true
    )));
    assert.ok(completed.events.some((event) => (
      ['late_result_ignored', 'stale_result_ignored', 'expired_lease_result_ignored'].includes(event.type)
    )));
  } finally {
    transportBlocked = false;
    worker.stop();
    await Promise.allSettled([worker.done]);
    await new Promise((resolve) => running.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
