import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOrderedTaskEventReporter,
  reconnectDelay,
  reportTaskCompletionWithRetry,
  reportWorkerEventWithRetry,
} from '../src/worker-client.js';

test('worker reconnect delay grows exponentially and caps at the configured maximum', () => {
  const options = { baseMs: 1_000, maxMs: 8_000, jitterRatio: 0 };
  assert.equal(reconnectDelay(1, options), 1_000);
  assert.equal(reconnectDelay(2, options), 2_000);
  assert.equal(reconnectDelay(4, options), 8_000);
  assert.equal(reconnectDelay(8, options), 8_000);
});

test('worker reconnect jitter stays within the configured range', () => {
  const low = reconnectDelay(3, { baseMs: 1_000, maxMs: 30_000, jitterRatio: 0.25, random: () => 0 });
  const high = reconnectDelay(3, { baseMs: 1_000, maxMs: 30_000, jitterRatio: 0.25, random: () => 1 });
  assert.equal(low, 3_000);
  assert.equal(high, 5_000);
});

test('task completion delivery retries transient failures and recovers', async () => {
  let calls = 0;
  const retries = [];
  const client = {
    async completeTask(taskId, result) {
      calls += 1;
      assert.equal(taskId, 'task-retry');
      assert.equal(result.attemptId, 'attempt-retry');
      if (calls < 3) {
        const error = new Error(`temporary failure ${calls}`);
        error.status = calls === 1 ? 599 : 429;
        throw error;
      }
      return {
        task: {
          status: 'succeeded',
          events: [{ type: 'succeeded', data: { attemptId: 'attempt-retry' } }],
        },
      };
    },
  };

  const delivery = await reportTaskCompletionWithRetry(
    client,
    { id: 'task-retry', currentAttemptId: 'attempt-retry' },
    { status: 'succeeded', exitCode: 0 },
    {
      maxRetries: 3,
      retryBaseMs: 1,
      retryMaxMs: 1,
      jitterRatio: 0,
      onRetry: (entry) => retries.push(entry),
    },
  );

  assert.equal(calls, 3);
  assert.equal(delivery.attempts, 3);
  assert.equal(delivery.accepted, true);
  assert.equal(retries.length, 2);
});

test('task completion delivery does not retry permanent authorization errors', async () => {
  let calls = 0;
  const client = {
    async completeTask() {
      calls += 1;
      const error = new Error('forbidden');
      error.status = 403;
      throw error;
    },
  };

  await assert.rejects(
    () => reportTaskCompletionWithRetry(
      client,
      { id: 'task-forbidden', currentAttemptId: 'attempt-forbidden' },
      { status: 'succeeded', exitCode: 0 },
      { maxRetries: 5, retryBaseMs: 1, retryMaxMs: 1, jitterRatio: 0 },
    ),
    (error) => error.status === 403 && error.deliveryAttempts === 1,
  );
  assert.equal(calls, 1);
});

test('Worker event delivery keeps one id across transient retries', async () => {
  const received = [];
  const retries = [];
  const delivery = await reportWorkerEventWithRetry({
    async addWorkerEvent(workerId, event) {
      received.push({ workerId, event });
      if (received.length === 1) {
        const error = new Error('response lost after transient gateway failure');
        error.status = 503;
        throw error;
      }
      return { event };
    },
  }, 'home-worker', {
    type: 'task_released',
    data: { taskId: 'task-release', attemptId: 'attempt-release' },
  }, {
    maxRetries: 2,
    retryBaseMs: 1,
    retryMaxMs: 1,
    jitterRatio: 0,
    onRetry: (entry) => retries.push(entry),
  });

  assert.equal(delivery.attempts, 2);
  assert.match(delivery.eventId, /^wev_[a-f0-9]{32}$/);
  assert.equal(received.length, 2);
  assert.equal(received[0].workerId, 'home-worker');
  assert.equal(received[0].event.id, received[1].event.id);
  assert.equal(retries[0].eventId, delivery.eventId);
});

