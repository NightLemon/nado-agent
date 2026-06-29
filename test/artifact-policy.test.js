import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-artifact-policy-'));
}

async function waitForTask(client, taskId, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { task } = await client.getTask(taskId);
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for task ${taskId}`);
}

async function waitForBatch(client, batchId, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { batch, tasks } = await client.getBatch(batchId);
    if (['succeeded', 'completed_with_errors'].includes(batch.status)) {
      return { batch, tasks };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for batch ${batchId}`);
}

test('artifact policies include and exclude completed task outputs', async () => {
  const root = await makeTempDir();
  const token = 'artifact-policy-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });
  let worker;

  try {
    worker = await startWorker({
      id: 'artifact-worker',
      controlUrl,
      token,
      dataDir: root,
      pollMs: 50,
    });

    const created = await client.createTask({
      title: 'filtered artifacts',
      type: 'shell',
      workerId: 'artifact-worker',
      artifactPolicy: {
        include: ['report.txt', '*.md', 'dist/**'],
        exclude: ['dist/tmp/**'],
      },
      command: [
        'node -e "',
        'const fs=require(\'fs\');',
        'fs.mkdirSync(\'dist/tmp\',{recursive:true});',
        'fs.writeFileSync(\'report.txt\',\'report\');',
        'fs.writeFileSync(\'README.md\',\'readme\');',
        'fs.writeFileSync(\'dist/result.txt\',\'result\');',
        'fs.writeFileSync(\'dist/tmp/debug.txt\',\'debug\');',
        'fs.writeFileSync(\'scratch.log\',\'scratch\');',
        '"',
      ].join(' '),
    });
    assert.deepEqual(created.task.artifactPolicy, {
      include: ['report.txt', '*.md', 'dist/**'],
      exclude: ['dist/tmp/**'],
    });

    const done = await waitForTask(client, created.task.id);
    assert.equal(done.status, 'succeeded');
    const artifactPaths = done.artifacts.map((artifact) => artifact.path).sort();
    assert.deepEqual(artifactPaths, ['README.md', 'dist/result.txt', 'report.txt']);

    const batchCreated = await client.createBatch({
      title: 'batch artifact policy',
      defaults: {
        workerId: 'artifact-worker',
        artifactPolicy: {
          include: ['shared/**'],
          exclude: ['shared/tmp/**'],
        },
      },
      tasks: [
        {
          key: 'merged',
          title: 'merged policy',
          artifactPolicy: {
            include: ['child/**'],
            exclude: ['child/tmp/**'],
          },
          command: [
            'node -e "',
            'const fs=require(\'fs\');',
            'fs.mkdirSync(\'shared/tmp\',{recursive:true});',
            'fs.mkdirSync(\'child/tmp\',{recursive:true});',
            'fs.writeFileSync(\'shared/a.txt\',\'shared\');',
            'fs.writeFileSync(\'shared/tmp/skip.txt\',\'skip\');',
            'fs.writeFileSync(\'child/b.txt\',\'child\');',
            'fs.writeFileSync(\'child/tmp/skip.txt\',\'skip\');',
            'fs.writeFileSync(\'other.txt\',\'other\');',
            '"',
          ].join(' '),
        },
      ],
    });
    const child = batchCreated.tasks[0];
    assert.deepEqual(child.artifactPolicy, {
      include: ['shared/**', 'child/**'],
      exclude: ['shared/tmp/**', 'child/tmp/**'],
    });

    const batchDone = await waitForBatch(client, batchCreated.batch.id);
    assert.equal(batchDone.batch.status, 'succeeded');
    const batchChild = batchDone.tasks[0];
    assert.deepEqual(
      batchChild.artifacts.map((artifact) => artifact.path).sort(),
      ['child/b.txt', 'shared/a.txt'],
    );
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('agent runtime prompt files are hidden from default artifacts but can be requested', async () => {
  const root = await makeTempDir();
  const token = 'agent-artifact-policy-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });
  let worker;

  try {
    worker = await startWorker({
      id: 'agent-artifact-worker',
      controlUrl,
      token,
      dataDir: root,
      pollMs: 50,
      agentCommand: 'node -e "const fs=require(\'fs\'); const p=process.argv[1]; fs.writeFileSync(\'result.txt\', fs.readFileSync(p,\'utf8\').includes(\'agent artifact prompt\') ? \'ok\' : \'missing\')" {promptFile}',
    });

    const created = await client.createTask({
      title: 'agent artifact default',
      type: 'agent',
      workerId: 'agent-artifact-worker',
      prompt: 'agent artifact prompt',
    });
    const done = await waitForTask(client, created.task.id);
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(done.artifacts.map((artifact) => artifact.path).sort(), ['result.txt']);

    const debugCreated = await client.createTask({
      title: 'agent artifact debug include',
      type: 'agent',
      workerId: 'agent-artifact-worker',
      prompt: 'agent artifact prompt',
      artifactPolicy: {
        include: ['result.txt', '.nado/**'],
      },
    });
    const debugDone = await waitForTask(client, debugCreated.task.id);
    assert.equal(debugDone.status, 'succeeded');
    assert.deepEqual(debugDone.artifacts.map((artifact) => artifact.path).sort(), ['.nado/prompt.md', 'result.txt']);
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
