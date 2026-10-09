import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function statValue(value) {
  return typeof value === 'bigint' ? value : BigInt(Math.max(0, Number(value || 0)));
}

export function cpuTimesSnapshot(cpus = []) {
  return (Array.isArray(cpus) ? cpus : []).reduce((snapshot, cpu) => {
    const times = cpu?.times || {};
    const idle = Math.max(0, finiteNumber(times.idle, 0));
    const total = ['user', 'nice', 'sys', 'idle', 'irq']
      .reduce((sum, key) => sum + Math.max(0, finiteNumber(times[key], 0)), 0);
    snapshot.idle += idle;
    snapshot.total += total;
    snapshot.logicalCores += 1;
    return snapshot;
  }, { idle: 0, total: 0, logicalCores: 0 });
}

export function cpuUtilizationBetween(previous, current) {
  if (!previous || !current) {
    return null;
  }
  const totalDelta = Number(current.total || 0) - Number(previous.total || 0);
  const idleDelta = Number(current.idle || 0) - Number(previous.idle || 0);
  if (!Number.isFinite(totalDelta) || !Number.isFinite(idleDelta) || totalDelta <= 0) {
    return null;
  }
  const percent = ((totalDelta - Math.max(0, idleDelta)) / totalDelta) * 100;
  return Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10;
}

export function createHostUsageSampler(options = {}) {
  const readCpus = options.readCpus || (() => os.cpus());
  const readLoadavg = options.readLoadavg || (() => os.loadavg());
  const readTotalmem = options.readTotalmem || (() => os.totalmem());
  const readFreemem = options.readFreemem || (() => os.freemem());
  let previousCpu = null;
  return () => {
    const currentCpu = cpuTimesSnapshot(readCpus());
    const totalBytes = Math.max(0, finiteNumber(readTotalmem(), 0));
    const freeBytes = Math.max(0, Math.min(totalBytes, finiteNumber(readFreemem(), 0)));
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const loadavg = readLoadavg().map((value) => Math.max(0, finiteNumber(value, 0))).slice(0, 3);
    const usage = {
      cpu: {
        logicalCores: currentCpu.logicalCores,
        utilizationPercent: cpuUtilizationBetween(previousCpu, currentCpu),
        loadAverage1m: loadavg[0] ?? 0,
        loadAverage5m: loadavg[1] ?? 0,
        loadAverage15m: loadavg[2] ?? 0,
        measurement: 'delta of operating-system CPU time counters since previous Worker sample',
      },
      memory: {
        totalBytes,
        freeBytes,
        usedBytes,
        usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1_000) / 10 : null,
        measurement: 'operating-system total and free memory at Worker sample time',
      },
      loadavg,
    };
    previousCpu = currentCpu;
    return usage;
  };
}

export function diskMetricsFromStatFs(stat = {}, targetPath = '') {
  const blockSize = statValue(stat.bsize || stat.frsize || 0);
  const totalBytes = statValue(stat.blocks) * blockSize;
  const freeBytes = statValue(stat.bfree) * blockSize;
  const availableBlocks = stat.bavail === undefined || stat.bavail === null ? statValue(stat.bfree) : statValue(stat.bavail);
  const availableBytes = availableBlocks * blockSize;
  const usedBytes = totalBytes > freeBytes ? totalBytes - freeBytes : 0n;
  const usedPercent = totalBytes > 0n
    ? Math.round((Number(usedBytes) / Number(totalBytes)) * 1_000) / 10
    : null;
  return {
    path: targetPath,
    totalBytes: Number(totalBytes),
    freeBytes: Number(freeBytes),
    availableBytes: Number(availableBytes),
    usedBytes: Number(usedBytes),
    usedPercent,
  };
}

export async function collectDiskMetrics(dataDir) {
  const targetPath = path.resolve(dataDir || '.nado');
  try {
    await fs.mkdir(targetPath, { recursive: true });
    const stat = await fs.statfs(targetPath, { bigint: true });
    return {
      ...diskMetricsFromStatFs(stat, targetPath),
      available: true,
      collectedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      path: targetPath,
      available: false,
      error: error.code || error.message,
      collectedAt: new Date().toISOString(),
    };
  }
}

export async function collectWorkerMetrics(options = {}) {
  const disk = await collectDiskMetrics(options.dataDir);
  const control = options.control || {};
  const usage = options.hostUsageSampler
    ? options.hostUsageSampler()
    : createHostUsageSampler()();
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: usage.cpu,
    memory: usage.memory,
    loadavg: usage.loadavg,
    totalmem: usage.memory.totalBytes,
    freemem: usage.memory.freeBytes,
    uptime: os.uptime(),
    pid: process.pid,
    disk,
    control: {
      roundTripMs: finiteNumber(control.roundTripMs),
      lastSuccessAt: control.lastSuccessAt || null,
      lastErrorAt: control.lastErrorAt || null,
      consecutiveErrors: Math.max(0, Math.floor(finiteNumber(control.consecutiveErrors, 0))),
      measurement: 'previous successful heartbeat request/response',
      bandwidth: control.bandwidth || {
        available: false,
        error: 'not_measured',
      },
    },
    collectedAt: new Date().toISOString(),
  };
}
