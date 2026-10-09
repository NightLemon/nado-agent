const BYTE_UNITS = {
  b: 1,
  kb: 1_000,
  mb: 1_000 ** 2,
  gb: 1_000 ** 3,
  tb: 1_000 ** 4,
  kib: 1_024,
  mib: 1_024 ** 2,
  gib: 1_024 ** 3,
  tib: 1_024 ** 4,
};

const PLATFORM_ALIASES = {
  windows: 'win32',
  win: 'win32',
  mac: 'darwin',
  macos: 'darwin',
  osx: 'darwin',
};

const ARCH_ALIASES = {
  amd64: 'x64',
  'x86-64': 'x64',
  x86_64: 'x64',
  aarch64: 'arm64',
  x86: 'ia32',
  i386: 'ia32',
  i686: 'ia32',
  armv7: 'arm',
  armv7l: 'arm',
};

function finiteNonNegative(value, name, integer = false) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return integer ? Math.ceil(parsed) : parsed;
}

export function parseByteSize(value, name = 'byte size') {
  if (value === undefined || value === null || value === '') {
    return 0;
  }
  if (typeof value === 'number') {
    return Math.ceil(finiteNonNegative(value, name));
  }
  const text = String(value).trim().toLowerCase();
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]i?b|b)?$/i);
  if (!match) {
    throw new Error(`${name} must be bytes or a size such as 16GiB`);
  }
  const unit = match[2] || 'b';
  return Math.ceil(Number(match[1]) * BYTE_UNITS[unit]);
}

function normalizeHostSelector(value, name, aliases) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const text = String(value).trim().toLowerCase();
  const normalized = aliases[text] || text;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error(`${name} must be a platform or architecture identifier`);
  }
  return normalized;
}

function normalizeReportedHostSelector(value, name, aliases) {
  try {
    return normalizeHostSelector(value, name, aliases);
  } catch {
    return null;
  }
}

export function normalizeResourceRequirements(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const cpuCores = finiteNonNegative(value.cpuCores ?? value.cpu ?? value.cores, 'cpuCores');
  const memoryBytes = parseByteSize(value.memoryBytes ?? value.memory ?? value.ramBytes ?? value.ram, 'memoryBytes');
  const gpuMemoryBytes = parseByteSize(
    value.gpuMemoryBytes ?? value.vramBytes ?? value.gpuMemory ?? value.vram,
    'gpuMemoryBytes',
  );
  const gpuModel = String(value.gpuModel || value.acceleratorModel || '').trim() || null;
  const platform = normalizeHostSelector(
    value.platform ?? value.os ?? value.operatingSystem,
    'platform',
    PLATFORM_ALIASES,
  );
  const arch = normalizeHostSelector(
    value.arch ?? value.architecture ?? value.cpuArchitecture,
    'arch',
    ARCH_ALIASES,
  );
  let gpuCount = finiteNonNegative(value.gpuCount ?? value.gpus, 'gpuCount', true);
  if (!gpuCount && (gpuMemoryBytes || gpuModel)) {
    gpuCount = 1;
  }
  return {
    ...(platform ? { platform } : {}),
    ...(arch ? { arch } : {}),
    ...(cpuCores ? { cpuCores } : {}),
    ...(memoryBytes ? { memoryBytes } : {}),
    ...(gpuCount ? { gpuCount } : {}),
    ...(gpuMemoryBytes ? { gpuMemoryBytes } : {}),
    ...(gpuModel ? { gpuModel } : {}),
  };
}

export function taskResourceRequirements(task = {}) {
  return normalizeResourceRequirements(task.requiredResources || task.resources || {});
}

export function resourceRequirementsEmpty(required = {}) {
  return !required.platform
    && !required.arch
    && !required.cpuCores
    && !required.memoryBytes
    && !required.gpuCount
    && !required.gpuMemoryBytes
    && !required.gpuModel;
}

function parseLegacyNvidiaProbe(worker = {}) {
  const line = String(worker.inventory?.tools?.nvidiaSmi?.version || '');
  if (!worker.inventory?.tools?.nvidiaSmi?.available || !line) {
    return [];
  }
  const memoryMatch = line.match(/([0-9]+(?:\.[0-9]+)?)\s*(MiB|GiB)/i);
  const memoryTotalBytes = memoryMatch
    ? parseByteSize(`${memoryMatch[1]}${memoryMatch[2]}`, 'GPU probe memory')
    : 0;
  const name = line.split(',')[0].trim() || 'NVIDIA GPU';
  return [{ index: 0, vendor: 'nvidia', name, memoryTotalBytes }];
}

export function workerResourceCapacity(worker = {}, options = {}) {
  const host = worker.inventory?.host || {};
  const metrics = worker.metrics || {};
  const structuredGpus = Array.isArray(worker.inventory?.resources?.gpus)
    ? worker.inventory.resources.gpus
    : [];
  const gpus = (structuredGpus.length ? structuredGpus : parseLegacyNvidiaProbe(worker))
    .map((gpu, index) => ({
      index: gpu.index ?? index,
      vendor: gpu.vendor || 'unknown',
      name: gpu.name || `GPU ${index}`,
      memoryTotalBytes: Math.max(0, Number(gpu.memoryTotalBytes || 0)),
      memoryFreeBytes: gpu.memoryFreeBytes === undefined ? null : Math.max(0, Number(gpu.memoryFreeBytes || 0)),
      temperatureC: gpu.temperatureC ?? null,
      utilizationPercent: gpu.utilizationPercent ?? null,
    }));
  const model = String(options.gpuModel || '').trim().toLowerCase();
  const selectedGpus = model
    ? gpus.filter((gpu) => gpu.name.toLowerCase().includes(model))
    : gpus;
  return {
    platform: normalizeReportedHostSelector(host.platform, 'platform', PLATFORM_ALIASES),
    arch: normalizeReportedHostSelector(host.arch, 'arch', ARCH_ALIASES),
    cpuCores: Math.max(0, Number(host.cpus || metrics.cpus || 0)),
    memoryBytes: Math.max(0, Number(host.totalmem || metrics.totalmem || 0)),
    gpuCount: selectedGpus.length,
    gpuMemoryBytes: selectedGpus.reduce((sum, gpu) => sum + gpu.memoryTotalBytes, 0),
    gpus: selectedGpus,
    allGpus: gpus,
  };
}

