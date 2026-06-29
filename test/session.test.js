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
