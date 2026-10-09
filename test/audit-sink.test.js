import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuditNdjsonSink } from '../src/audit-sink.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-audit-sink-'));
}

test('external audit sink serializes NDJSON and exposes only path-free health', async () => {
  const root = await makeTempDir();
  const file = path.join(root, 'external', 'audit.ndjson');
  const sink = createAuditNdjsonSink({ file });
  try {
    await Promise.all([
      sink.write({ id: 'audit_1', statusCode: 201 }),
      sink.write({ id: 'audit_2', statusCode: 401 }),
      sink.write({ id: 'audit_3', statusCode: 429 }),
    ]);
    await sink.close();

    const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.id), ['audit_1', 'audit_2', 'audit_3']);
    assert.deepEqual(sink.summary(), {
      enabled: true,
      type: 'ndjson_file',
      state: 'healthy',
      deliveryIntegrity: 'complete',
      writtenEvents: 3,
      failedEvents: 0,
      droppedEvents: 0,
      pendingWrites: 0,
      maxPendingWrites: 1024,
      lastSuccessAt: sink.summary().lastSuccessAt,
      lastErrorAt: null,
      lastErrorCode: null,
      pathExposed: false,
    });
    assert.ok(sink.summary().lastSuccessAt);
    assert.doesNotMatch(JSON.stringify(sink.summary()), new RegExp(root.replaceAll('\\', '\\\\')));
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('external audit sink recovers after a write failure without poisoning its queue', async () => {
  const root = await makeTempDir();
  const file = path.join(root, 'audit.ndjson');
  const sink = createAuditNdjsonSink({ file });
  try {
    await fs.mkdir(file);
    await assert.rejects(() => sink.write({ id: 'cannot-write' }));
    assert.equal(sink.summary().state, 'degraded');
    assert.equal(sink.summary().failedEvents, 1);
    assert.ok(sink.summary().lastErrorCode);

    await fs.rm(file, { recursive: true, force: true });
    await sink.write({ id: 'recovered' });
    await sink.close();
    assert.equal(JSON.parse((await fs.readFile(file, 'utf8')).trim()).id, 'recovered');
    assert.equal(sink.summary().state, 'healthy');
    assert.equal(sink.summary().deliveryIntegrity, 'incomplete');
    assert.equal(sink.summary().writtenEvents, 1);
    assert.equal(sink.summary().failedEvents, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('external audit sink bounds a stalled queue and reports mirror gaps', async () => {
  const root = await makeTempDir();
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let writes = 0;
  const sink = createAuditNdjsonSink({
    file: path.join(root, 'audit.ndjson'),
    maxPendingWrites: 2,
    appendLine: async () => {
      writes += 1;
      if (writes === 1) {
        await firstBlocked;
      }
    },
  });
  try {
    const first = sink.write({ id: 'first' });
    const second = sink.write({ id: 'second' });
    await assert.rejects(
      () => sink.write({ id: 'dropped' }),
      (error) => error.code === 'AUDIT_SINK_QUEUE_FULL',
    );
    assert.equal(sink.summary().pendingWrites, 2);
    assert.equal(sink.summary().droppedEvents, 1);
    assert.equal(sink.summary().deliveryIntegrity, 'incomplete');
    assert.equal(sink.summary().lastErrorCode, 'AUDIT_SINK_QUEUE_FULL');

    releaseFirst();
    await Promise.all([first, second]);
    await sink.close();
    assert.equal(writes, 2);
    assert.equal(sink.summary().state, 'healthy');
    assert.equal(sink.summary().deliveryIntegrity, 'incomplete');
    assert.equal(sink.summary().pendingWrites, 0);
    assert.equal(sink.summary().maxPendingWrites, 2);
  } finally {
    releaseFirst();
    await fs.rm(root, { recursive: true, force: true });
  }
});
