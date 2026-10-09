import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectWorkerMetrics,
  cpuTimesSnapshot,
  cpuUtilizationBetween,
  createHostUsageSampler,
  diskMetricsFromStatFs,
} from '../src/worker-metrics.js';

test('disk metrics normalize statfs block counts into operator-friendly bytes', () => {
  const disk = diskMetricsFromStatFs({
    bsize: 4096n,
    blocks: 100n,
    bfree: 40n,
    bavail: 30n,
  }, '/worker-data');
  assert.deepEqual(disk, {
    path: '/worker-data',
    totalBytes: 409_600,
    freeBytes: 163_840,
    availableBytes: 122_880,
    usedBytes: 245_760,
    usedPercent: 60,
  });
});

test('host usage sampler derives cross-platform CPU deltas and memory utilization', () => {
  const snapshots = [
    [
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
      { times: { user: 200, nice: 0, sys: 100, idle: 700, irq: 0 } },
    ],
    [
      { times: { user: 140, nice: 0, sys: 60, idle: 900, irq: 0 } },
      { times: { user: 240, nice: 0, sys: 120, idle: 740, irq: 0 } },
    ],
  ];
  let index = 0;
  const sampler = createHostUsageSampler({
    readCpus: () => snapshots[Math.min(index++, snapshots.length - 1)],
    readLoadavg: () => [1.5, 1, 0.5],
    readTotalmem: () => 1_000,
    readFreemem: () => 250,
  });
  const first = sampler();
  const second = sampler();
  assert.equal(first.cpu.utilizationPercent, null);
  assert.equal(second.cpu.utilizationPercent, 55);
  assert.equal(second.cpu.logicalCores, 2);
  assert.equal(second.cpu.loadAverage1m, 1.5);
  assert.deepEqual(second.memory, {
    totalBytes: 1_000,
    freeBytes: 250,
    usedBytes: 750,
    usedPercent: 75,
    measurement: 'operating-system total and free memory at Worker sample time',
  });
  assert.equal(cpuUtilizationBetween(cpuTimesSnapshot(snapshots[0]), cpuTimesSnapshot(snapshots[1])), 55);
});

test('worker metrics report the data volume and previous control heartbeat health', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-worker-metrics-'));
  try {
    const metrics = await collectWorkerMetrics({
      dataDir: root,
      hostUsageSampler: () => ({
        cpu: {
          logicalCores: 8,
          utilizationPercent: 37.5,
          loadAverage1m: 1.5,
          loadAverage5m: 1,
          loadAverage15m: 0.5,
          measurement: 'test CPU sample',
        },
        memory: {
          totalBytes: 16_000,
          freeBytes: 4_000,
          usedBytes: 12_000,
          usedPercent: 75,
          measurement: 'test memory sample',
        },
        loadavg: [1.5, 1, 0.5],
      }),
      control: {
        roundTripMs: 12.4,
        lastSuccessAt: '2026-08-19T00:00:00.000Z',
        lastErrorAt: '2026-08-18T23:59:00.000Z',
        consecutiveErrors: 2,
        bandwidth: {
          available: true,
          downloadBytesPerSecond: 2_000_000,
          uploadBytesPerSecond: 1_000_000,
        },
      },
    });
    assert.equal(metrics.disk.available, true);
    assert.equal(metrics.disk.path, path.resolve(root));
    assert.ok(metrics.disk.totalBytes > 0);
    assert.ok(metrics.disk.availableBytes >= 0);
    assert.equal(metrics.control.roundTripMs, 12.4);
    assert.equal(metrics.cpu.utilizationPercent, 37.5);
    assert.equal(metrics.memory.usedPercent, 75);
    assert.equal(metrics.control.consecutiveErrors, 2);
    assert.equal(metrics.control.bandwidth.downloadBytesPerSecond, 2_000_000);
    assert.match(metrics.control.measurement, /previous successful heartbeat/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
