import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';
import { buildAgentContext, writeAgentContext } from '../src/context.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-agent-'));
}

async function waitForTask(client, taskId, predicate, timeoutMs = 8_000) {
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
  assert.fail(`Timed out waiting for task ${taskId}; last status ${lastTask?.status}`);
}

test('local control server coordinates explicit, capability, and agent tasks', async () => {
  const root = await makeTempDir();
  const token = 'test-token';
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
    assert.equal((await client.health()).ok, true);

    workers.push(await startWorker({
      id: 'worker-a',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code', 'docs'],
      pollMs: 50,
    }));
    workers.push(await startWorker({
      id: 'gpu-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['gpu', 'code'],
      agentCommand: 'node -e "const fs=require(\'fs\'); const p=process.argv[1]; fs.writeFileSync(\'agent.txt\', fs.readFileSync(p,\'utf8\'))" {promptFile}',
      pollMs: 50,
    }));

    const listed = await client.listWorkers();
    assert.deepEqual(
      listed.workers.map((worker) => worker.id).sort(),
      ['gpu-worker', 'worker-a'],
    );

    const explicit = await client.createTask({
      title: 'explicit dispatch',
      type: 'shell',
      workerId: 'worker-a',
      command: 'node -e "require(\'fs\').writeFileSync(\'explicit.txt\', process.env.NADO_WORKER_ID); console.log(process.env.NADO_WORKER_ID)"',
    });
    const explicitDone = await waitForTask(
      client,
      explicit.task.id,
      (task) => task.status === 'succeeded',
    );
    assert.equal(explicitDone.assignedWorkerId, 'worker-a');
    assert.match(explicitDone.stdout, /worker-a/);
    assert.equal(
      await fs.readFile(path.join(explicitDone.workspace, 'explicit.txt'), 'utf8'),
      'worker-a',
    );
    assert.ok(explicitDone.artifacts.some((artifact) => artifact.path === 'explicit.txt' && !artifact.skipped));
    const explicitArtifacts = await client.listArtifacts(explicit.task.id);
    const explicitArtifact = explicitArtifacts.artifacts.find((artifact) => artifact.path === 'explicit.txt');
    assert.ok(explicitArtifact);
    const downloadedExplicit = await client.getArtifact(explicit.task.id, explicitArtifact.id);
    assert.equal(
      Buffer.from(downloadedExplicit.contentBase64, 'base64').toString('utf8'),
      'worker-a',
    );
    const explicitArtifactContent = await client.getTaskArtifacts(explicit.task.id);
    assert.equal(explicitArtifactContent.task.id, explicit.task.id);
    assert.equal(explicitArtifactContent.totalArtifacts, 1);
    assert.equal(explicitArtifactContent.totalBytes, 'worker-a'.length);
    assert.equal(
      Buffer.from(explicitArtifactContent.artifacts[0].contentBase64, 'base64').toString('utf8'),
      'worker-a',
    );
    const rawExplicit = await client.downloadArtifact(explicit.task.id, explicitArtifact.id);
    assert.equal(rawExplicit.bytes.toString('utf8'), 'worker-a');
    assert.equal(rawExplicit.artifact.path, 'explicit.txt');
    assert.equal(rawExplicit.fileName, 'explicit.txt');
    const taskArtifactsZip = await client.downloadTaskArtifactsZip(explicit.task.id);
    assert.match(taskArtifactsZip.contentType, /application\/zip/);
    assert.equal(taskArtifactsZip.fileName, `${explicit.task.id}-artifacts.zip`);
    assert.ok(taskArtifactsZip.bytes.includes(Buffer.from('explicit.txt')));
    assert.ok(taskArtifactsZip.bytes.includes(Buffer.from('worker-a')));

    const rawResponse = await fetch(`${controlUrl}/api/tasks/${explicit.task.id}/artifacts/${explicitArtifact.id}/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(rawResponse.status, 200);
    assert.match(rawResponse.headers.get('content-type'), /application\/octet-stream/);
    assert.match(rawResponse.headers.get('content-disposition'), /explicit\.txt/);
    assert.equal(await rawResponse.text(), 'worker-a');
    const contentResponse = await fetch(`${controlUrl}/api/tasks/${explicit.task.id}/artifacts/content`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(contentResponse.status, 200);
    const contentJson = await contentResponse.json();
    assert.equal(contentJson.task.id, explicit.task.id);
    assert.equal(
      Buffer.from(contentJson.artifacts[0].contentBase64, 'base64').toString('utf8'),
      'worker-a',
    );

    const deniedRawResponse = await fetch(`${controlUrl}/api/tasks/${explicit.task.id}/artifacts/${explicitArtifact.id}/download`);
    assert.equal(deniedRawResponse.status, 401);
    const deniedContentResponse = await fetch(`${controlUrl}/api/tasks/${explicit.task.id}/artifacts/content`);
    assert.equal(deniedContentResponse.status, 401);
    const zipResponse = await fetch(`${controlUrl}/api/tasks/${explicit.task.id}/artifacts/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(zipResponse.status, 200);
    assert.match(zipResponse.headers.get('content-type'), /application\/zip/);
    assert.match(zipResponse.headers.get('content-disposition'), new RegExp(`${explicit.task.id}-artifacts\\.zip`));
    assert.ok(Buffer.from(await zipResponse.arrayBuffer()).includes(Buffer.from('explicit.txt')));
    const deniedZipResponse = await fetch(`${controlUrl}/api/tasks/${explicit.task.id}/artifacts/download`);
    assert.equal(deniedZipResponse.status, 401);

    const routed = await client.createTask({
      title: 'gpu dispatch',
      type: 'shell',
      requiredCapabilities: ['gpu'],
      command: 'node -e "require(\'fs\').writeFileSync(\'gpu.txt\', process.env.NADO_WORKER_ID); console.log(process.env.NADO_WORKER_ID)"',
    });
    const routedDone = await waitForTask(
      client,
      routed.task.id,
      (task) => task.status === 'succeeded',
    );
    assert.equal(routedDone.assignedWorkerId, 'gpu-worker');
    assert.equal(
      await fs.readFile(path.join(routedDone.workspace, 'gpu.txt'), 'utf8'),
      'gpu-worker',
    );

    const agent = await client.createTask({
      title: 'agent hook',
      type: 'agent',
      workerId: 'gpu-worker',
      prompt: 'hello from prompt file',
    });
    const agentDone = await waitForTask(
      client,
      agent.task.id,
      (task) => task.status === 'succeeded',
    );
    assert.equal(
      await fs.readFile(path.join(agentDone.workspace, 'agent.txt'), 'utf8'),
      'hello from prompt file',
    );
    assert.ok(agentDone.artifacts.some((artifact) => artifact.path === 'agent.txt' && !artifact.skipped));

    const missingCapability = await client.createTask({
      title: 'no matching worker',
      type: 'shell',
      requiredCapabilities: ['ppt'],
      command: 'node -e "console.log(\'should stay queued\')"',
    });
    const stillQueued = await client.getTask(missingCapability.task.id);
    assert.equal(stillQueued.task.status, 'queued');
    assert.equal(stillQueued.task.assignedWorkerId, null);

    const missingAgentCommand = await client.createTask({
      title: 'agent hook missing config',
      type: 'agent',
      workerId: 'worker-a',
      prompt: 'this should fail clearly',
    });
    assert.equal(missingAgentCommand.task.status, 'queued');
    assert.equal(missingAgentCommand.task.scheduler.workerId, null);
    assert.equal(missingAgentCommand.task.scheduler.reason, 'explicit worker requested; target not eligible');
    assert.ok(missingAgentCommand.task.scheduler.candidates[0].reasons.includes('no agent command configured'));
    const missingClaim = await client.claimTask('worker-a');
    assert.equal(missingClaim.task, null);

    const latestWorkers = (await client.listWorkers()).workers;
    const context = buildAgentContext({ controlUrl, workers: latestWorkers });
    const contextFile = path.join(root, 'AGENTS.md');
    await writeAgentContext(contextFile, context);
    const contextText = await fs.readFile(contextFile, 'utf8');
    assert.match(contextText, /worker-a/);
    assert.match(contextText, /gpu-worker/);
    assert.match(contextText, /--capability code/);
  } finally {
    for (const worker of workers) {
      worker.stop();
    }
    await Promise.allSettled(workers.map((worker) => worker.done));
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