test('task event retry and reporter preserve event identity and output order', async () => {
  const calls = [];
  let failedOnce = false;
  const client = {
    async addTaskEvent(taskId, event) {
      calls.push({ taskId, event });
      if (!failedOnce) {
        failedOnce = true;
        const error = new Error('temporary event transport failure');
        error.status = 503;
        throw error;
      }
      return { event };
    },
  };
  const task = { id: 'task-events', currentAttemptId: 'attempt-events' };
  const reporter = createOrderedTaskEventReporter(client, task, {
    workerId: 'home-worker',
    maxRetries: 2,
    retryBaseMs: 1,
    retryMaxMs: 1,
    jitterRatio: 0,
  });
  const first = reporter.send({ type: 'stdout', message: 'first' });
  const second = reporter.send({ type: 'stderr', message: 'second' });
  const results = await Promise.all([first, second]);
  const flush = await reporter.flush();

  assert.equal(results.every((result) => result.delivered), true);
  assert.equal(flush.gap, null);
  assert.deepEqual(calls.map((entry) => entry.event.data.sequence), [1, 1, 2]);
  assert.equal(calls[0].event.id, calls[1].event.id);
  assert.notEqual(calls[1].event.id, calls[2].event.id);
  assert.equal(calls[2].event.workerId, 'home-worker');
  assert.equal(calls[2].event.attemptId, 'attempt-events');
});

test('ordered task event reporter bounds its queue and emits a durable gap summary', async () => {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const events = [];
  const client = {
    async addTaskEvent(taskId, event) {
      events.push(event);
      if (event.type === 'stdout') {
        await firstBlocked;
      }
      return { event };
    },
  };
  const reporter = createOrderedTaskEventReporter(
    client,
    { id: 'task-bounded-events', currentAttemptId: 'attempt-bounded-events' },
    { workerId: 'home-worker', maxPending: 1, maxRetries: 1 },
  );
  const first = reporter.send({ type: 'stdout', message: 'persist me' });
  const dropped = await reporter.send({ type: 'stderr', message: 'bounded overflow' });
  assert.equal(dropped.dropped, true);
  releaseFirst();
  await first;
  const flush = await reporter.flush();

  assert.equal(flush.delivered, true);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'output_delivery_gap');
  assert.equal(events[1].data.missingEventCount, 1);
  assert.equal(events[1].data.firstMissingSequence, 2);
  assert.deepEqual(events[1].data.reasons, ['queue_full']);
});

test('ordered task event reporter short-circuits a failed queue before sending one gap summary', async () => {
  const events = [];
  const client = {
    async addTaskEvent(taskId, event) {
      events.push(event);
      if (event.type !== 'output_delivery_gap') {
        const error = new Error('control unavailable for live output');
        error.status = 503;
        throw error;
      }
      return { event };
    },
  };
  const reporter = createOrderedTaskEventReporter(
    client,
    { id: 'task-circuit-events', currentAttemptId: 'attempt-circuit-events' },
    { workerId: 'home-worker', maxPending: 8, maxRetries: 1 },
  );
  const results = await Promise.all([
    reporter.send({ type: 'stdout', message: 'first missing chunk' }),
    reporter.send({ type: 'stdout', message: 'second missing chunk' }),
    reporter.send({ type: 'stderr', message: 'third missing chunk' }),
  ]);
  const flush = await reporter.flush();

  assert.equal(results[0].delivered, false);
  assert.equal(results[1].shortCircuited, true);
  assert.equal(results[2].shortCircuited, true);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'output_delivery_gap');
  assert.equal(events[1].data.missingEventCount, 3);
  assert.deepEqual(events[1].data.reasons, ['delivery_failed', 'delivery_short_circuited']);
  assert.equal(flush.delivered, true);
});

test('task completion delivery identifies rejected and previously accepted attempts', async () => {
  const rejected = await reportTaskCompletionWithRetry(
    {
      async completeTask() {
        return {
          task: {
            status: 'running',
            events: [{
              type: 'expired_lease_result_ignored',
              data: { resultAttemptId: 'attempt-expired' },
            }],
          },
        };
      },
    },
    { id: 'task-expired', currentAttemptId: 'attempt-expired' },
    { status: 'succeeded', exitCode: 0 },
    { maxRetries: 1 },
  );
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.rejectionEvent.type, 'expired_lease_result_ignored');

  const replayed = await reportTaskCompletionWithRetry(
    {
      async completeTask() {
        return {
          task: {
            status: 'succeeded',
            events: [
              { type: 'succeeded', data: { attemptId: 'attempt-replayed' } },
              { type: 'late_result_ignored', data: { resultAttemptId: 'attempt-replayed' } },
            ],
          },
        };
      },
    },
    { id: 'task-replayed', currentAttemptId: 'attempt-replayed' },
    { status: 'succeeded', exitCode: 0 },
    { maxRetries: 1 },
  );
  assert.equal(replayed.accepted, true);
});
