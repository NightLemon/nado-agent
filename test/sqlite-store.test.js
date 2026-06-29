import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStore, SQLiteStore, createStore } from '../src/store.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-sqlite-store-'));
}

test('SQLiteStore persists the normal control state contract', async () => {
  const dir = await tempDir();
  const file = SQLiteStore.defaultPath(dir);
  const store = new SQLiteStore(file);
  await store.load();
  await store.upsertWorker({
    id: 'sqlite-worker',
    capabilities: ['code'],
    labels: { zone: 'sqlite' },
    maxConcurrency: 2,
    observedState: 'idle',
  });
  const created = await store.createTask({
    title: 'sqlite persisted task',
    command: 'echo sqlite',
    requiredCapabilities: ['code'],
  });
  await store.createWorkerToken({ workerId: 'sqlite-worker', label: 'sqlite token' });

  const reloaded = new SQLiteStore(file);
  await reloaded.load();
  assert.equal(reloaded.getTask(created.id).title, 'sqlite persisted task');
  assert.equal(reloaded.getTask(created.id).scheduler.workerId, 'sqlite-worker');
  assert.equal(reloaded.getWorker('sqlite-worker').labels.zone, 'sqlite');
  assert.equal(reloaded.listWorkerTokens({ workerId: 'sqlite-worker' }).length, 1);

  const compacted = await reloaded.compact();
  assert.equal(compacted.backend, 'sqlite');
  assert.equal(compacted.compacted, true);
});

test('SQLiteStore imports existing JSON state on first load', async () => {
  const dir = await tempDir();
  const json = new JsonStore(JsonStore.defaultPath(dir));
  await json.load();
  await json.upsertWorker({
    id: 'json-worker',
    capabilities: ['docs'],
    observedState: 'idle',
  });

  const sqlite = createStore({ dataDir: dir, backend: 'sqlite' });
  await sqlite.load();
  assert.equal(sqlite.getWorker('json-worker').id, 'json-worker');

  const reloaded = createStore({ dataDir: dir, backend: 'sqlite' });
  await reloaded.load();
  assert.equal(reloaded.getWorker('json-worker').capabilities[0], 'docs');
});
