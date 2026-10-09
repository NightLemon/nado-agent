import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseNvidiaGpuCsv, parseRocmSmiJson } from '../src/inventory.js';
import { normalizeResourceRequirements, parseByteSize, resourceFitForTask } from '../src/resource-model.js';
import { scheduleTask } from '../src/scheduler.js';
import { JsonStore } from '../src/store.js';

function worker(id, {
  cpus,
  memoryGiB,
  gpuName,
  vramGiB,
  platform = 'linux',
  arch = 'x64',
} = {}) {
  return {
    id,
    adminState: 'enabled',
    lastSeenAt: new Date().toISOString(),
    capabilities: ['code', ...(gpuName ? ['gpu'] : [])],
    maxConcurrency: 4,
    inventory: {
      host: {
        platform,
        arch,
        cpus,
        totalmem: memoryGiB * 1024 ** 3,
      },
      tools: {
        ...(gpuName ? { nvidiaSmi: { available: true, version: `${gpuName}, ${vramGiB * 1024} MiB` } } : {}),
      },
      resources: {
        gpus: gpuName ? [{
          index: 0,
          vendor: 'nvidia',
          name: gpuName,
          memoryTotalBytes: vramGiB * 1024 ** 3,
        }] : [],
      },
    },
  };
}

test('byte sizes and NVIDIA inventory are normalized into structured resources', () => {
  assert.equal(parseByteSize('16GiB'), 16 * 1024 ** 3);
  assert.equal(parseByteSize('12000MiB'), 12000 * 1024 ** 2);
  assert.deepEqual(parseNvidiaGpuCsv('0, NVIDIA RTX 4090, 24564, 22000, 57, 13'), [{
    index: 0,
    vendor: 'nvidia',
    name: 'NVIDIA RTX 4090',
    memoryTotalBytes: 24564 * 1024 ** 2,
    memoryFreeBytes: 22000 * 1024 ** 2,
    temperatureC: 57,
    utilizationPercent: 13,
  }]);
});

test('scheduler admits workers by CPU RAM GPU model and VRAM and accounts for reservations', () => {
  const small = worker('small', { cpus: 4, memoryGiB: 8 });
  const homeGpu = worker('home-gpu', { cpus: 16, memoryGiB: 64, gpuName: 'NVIDIA RTX 4090', vramGiB: 24 });
  const first = {
    id: 'first',
    title: 'large local inference',
    status: 'queued',
    requiredResources: {
      cpuCores: 8,
      memory: '24GiB',
      gpuCount: 1,
      gpuMemory: '16GiB',
      gpuModel: '4090',
    },
  };
  const selected = scheduleTask({ task: first, workers: [small, homeGpu], tasks: [] });
  assert.equal(selected.workerId, 'home-gpu');
  assert.deepEqual(selected.requiredResources, {
    cpuCores: 8,
    memoryBytes: 24 * 1024 ** 3,
    gpuCount: 1,
    gpuMemoryBytes: 16 * 1024 ** 3,
    gpuModel: '4090',
  });
  assert.ok(selected.candidates.find((item) => item.workerId === 'small').reasons.some((reason) => /capabilities|CPU|memory|GPU/.test(reason)));

  const reserved = { ...first, requestedWorkerId: 'home-gpu' };
  const second = {
    id: 'second',
    title: 'another inference',
    status: 'queued',
    requiredResources: { cpuCores: 10, memory: '48GiB', gpuCount: 1, gpuMemory: '12GiB' },
  };
  const fit = resourceFitForTask(second, homeGpu, [reserved]);
  assert.equal(fit.eligible, false);
  assert.ok(fit.reasons.some((reason) => reason.startsWith('insufficient CPU cores')));
  assert.ok(fit.reasons.some((reason) => reason.startsWith('insufficient memory bytes')));
  assert.ok(fit.reasons.some((reason) => reason.startsWith('insufficient GPU count')));
});

