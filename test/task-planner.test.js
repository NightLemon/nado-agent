import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { buildDistributedTaskPlan } from '../src/task-planner.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-task-planner-'));
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('distributed planner builds a map-reduce batch DAG from a large prompt', () => {
  const result = buildDistributedTaskPlan({
    title: 'big implementation',
    prompt: 'Implement a large feature across docs, tests, and code.',
    mode: 'map_reduce',
    subtasks: ['design: define architecture', 'impl: implement code', 'verify: run tests'],
    capabilities: ['code'],
  });

  assert.equal(result.planner.mode, 'map_reduce');
  assert.equal(result.batch.tasks.length, 4);
  const final = result.batch.tasks.find((task) => task.key === 'final_synthesis');
  assert.deepEqual(final.dependsOn, ['design', 'impl', 'verify']);
  assert.equal(final.dependencyArtifacts, true);
  assert.match(final.prompt, /Read every available shard result/);
  assert.deepEqual(result.batch.defaults.capabilities, ['code']);
});

test('distributed planner supports pipeline dependencies', () => {
  const result = buildDistributedTaskPlan({
    prompt: 'Ship a staged deployment plan.',
    mode: 'pipeline',
    subtasks: ['plan: create plan', 'deploy: write commands', 'verify: validate rollout'],
  });

  const [plan, deploy, verify] = result.batch.tasks;
  assert.equal(plan.dependsOn, undefined);
  assert.deepEqual(deploy.dependsOn, ['plan']);
  assert.deepEqual(verify.dependsOn, ['deploy']);
  assert.equal(verify.dependencyArtifacts, true);
});

test('distributed planner falls back when shard count is invalid', () => {
  const result = buildDistributedTaskPlan({
    prompt: 'Split this large task safely.',
    shards: 'not-a-number',
  }, {
    workers: [],
  });

  assert.equal(result.planner.shardCount, 4);
  assert.equal(result.batch.tasks.length, 5);
});

test('planner HTTP endpoints preview routing and submit executable batch', async () => {
  const root = await tempDir();
  const token = 'planner-http-token';
  const running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    await running.store.upsertWorker({
      id: 'planner-a',
      capabilities: ['code'],
      agentCommandConfigured: true,
      inventory: { tools: { node: { ok: true } } },
      maxConcurrency: 2,
      observedState: 'idle',
    });
    await running.store.upsertWorker({
      id: 'planner-b',
      capabilities: ['code', 'docs'],
      agentCommandConfigured: true,
      inventory: { tools: { node: { ok: true } } },
      maxConcurrency: 2,
      observedState: 'idle',
    });

    const planned = await client.planDistributedTask({
      title: 'distributed docs task',
      prompt: 'Create a large implementation plan and final report.',
      mode: 'map_reduce',
      subtasks: ['architecture: inspect architecture', 'docs: write documentation'],
      capabilities: ['code'],
    });
    assert.equal(planned.planner.taskCount, 3);
    assert.equal(planned.dispatchPlan.counts.unassigned, 0);

    const submitted = await client.runDistributedTaskPlan({
      title: 'distributed docs task',
      prompt: 'Create a large implementation plan and final report.',
      mode: 'map_reduce',
      subtasks: ['architecture: inspect architecture', 'docs: write documentation'],
      capabilities: ['code'],
      requireRoutable: true,
    });
    assert.equal(submitted.batch.totalTasks, 3);
    const final = submitted.tasks.find((task) => task.batchKey === 'final_synthesis');
    assert.equal(final.status, 'blocked');
    assert.deepEqual(final.dependencyKeys, ['architecture', 'docs']);
    assert.equal(submitted.routing.length, 3);
  } finally {
    await close(running.server);
  }
});

test('CLI planner plan returns distributed plan JSON', async () => {
  const root = await tempDir();
  const token = 'planner-cli-token';
  const running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  try {
    await running.store.upsertWorker({
      id: 'planner-cli-worker',
      capabilities: ['code'],
      agentCommandConfigured: true,
      maxConcurrency: 3,
      observedState: 'idle',
    });
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'planner',
      'plan',
      '--control',
      controlUrl,
      '--prompt',
      'Split this implementation project across workers.',
      '--mode',
      'map_reduce',
      '--subtask',
      'impl: implement',
      '--subtask',
      'verify: verify',
      '--json',
    ], {
      env: { ...process.env, NADO_TOKEN: token },
      timeout: 10_000,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.planner.mode, 'map_reduce');
    assert.equal(result.batch.tasks.at(-1).key, 'final_synthesis');
    assert.equal(result.dispatchPlan.counts.unassigned, 0);
  } finally {
    await close(running.server);
  }
});
