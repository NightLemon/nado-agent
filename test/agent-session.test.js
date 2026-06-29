import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-agent-session-'));
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

test('session agent tasks receive prior transcript in later prompts', async () => {
  const root = await makeTempDir();
  const token = 'agent-session-token';
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
      id: 'agent-session-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
      agentCommand: 'node -e "const fs=require(\'fs\'); const p=process.argv[1]; const prompt=fs.readFileSync(p,\'utf8\'); if (prompt.includes(\'second-question\')) { if (!prompt.includes(\'first-question\') || !prompt.includes(\'FIRST-ANSWER\')) process.exit(7); fs.writeFileSync(\'continuity.txt\', \'yes\'); console.log(\'SECOND-ANSWER\'); } else { fs.writeFileSync(\'first-agent.txt\', prompt.includes(\'first-question\') ? \'ok\' : \'missing\'); console.log(\'FIRST-ANSWER\'); }" {promptFile}',
    });

    const { session } = await client.createSession({
      title: 'agent memory',
      workerId: 'agent-session-worker',
    });

    const first = await client.createTask({
      title: 'first agent turn',
      type: 'agent',
      sessionId: session.id,
      prompt: 'first-question',
    });
    const firstDone = await waitForTask(client, first.task.id, (task) => task.status === 'succeeded');
    assert.match(firstDone.stdout, /FIRST-ANSWER/);

    const second = await client.createTask({
      title: 'second agent turn',
      type: 'agent',
      sessionId: session.id,
      prompt: 'second-question',
    });
    const secondDone = await waitForTask(client, second.task.id, (task) => task.status === 'succeeded');
    assert.match(secondDone.stdout, /SECOND-ANSWER/);
    assert.equal(await fs.readFile(path.join(secondDone.workspace, 'continuity.txt'), 'utf8'), 'yes');

    const transcript = await fs.readFile(path.join(secondDone.workspace, '.nado-session', 'transcript.md'), 'utf8');
    assert.match(transcript, /first-question/);
    assert.match(transcript, /FIRST-ANSWER/);
    assert.match(transcript, /second-question/);

    assert.ok(secondDone.artifacts.some((artifact) => artifact.path === '.nado-session/transcript.md'));
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