test('scheduler normalizes and enforces operating-system and CPU-architecture requirements', () => {
  const linuxX64 = worker('linux-x64', { cpus: 8, memoryGiB: 32 });
  const macArm64 = worker('mac-arm64', {
    cpus: 12,
    memoryGiB: 48,
    platform: 'darwin',
    arch: 'arm64',
  });
  const task = {
    id: 'mac-build',
    title: 'build an Apple Silicon binary',
    status: 'queued',
    requiredResources: { platform: 'macOS', architecture: 'aarch64' },
  };
  const selected = scheduleTask({ task, workers: [linuxX64, macArm64], tasks: [] });
  assert.equal(selected.workerId, 'mac-arm64');
  assert.deepEqual(selected.requiredResources, { platform: 'darwin', arch: 'arm64' });
  assert.ok(selected.candidates.find((item) => item.workerId === 'linux-x64').reasons.some((reason) => (
    reason === 'platform mismatch: needs darwin, worker reports linux'
  )));
  assert.ok(selected.candidates.find((item) => item.workerId === 'linux-x64').reasons.some((reason) => (
    reason === 'CPU architecture mismatch: needs arm64, worker reports x64'
  )));

  const unknownHost = worker('unknown-host', { cpus: 4, memoryGiB: 8 });
  delete unknownHost.inventory.host.platform;
  delete unknownHost.inventory.host.arch;
  const unknownFit = resourceFitForTask(task, unknownHost, []);
  assert.equal(unknownFit.eligible, false);
  assert.ok(unknownFit.reasons.includes('platform inventory unavailable'));
  assert.ok(unknownFit.reasons.includes('CPU architecture inventory unavailable'));
  assert.throws(
    () => normalizeResourceRequirements({ platform: '../darwin' }),
    /platform must be a platform or architecture identifier/,
  );
});

test('scheduler admits AMD ROCm devices by model and VRAM through the vendor-neutral resource path', () => {
  const [amdGpu] = parseRocmSmiJson(JSON.stringify({
    card0: {
      'Card series': 'AMD Instinct MI210',
      'VRAM Total Memory': '64 GiB',
      'VRAM Total Used Memory': '2 GiB',
      'Temperature (Sensor edge) (C)': '51',
      'GPU use (%)': '7',
    },
  }));
  const amdWorker = {
    id: 'home-amd',
    adminState: 'enabled',
    lastSeenAt: new Date().toISOString(),
    capabilities: ['code', 'gpu'],
    maxConcurrency: 1,
    inventory: {
      host: { cpus: 24, totalmem: 128 * 1024 ** 3 },
      tools: { rocmSmi: { available: true, version: 'ROCm-SMI 6' } },
      resources: { gpus: [amdGpu] },
    },
  };
  const task = {
    id: 'amd-inference',
    title: 'ROCm inference',
    status: 'queued',
    requiredResources: { gpuCount: 1, gpuMemory: '48GiB', gpuModel: 'MI210' },
  };
  const selected = scheduleTask({
    task,
    workers: [worker('cpu-only', { cpus: 8, memoryGiB: 32 }), amdWorker],
    tasks: [],
  });
  assert.equal(selected.workerId, 'home-amd');
  const fit = resourceFitForTask(task, amdWorker, []);
  assert.equal(fit.eligible, true);
  assert.equal(fit.capacity.gpus[0].vendor, 'amd');
  assert.equal(fit.capacity.gpuMemoryBytes, 64 * 1024 ** 3);
});

test('worker claim rechecks explicit resource constraints and sessions pass resource defaults to tasks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-resource-claim-'));
  const store = new JsonStore(JsonStore.defaultPath(root));
  try {
    await store.load();
    await store.upsertWorker(worker('small', { cpus: 4, memoryGiB: 8 }));
    const impossible = await store.createTask({
      workerId: 'small',
      command: 'echo impossible',
      requiredResources: { platform: 'windows', arch: 'arm64', cpuCores: 8, memory: '16GiB' },
    });
    assert.equal((await store.claimTask('small')), null);
    assert.ok(impossible.scheduler.candidates[0].reasons.some((reason) => reason.startsWith('insufficient CPU cores')));
    assert.ok(impossible.scheduler.candidates[0].reasons.some((reason) => reason.startsWith('platform mismatch')));
    assert.ok(impossible.scheduler.candidates[0].reasons.some((reason) => reason.startsWith('CPU architecture mismatch')));
    const decorated = store.getWorker('small');
    assert.equal(decorated.resources.reservations.used.cpuCores, 0);
    assert.equal(decorated.resources.reservations.available.cpuCores, 4);

    const session = await store.createSession({
      title: 'heavy session',
      requiredResources: { platform: 'linux', architecture: 'amd64', cpuCores: 2, memory: '4GiB' },
    });
    const inherited = await store.createTask({
      sessionId: session.id,
      command: 'echo inherited',
    });
    assert.deepEqual(inherited.requiredResources, {
      platform: 'linux',
      arch: 'x64',
      cpuCores: 2,
      memoryBytes: 4 * 1024 ** 3,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
