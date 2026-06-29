import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { runDoctor } from '../src/doctor.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-doctor-'));
}

test('doctor can self-test every eligible active worker', async () => {
  const root = await makeTempDir();
  const token = 'doctor-token';
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
      id: 'doctor-a',
      controlUrl,
      token,
      dataDir: root,
      labels: { zone: 'doctor' },
      pollMs: 50,
    }));
    workers.push(await startWorker({
      id: 'doctor-b',
      controlUrl,
      token,
      dataDir: root,
      labels: { zone: 'doctor' },
      pollMs: 50,
    }));

    const result = await runDoctor(client, {
      selfTest: true,
      allWorkers: true,
      requiredLabels: { zone: 'doctor' },
      timeoutMs: 8_000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.selfTests.length, 2);
    assert.deepEqual(result.selfTests.map((item) => item.workerId).sort(), ['doctor-a', 'doctor-b']);
    assert.ok(result.selfTests.every((item) => item.status === 'succeeded'));
    assert.ok(result.selfTests.every((item) => item.artifacts.some((artifact) => artifact.path === 'doctor.txt')));

    const apiResult = await client.doctor({
      requiredLabels: { zone: 'doctor' },
      timeoutMs: 8_000,
    });
    assert.equal(apiResult.ok, true);
    assert.equal(apiResult.workers.total, 2);
    assert.equal(apiResult.selfTests.length, 0);
  } finally {
    for (const worker of workers) {
      worker.stop();
    }
    await Promise.allSettled(workers.map((worker) => worker.done));
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('doctor can run an explicit terminal-agent self-test', async () => {
  const root = await makeTempDir();
  const token = 'doctor-agent-token';
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
      id: 'doctor-agent',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      labels: { zone: 'doctor-agent' },
      agentCommand: 'node -e "const fs=require(\'fs\'); const p=process.argv[1]; fs.writeFileSync(\'doctor-agent.txt\', fs.readFileSync(p,\'utf8\').includes(\'Nado doctor agent self-test\') ? \'nado-agent-ok\' : \'missing\'); console.log(\'agent-ok\')" {promptFile}',
      agentPreset: 'node-copy',
      pollMs: 50,
    });

    const result = await runDoctor(client, {
      agentSelfTest: true,
      requiredLabels: { zone: 'doctor-agent' },
      timeoutMs: 8_000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.selfTests.length, 0);
    assert.equal(result.agentSelfTests.length, 1);
    assert.equal(result.agentSelfTest.status, 'succeeded');
    assert.equal(result.agentSelfTest.workerId, 'doctor-agent');
    assert.ok(result.agentSelfTest.artifacts.some((artifact) => artifact.path === 'doctor-agent.txt'));

    const { worker: recordedWorker } = await client.getWorker('doctor-agent');
    assert.equal(recordedWorker.diagnostics.agentSelfTest.status, 'succeeded');
    assert.equal(recordedWorker.diagnostics.agentSelfTest.taskId, result.agentSelfTest.taskId);

    const capabilities = await client.capabilities();
    const workerSummary = capabilities.workers.find((worker) => worker.id === 'doctor-agent');
    assert.equal(workerSummary.agent.selfTest.status, 'succeeded');

    const context = await client.context();
    assert.match(context, /agent self-test: succeeded/);
  } finally {
    if (worker) {
      worker.stop();
      await worker.done;
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
