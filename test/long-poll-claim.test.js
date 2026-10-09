import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-long-poll-'));
  const token = 'long-poll-token';
  const running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const client = new NadoClient({ controlUrl: `http://127.0.0.1:${running.port}`, token });
  await client.registerWorker({ id: 'waiting-worker', capabilities: ['code'], maxConcurrency: 1 });
  return { root, client, ...running };
}

test('long-poll claim wakes promptly when a compatible task is created', async () => {
  const { root, client, server } = await fixture();
  try {
    const started = Date.now();
    const pending = client.claimTask('waiting-worker', { waitMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const created = await client.createTask({
      title: 'wake waiter',
      command: 'echo wake',
      workerId: 'waiting-worker',
    });
    const claimed = await pending;
    assert.equal(claimed.task.id, created.task.id);
    assert.equal(claimed.claim.longPoll, true);
    assert.ok(claimed.claim.waitedMs < 1_500);
    assert.ok(Date.now() - started < 1_500);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('long-poll claim returns empty after its bounded timeout', async () => {
  const { root, client, server } = await fixture();
  try {
    const started = Date.now();
    const result = await client.claimTask('waiting-worker', { waitMs: 150 });
    const elapsed = Date.now() - started;
    assert.equal(result.task, null);
    assert.equal(result.claim.longPoll, true);
    assert.equal(result.claim.waitMs, 150);
    assert.ok(result.claim.waitedMs >= 100);
    assert.ok(result.claim.waitedMs <= elapsed);
    assert.ok(elapsed >= 100);
    assert.ok(elapsed < 5_000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