function addDemand(target, demand) {
  target.cpuCores += Number(demand.cpuCores || 0);
  target.memoryBytes += Number(demand.memoryBytes || 0);
  target.gpuCount += Number(demand.gpuCount || 0);
  target.gpuMemoryBytes += Number(demand.gpuMemoryBytes || 0);
  return target;
}

export function workerResourceUsage(worker, tasks = [], excludeTaskId = null) {
  return tasks
    .filter((task) => task.id !== excludeTaskId)
    .filter((task) => (
      (task.status === 'running' && task.assignedWorkerId === worker.id)
      || (task.status === 'queued'
        && task.requestedWorkerId === worker.id
        && (!task.scheduler || task.scheduler.workerId === worker.id))
    ))
    .reduce((used, task) => addDemand(used, taskResourceRequirements(task)), {
      cpuCores: 0,
      memoryBytes: 0,
      gpuCount: 0,
      gpuMemoryBytes: 0,
    });
}

function availableResources(capacity, used) {
  return {
    cpuCores: Math.max(0, capacity.cpuCores - used.cpuCores),
    memoryBytes: Math.max(0, capacity.memoryBytes - used.memoryBytes),
    gpuCount: Math.max(0, capacity.gpuCount - used.gpuCount),
    gpuMemoryBytes: Math.max(0, capacity.gpuMemoryBytes - used.gpuMemoryBytes),
  };
}

export function resourceFitForTask(task, worker, tasks = [], options = {}) {
  const required = taskResourceRequirements(task);
  const capacity = workerResourceCapacity(worker, { gpuModel: required.gpuModel });
  const used = options.ignoreCurrentCapacity
    ? { cpuCores: 0, memoryBytes: 0, gpuCount: 0, gpuMemoryBytes: 0 }
    : workerResourceUsage(worker, tasks, task.id);
  const available = availableResources(capacity, used);
  const failures = [];

  if (resourceRequirementsEmpty(required)) {
    return { eligible: true, reasons: [], required, capacity, used, available };
  }
  if (required.platform && !capacity.platform) {
    failures.push('platform inventory unavailable');
  } else if (required.platform && required.platform !== capacity.platform) {
    failures.push(`platform mismatch: needs ${required.platform}, worker reports ${capacity.platform}`);
  }
  if (required.arch && !capacity.arch) {
    failures.push('CPU architecture inventory unavailable');
  } else if (required.arch && required.arch !== capacity.arch) {
    failures.push(`CPU architecture mismatch: needs ${required.arch}, worker reports ${capacity.arch}`);
  }
  if (required.cpuCores && !capacity.cpuCores) {
    failures.push('CPU inventory unavailable');
  } else if (required.cpuCores > available.cpuCores) {
    failures.push(`insufficient CPU cores: needs ${required.cpuCores}, available ${available.cpuCores}/${capacity.cpuCores}`);
  }
  if (required.memoryBytes && !capacity.memoryBytes) {
    failures.push('memory inventory unavailable');
  } else if (required.memoryBytes > available.memoryBytes) {
    failures.push(`insufficient memory bytes: needs ${required.memoryBytes}, available ${available.memoryBytes}/${capacity.memoryBytes}`);
  }
  if (required.gpuModel && !capacity.gpuCount) {
    failures.push(`GPU model not available: ${required.gpuModel}`);
  }
  if (required.gpuCount && !capacity.allGpus.length) {
    failures.push('GPU resource inventory unavailable');
  } else if (required.gpuCount > available.gpuCount) {
    failures.push(`insufficient GPU count: needs ${required.gpuCount}, available ${available.gpuCount}/${capacity.gpuCount}`);
  }
  if (required.gpuMemoryBytes && !capacity.gpuMemoryBytes) {
    failures.push('GPU memory inventory unavailable');
  } else if (required.gpuMemoryBytes > available.gpuMemoryBytes) {
    failures.push(`insufficient GPU memory bytes: needs ${required.gpuMemoryBytes}, available ${available.gpuMemoryBytes}/${capacity.gpuMemoryBytes}`);
  }
  const reasons = failures.length
    ? failures
    : [`resources platform=${capacity.platform || 'unknown'} arch=${capacity.arch || 'unknown'} cpu=${available.cpuCores}/${capacity.cpuCores} memory=${available.memoryBytes}/${capacity.memoryBytes} gpu=${available.gpuCount}/${capacity.gpuCount} vram=${available.gpuMemoryBytes}/${capacity.gpuMemoryBytes}`];
  return {
    eligible: failures.length === 0,
    reasons,
    required,
    capacity,
    used,
    available,
  };
}
