import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAutoRecoveryOfflineMs,
  startOfflineRecoverySupervisor,
} from '../src/recovery-supervisor.js';

test('automatic recovery is opt-in and enforces a conservative offline grace period', () => {
  assert.equal(normalizeAutoRecoveryOfflineMs(undefined), 0);
  assert.equal(normalizeAutoRecoveryOfflineMs(0), 0);
  assert.equal(normalizeAutoRecoveryOfflineMs(1_000), 60_000);
  assert.equal(normalizeAutoRecoveryOfflineMs(120_000), 120_000);
});

test('recovery supervisor requeues only candidates beyond its configured grace period', async () => {
  const calls = [];
  const supervisor = startOfflineRecoverySupervisor({
    offlineAfterMs: 120_000,
    scanIntervalMs: 60_000,
    store: {
      async recoverOfflineTasks(options) {
        calls.push(options);
        return { recovered: [{ id: 'task-1' }], skipped: [] };
      },
    },
  });

  const result = await supervisor.run();
  supervisor.stop();

  assert.equal(result.recovered.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'requeue');
  assert.equal(calls[0].minOfflineMs, 120_000);
  assert.equal(calls[0].includeExpiredLeases, true);
  assert.equal(calls[0].sessionRecovery, 'same-worker');
  assert.equal(supervisor.summary().deliverySemantics, 'at-least-once');
  assert.equal(supervisor.summary().taskLeases, true);
  assert.equal(supervisor.summary().boundedRetries, true);
  assert.equal(supervisor.summary().sessionTasksAutomaticRecovery, 'same-worker-only');
});
