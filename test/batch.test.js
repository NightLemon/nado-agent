import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-batch-'));
}

async function waitForBatch(client, batchId, predicate, timeoutMs = 12_000) {
  const started = Date.now();
  let lastBatch = null;
  while (Date.now() - started < timeoutMs) {
    const { batch, tasks } = await client.getBatch(batchId);
    lastBatch = batch;
    if (predicate(batch, tasks)) {
      return { batch, tasks };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for batch ${batchId}; last=${JSON.stringify(lastBatch)}`);
}

async function collectUntilDone(stream, timeoutMs = 12_000) {
  const timeout = new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('Timed out waiting for batch event stream')), timeoutMs);
  });
  const collect = (async () => {
    const rows = [];
    for await (const item of stream) {
      rows.push(item);
      if (item.event === 'done') {
        break;
      }
    }
    return rows;
  })();
  return Promise.race([collect, timeout]);
}

test('batch planning API returns submit-ready batch JSON', async () => {
  const root = await makeTempDir();
  const token = 'batch-plan-http-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    const planned = await client.planBatch({
      title: 'dashboard planned work',
      type: 'shell',
      tasks: ['docs: Draft docs', 'tests: Add smoke tests'],
      capabilities: ['code'],
      tools: ['node'],
      labels: { zone: 'lab' },
      sandboxProfile: 'isolated',
      priority: 4,
      slots: 2,
      commandTemplate: 'echo {key}:{title}',
    });

    assert.equal(planned.batch.title, 'dashboard planned work');
    assert.deepEqual(planned.batch.defaults, {
      capabilities: ['code'],
      tools: ['node'],
      labels: { zone: 'lab' },
      slots: 2,
      priority: 4,
      sandboxProfile: 'isolated',
    });
    assert.deepEqual(
      planned.batch.tasks.map((task) => task.key),
      ['docs', 'tests'],
    );
    assert.deepEqual(
      planned.batch.tasks.map((task) => task.command),
      ['echo docs:Draft docs', 'echo tests:Add smoke tests'],
    );

    const submitted = await client.createBatch(planned.batch);
    assert.equal(submitted.batch.title, 'dashboard planned work');
    assert.equal(submitted.tasks.length, 2);
    assert.ok(submitted.tasks.every((task) => task.sandboxProfile === 'isolated'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('batch event SSE stream emits merged child timeline until terminal status', async () => {
  const root = await makeTempDir();
  const token = 'batch-sse-token';
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
    const created = await client.createBatch({
      title: 'sse batch',
      tasks: [
        {
          key: 'one',
          title: 'stream one',
          type: 'shell',
          workerId: 'batch-sse-worker',
          command: 'node -e "console.log(\'batch-one\')"',
        },
        {
          key: 'two',
          title: 'stream two',
          type: 'shell',
          workerId: 'batch-sse-worker',
          command: 'node -e "console.log(\'batch-two\')"',
        },
      ],
    });
    const streamDone = collectUntilDone(client.streamBatchEvents(created.batch.id));

    worker = await startWorker({
      id: 'batch-sse-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      maxConcurrency: 2,
      pollMs: 50,
    });

    const rows = await streamDone;
    assert.ok(rows.some((row) => row.event === 'event' && row.data.source === 'batch' && row.data.type === 'created'));
    assert.ok(rows.some((row) => row.event === 'event' && row.data.source === 'task' && row.data.task === 'one' && row.data.type === 'succeeded'));
    assert.ok(rows.some((row) => row.event === 'event' && row.data.source === 'task' && row.data.task === 'two' && row.data.type === 'succeeded'));
    assert.ok(rows.some((row) => row.event === 'done' && row.data.status === 'succeeded'));
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('batch submission creates durable grouped tasks and distributes by capacity', async () => {
  const root = await makeTempDir();
  const token = 'batch-token';
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
      id: 'batch-a',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      maxConcurrency: 1,
      pollMs: 50,
    }));
    workers.push(await startWorker({
      id: 'batch-b',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      maxConcurrency: 1,
      pollMs: 50,
    }));

    const created = await client.createBatch({
      title: 'three shard batch',
      tasks: [
        {
          title: 'shard one',
          type: 'shell',
          requiredCapabilities: ['code'],
          command: 'node -e "setTimeout(() => { require(\'fs\').writeFileSync(\'one.txt\', process.env.NADO_WORKER_ID); console.log(process.env.NADO_WORKER_ID) }, 600)"',
        },
        {
          title: 'shard two',
          type: 'shell',
          requiredCapabilities: ['code'],
          command: 'node -e "setTimeout(() => { require(\'fs\').writeFileSync(\'two.txt\', process.env.NADO_WORKER_ID); console.log(process.env.NADO_WORKER_ID) }, 600)"',
        },
        {
          title: 'shard three',
          type: 'shell',
          requiredCapabilities: ['code'],
          command: 'node -e "require(\'fs\').writeFileSync(\'three.txt\', process.env.NADO_WORKER_ID); console.log(process.env.NADO_WORKER_ID)"',
        },
      ],
    });

    assert.equal(created.batch.totalTasks, 3);
    assert.equal(new Set(created.tasks.map((task) => task.batchId)).size, 1);
    assert.equal(created.tasks[0].batchId, created.batch.id);
    assert.deepEqual(
      created.tasks.slice(0, 2).map((task) => task.requestedWorkerId).sort(),
      ['batch-a', 'batch-b'],
    );

    const listed = await client.listBatches();
    assert.ok(listed.batches.some((batch) => batch.id === created.batch.id));

    const done = await waitForBatch(
      client,
      created.batch.id,
      (batch) => batch.status === 'succeeded',
    );
    assert.equal(done.batch.completedTasks, 3);
    assert.equal(done.batch.counts.succeeded, 3);
    assert.deepEqual(
      done.tasks.map((task) => task.status),
      ['succeeded', 'succeeded', 'succeeded'],
    );
    assert.ok(new Set(done.tasks.map((task) => task.assignedWorkerId)).size >= 2);

    const artifactList = await client.listBatchArtifacts(created.batch.id);
    assert.equal(artifactList.totalArtifacts, 3);
    assert.ok(artifactList.tasks.every((child) => child.artifacts.length === 1));

    const artifactContent = await client.getBatchArtifacts(created.batch.id);
    assert.equal(artifactContent.totalArtifacts, 3);
    const oneArtifact = artifactContent.tasks
      .find((child) => child.title === 'shard one')
      .artifacts
      .find((artifact) => artifact.path === 'one.txt');
    assert.ok(oneArtifact);
    assert.ok(Buffer.from(oneArtifact.contentBase64, 'base64').toString('utf8').startsWith('batch-'));

    const zip = await client.downloadBatchArtifactsZip(created.batch.id);
    assert.match(zip.contentType, /application\/zip/);
    assert.equal(zip.fileName, `${created.batch.id}-artifacts.zip`);
    assert.ok(zip.bytes.includes(Buffer.from('one.txt')));
    assert.ok(zip.bytes.includes(Buffer.from('batch-')));
    const zipResponse = await fetch(`${controlUrl}/api/batches/${created.batch.id}/artifacts/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(zipResponse.status, 200);
    assert.match(zipResponse.headers.get('content-type'), /application\/zip/);
    assert.match(zipResponse.headers.get('content-disposition'), new RegExp(`${created.batch.id}-artifacts\\.zip`));
    assert.ok(Buffer.from(await zipResponse.arrayBuffer()).includes(Buffer.from('one.txt')));
    const deniedZipResponse = await fetch(`${controlUrl}/api/batches/${created.batch.id}/artifacts/download`);
    assert.equal(deniedZipResponse.status, 401);

    const report = await client.getBatchReport(created.batch.id, { stdoutChars: 200 });
    assert.equal(report.batch.status, 'succeeded');
    assert.equal(report.batch.artifactTotal, 3);
    assert.equal(report.tasks.length, 3);
    assert.ok(report.tasks.some((task) => task.title === 'shard one' && task.artifacts.some((artifact) => artifact.path === 'one.txt')));
    assert.ok(report.nextActions.some((action) => action.includes('Download or inspect artifacts')));

    const timeline = await client.listBatchEvents(created.batch.id);
    assert.equal(timeline.batch.id, created.batch.id);
    assert.ok(timeline.events.some((event) => event.source === 'batch' && event.type === 'created'));
    assert.ok(timeline.events.some((event) => event.source === 'task' && event.type === 'succeeded'));

    const snapshot = await client.status();
    assert.equal(snapshot.workers.total, 2);
    assert.equal(snapshot.batches.total, 1);
    assert.equal(snapshot.batches.counts.succeeded, 1);
    assert.equal(snapshot.tasks.counts.succeeded, 3);
  } finally {
    for (const worker of workers) {
      worker.stop();
    }
    await Promise.allSettled(workers.map((worker) => worker.done));
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('batch defaults apply shared routing and runtime policy to child tasks', async () => {
  const root = await makeTempDir();
  const token = 'batch-defaults-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    const created = await client.createBatch({
      title: 'defaulted batch',
      defaults: {
        type: 'shell',
        workerId: 'default-worker',
        requiredCapabilities: ['code'],
        requiredLabels: { zone: 'lab', role: 'default' },
        priority: 9,
        keepWorkspace: false,
        sandboxProfile: 'isolated',
        timeoutMs: 12_345,
      },
      tasks: [
        {
          key: 'inherit',
          title: 'inherits defaults',
          command: 'node -e "console.log(\'inherit\')"',
        },
        {
          key: 'override',
          title: 'overrides selected defaults',
          capabilities: ['docs'],
          labels: { role: 'writer' },
          priority: 2,
          keepWorkspace: true,
          sandboxProfile: 'default',
          command: 'node -e "console.log(\'override\')"',
        },
      ],
    });

    const inherited = created.tasks.find((task) => task.batchKey === 'inherit');
    assert.equal(inherited.requestedWorkerId, 'default-worker');
    assert.deepEqual(inherited.requiredCapabilities, ['code']);
    assert.deepEqual(inherited.requiredLabels, { zone: 'lab', role: 'default' });
    assert.equal(inherited.priority, 9);
    assert.equal(inherited.keepWorkspace, false);
    assert.equal(inherited.sandboxProfile, 'isolated');
    assert.equal(inherited.timeoutMs, 12_345);

    const overridden = created.tasks.find((task) => task.batchKey === 'override');
    assert.equal(overridden.requestedWorkerId, 'default-worker');
    assert.deepEqual(overridden.requiredCapabilities, ['docs']);
    assert.deepEqual(overridden.requiredLabels, { zone: 'lab', role: 'writer' });
    assert.equal(overridden.priority, 2);
    assert.equal(overridden.keepWorkspace, true);
    assert.equal(overridden.sandboxProfile, 'default');
    assert.equal(overridden.timeoutMs, 12_345);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('batch retry_failed requeues only failed or cancelled child tasks', async () => {
  const root = await makeTempDir();
  const token = 'batch-retry-token';
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
      id: 'retry-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      maxConcurrency: 1,
      pollMs: 50,
    });

    const created = await client.createBatch({
      title: 'retry failed shard',
      tasks: [
        {
          title: 'always succeeds',
          type: 'shell',
          workerId: 'retry-worker',
          command: 'node -e "require(\'fs\').writeFileSync(\'success.txt\', \'ok\'); console.log(\'success\')"',
        },
        {
          title: 'fails first then succeeds',
          type: 'shell',
          workerId: 'retry-worker',
          command: 'node -e "const fs=require(\'fs\'); const marker=\'marker.txt\'; if (!fs.existsSync(marker)) { fs.writeFileSync(marker, \'seen\'); process.exit(2); } fs.writeFileSync(\'retry-success.txt\', \'ok\'); console.log(\'retried ok\')"',
        },
      ],
    });

    const errored = await waitForBatch(
      client,
      created.batch.id,
      (batch) => batch.status === 'completed_with_errors',
    );
    assert.equal(errored.batch.counts.succeeded, 1);
    assert.equal(errored.batch.counts.failed, 1);
    const succeededTask = errored.tasks.find((task) => task.status === 'succeeded');
    const failedTask = errored.tasks.find((task) => task.status === 'failed');
    assert.ok(succeededTask);
    assert.ok(failedTask);

    const retry = await client.manageBatch(created.batch.id, 'retry_failed', {
      workerId: 'retry-worker',
      reason: 'test retry failed only',
    });
    assert.equal(retry.retried.length, 1);
    assert.equal(retry.retried[0].id, failedTask.id);
    assert.ok(retry.skipped.some((item) => item.task.id === succeededTask.id && item.reason === 'status=succeeded'));

    const done = await waitForBatch(
      client,
      created.batch.id,
      (batch) => batch.status === 'succeeded',
    );
    assert.equal(done.batch.counts.succeeded, 2);
    const finalSucceededTask = done.tasks.find((task) => task.id === succeededTask.id);
    const finalRetriedTask = done.tasks.find((task) => task.id === failedTask.id);
    assert.equal(finalSucceededTask.startedAt, succeededTask.startedAt);
    assert.match(finalRetriedTask.stdout, /retried ok/);
    assert.ok(finalRetriedTask.events.some((event) => event.type === 'requeued'));
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('batch dependencies block child tasks until parents succeed', async () => {
  const root = await makeTempDir();
  const token = 'batch-dag-token';
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
    const created = await client.createBatch({
      title: 'dependency chain',
      tasks: [
        {
          key: 'prepare',
          title: 'prepare input',
          type: 'shell',
          requiredCapabilities: ['code'],
          command: 'node -e "setTimeout(() => { require(\'fs\').writeFileSync(\'ready.txt\', \'prepared\'); console.log(\'prepare done\') }, 700)"',
        },
        {
          key: 'consume',
          dependsOn: ['prepare'],
          title: 'consume prepared input',
          type: 'shell',
          requiredCapabilities: ['code'],
          dependencyArtifacts: true,
          command: 'node -e "const fs=require(\'fs\'); const value=fs.readFileSync(\'.nado/dependencies/prepare/ready.txt\', \'utf8\'); fs.writeFileSync(\'consumed.txt\', value+\':consumed\'); console.log(value)"',
        },
      ],
    });

    const prepare = created.tasks.find((task) => task.batchKey === 'prepare');
    const consume = created.tasks.find((task) => task.batchKey === 'consume');
    assert.equal(prepare.status, 'queued');
    assert.equal(consume.status, 'blocked');
    assert.deepEqual(consume.dependencyKeys, ['prepare']);
    assert.deepEqual(consume.dependsOnTaskIds, [prepare.id]);
    assert.match(consume.blockedReason, /prepare/);

    worker = await startWorker({
      id: 'dag-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      maxConcurrency: 1,
      pollMs: 50,
    });

    await waitForBatch(
      client,
      created.batch.id,
      (batch, tasks) => {
        const runningPrepare = tasks.find((task) => task.batchKey === 'prepare');
        const blockedConsume = tasks.find((task) => task.batchKey === 'consume');
        return runningPrepare?.status === 'running' && blockedConsume?.status === 'blocked';
      },
    );

    const done = await waitForBatch(
      client,
      created.batch.id,
      (batch) => batch.status === 'succeeded',
    );
    assert.equal(done.batch.counts.succeeded, 2);
    const finalConsume = done.tasks.find((task) => task.batchKey === 'consume');
    assert.equal(finalConsume.status, 'succeeded');
    assert.ok(finalConsume.dependencyInputFiles.some((file) => file.path === '.nado/dependencies/prepare/ready.txt'));
    assert.ok(finalConsume.artifacts.some((artifact) => artifact.path === 'consumed.txt'));
    assert.equal(finalConsume.artifacts.some((artifact) => artifact.path.startsWith('.nado/dependencies/')), false);
    assert.ok(finalConsume.events.some((event) => event.type === 'unblocked'));
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('batch dependency failure keeps children blocked until retry succeeds', async () => {
  const root = await makeTempDir();
  const token = 'batch-dag-retry-token';
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
    const created = await client.createBatch({
      title: 'dependency retry chain',
      tasks: [
        {
          key: 'prepare',
          title: 'prepare fails once',
          type: 'shell',
          workerId: 'dag-retry-worker',
          command: 'node -e "const fs=require(\'fs\'); if (!fs.existsSync(\'prepare-marker.txt\')) { fs.writeFileSync(\'prepare-marker.txt\', \'seen\'); process.exit(5); } console.log(\'prepare retried ok\')"',
        },
        {
          key: 'consume',
          dependsOn: ['prepare'],
          title: 'consume after retry',
          type: 'shell',
          workerId: 'dag-retry-worker',
          command: 'node -e "console.log(\'consume after retry\')"',
        },
      ],
    });

    worker = await startWorker({
      id: 'dag-retry-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      maxConcurrency: 1,
      pollMs: 50,
    });

    const errored = await waitForBatch(
      client,
      created.batch.id,
      (batch) => batch.status === 'completed_with_errors',
    );
    const failedPrepare = errored.tasks.find((task) => task.batchKey === 'prepare');
    const blockedConsume = errored.tasks.find((task) => task.batchKey === 'consume');
    assert.equal(failedPrepare.status, 'failed');
    assert.equal(blockedConsume.status, 'blocked');
    assert.match(blockedConsume.blockedReason, /failed dependencies/);

    const retry = await client.manageBatch(created.batch.id, 'retry_failed', {
      workerId: 'dag-retry-worker',
      reason: 'retry dependency parent',
    });
    assert.equal(retry.retried.length, 1);
    assert.equal(retry.retried[0].batchKey, 'prepare');

    const afterRetry = await client.getBatch(created.batch.id);
    const waitingConsume = afterRetry.tasks.find((task) => task.batchKey === 'consume');
    assert.equal(waitingConsume.status, 'blocked');
    assert.match(waitingConsume.blockedReason, /Waiting for dependencies: prepare/);

    const done = await waitForBatch(
      client,
      created.batch.id,
      (batch) => batch.status === 'succeeded',
    );
    const finalPrepare = done.tasks.find((task) => task.batchKey === 'prepare');
    const finalConsume = done.tasks.find((task) => task.batchKey === 'consume');
    assert.equal(finalPrepare.status, 'succeeded');
    assert.match(finalPrepare.stdout, /prepare retried ok/);
    assert.equal(finalConsume.status, 'succeeded');
    assert.match(finalConsume.stdout, /consume after retry/);
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('batch dependency validation rejects missing keys and cycles', async () => {
  const root = await makeTempDir();
  const token = 'batch-dag-validation-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    await assert.rejects(
      () => client.createBatch({
        title: 'missing dependency',
        tasks: [
          {
            key: 'child',
            dependsOn: ['missing'],
            title: 'child',
            command: 'node -e "console.log(1)"',
          },
        ],
      }),
      /Unknown batch dependency/,
    );

    await assert.rejects(
      () => client.createBatch({
        title: 'cycle dependency',
        tasks: [
          {
            key: 'a',
            dependsOn: ['b'],
            title: 'a',
            command: 'node -e "console.log(1)"',
          },
          {
            key: 'b',
            dependsOn: ['a'],
            title: 'b',
            command: 'node -e "console.log(2)"',
          },
        ],
      }),
      /Batch dependency cycle/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('batch cancel stops queued running and blocked child tasks', async () => {
  const root = await makeTempDir();
  const token = 'batch-cancel-token';
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
    const created = await client.createBatch({
      title: 'cancel remaining work',
      tasks: [
        {
          key: 'running',
          title: 'long running shard',
          type: 'shell',
          workerId: 'batch-cancel-worker',
          command: 'node -e "setTimeout(() => { console.log(\'too late\') }, 5000)"',
        },
        {
          key: 'queued',
          title: 'queued shard',
          type: 'shell',
          workerId: 'batch-cancel-worker',
          command: 'node -e "console.log(\'queued\')"',
        },
        {
          key: 'blocked',
          dependsOn: ['running'],
          title: 'blocked shard',
          type: 'shell',
          workerId: 'batch-cancel-worker',
          command: 'node -e "console.log(\'blocked\')"',
        },
      ],
    });

    worker = await startWorker({
      id: 'batch-cancel-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code'],
      maxConcurrency: 1,
      pollMs: 50,
    });

    await waitForBatch(
      client,
      created.batch.id,
      (batch, tasks) => tasks.some((task) => task.batchKey === 'running' && task.status === 'running'),
    );

    const cancelled = await client.manageBatch(created.batch.id, 'cancel', {
      reason: 'test batch cancel',
    });
    assert.equal(cancelled.cancelled.length, 3);
    assert.equal(cancelled.skipped.length, 0);
    assert.equal(cancelled.batch.status, 'completed_with_errors');
    assert.equal(cancelled.batch.counts.cancelled, 3);

    const done = await waitForBatch(
      client,
      created.batch.id,
      (batch) => batch.status === 'completed_with_errors',
    );
    assert.deepEqual(
      done.tasks.map((task) => task.status).sort(),
      ['cancelled', 'cancelled', 'cancelled'],
    );
    assert.ok(done.tasks.every((task) => task.events.some((event) => event.type === 'cancelled')));
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
