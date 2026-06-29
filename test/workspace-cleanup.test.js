import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-cleanup-'));
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
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

test('workers can clean non-session task workspaces after artifact upload', async () => {
  const root = await makeTempDir();
  const token = 'cleanup-token';
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
      id: 'cleanup-worker',
      controlUrl,
      token,
      dataDir: root,
      cleanupWorkspaces: true,
      pollMs: 50,
    });

    const cleaned = await client.createTask({
      title: 'cleanup default',
      type: 'shell',
      workerId: 'cleanup-worker',
      command: 'node -e "require(\'fs\').writeFileSync(\'result.txt\', \'cleaned\')"',
    });
    const cleanedDone = await waitForTask(client, cleaned.task.id);
    assert.equal(cleanedDone.status, 'succeeded');
    assert.equal(cleanedDone.workspaceCleaned, true);
    assert.equal(await exists(cleanedDone.workspace), false);
    const cleanedArtifact = cleanedDone.artifacts.find((artifact) => artifact.path === 'result.txt');
    assert.ok(cleanedArtifact);
    const fetched = await client.getArtifact(cleanedDone.id, cleanedArtifact.id);
    assert.equal(Buffer.from(fetched.contentBase64, 'base64').toString('utf8'), 'cleaned');

    const kept = await client.createTask({
      title: 'keep override',
      type: 'shell',
      workerId: 'cleanup-worker',
      keepWorkspace: true,
      command: 'node -e "require(\'fs\').writeFileSync(\'kept.txt\', \'kept\')"',
    });
    const keptDone = await waitForTask(client, kept.task.id);
    assert.equal(keptDone.status, 'succeeded');
    assert.equal(keptDone.workspaceCleaned, false);
    assert.equal(await fs.readFile(path.join(keptDone.workspace, 'kept.txt'), 'utf8'), 'kept');

    const taskCleanup = await client.createTask({
      title: 'task cleanup',
      type: 'shell',
      workerId: 'cleanup-worker',
      keepWorkspace: false,
      command: 'node -e "require(\'fs\').writeFileSync(\'task-clean.txt\', \'task-clean\')"',
    });
    const taskCleanupDone = await waitForTask(client, taskCleanup.task.id);
    assert.equal(taskCleanupDone.workspaceCleaned, true);
    assert.equal(await exists(taskCleanupDone.workspace), false);
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
