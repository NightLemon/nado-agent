import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

export const CONTROL_DATA_LEASE_DIRECTORY = '.nado-control-lease';
const OWNER_FILE = 'owner.json';
const HEARTBEAT_FILE_PREFIX = 'heartbeat-';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function leaseError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function publicOwner(owner) {
  if (!owner || typeof owner !== 'object') {
    return null;
  }
  return {
    controlInstanceId: owner.controlInstanceId || null,
    hostname: owner.hostname || null,
    pid: Number.isInteger(owner.pid) ? owner.pid : null,
    acquiredAt: owner.acquiredAt || null,
  };
}

async function observedLease(lockDirectory) {
  const owner = await readJson(path.join(lockDirectory, OWNER_FILE));
  const heartbeat = owner?.leaseId
    ? await statOrNull(path.join(lockDirectory, `${HEARTBEAT_FILE_PREFIX}${owner.leaseId}`))
    : null;
  const directory = heartbeat || await statOrNull(lockDirectory);
  const observedAtMs = directory?.mtimeMs || 0;
  return {
    owner,
    observedAtMs,
    ageMs: observedAtMs ? Math.max(0, Date.now() - observedAtMs) : Number.POSITIVE_INFINITY,
  };
}

export class ControlDataLease {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.lockDirectory = options.lockDirectory;
    this.leaseId = options.leaseId;
    this.owner = options.owner;
    this.timeoutMs = options.timeoutMs;
    this.heartbeatMs = options.heartbeatMs;
    this.heartbeatFile = options.heartbeatFile;
    this.timer = null;
    this.closed = false;
    this.lost = false;
    this.onLost = null;
  }

  start() {
    this.timer = setInterval(() => {
      void this.refresh().catch((error) => this.markLost(error));
    }, this.heartbeatMs);
    this.timer.unref?.();
    return this;
  }

  setOnLost(callback) {
    this.onLost = typeof callback === 'function' ? callback : null;
    if (this.lost && this.onLost) {
      queueMicrotask(() => this.onLost(this.lost));
    }
  }

  summary() {
    return {
      enabled: true,
      status: this.lost ? 'lost' : this.closed ? 'released' : 'owned',
      controlInstanceId: this.owner.controlInstanceId,
      acquiredAt: this.owner.acquiredAt,
      heartbeatMs: this.heartbeatMs,
      timeoutMs: this.timeoutMs,
      writeFencing: true,
    };
  }

  async currentOwner() {
    return readJson(path.join(this.lockDirectory, OWNER_FILE));
  }

  async assertOwned() {
    if (this.closed || this.lost) {
      throw leaseError(
        'Control data-directory lease is no longer owned; refusing to persist state',
        'NADO_CONTROL_DATA_LEASE_LOST',
        { owner: publicOwner(await this.currentOwner()) },
      );
    }
    const owner = await this.currentOwner();
    if (owner?.leaseId !== this.leaseId) {
      const error = leaseError(
        'Control data-directory lease changed owners; refusing to persist stale state',
        'NADO_CONTROL_DATA_LEASE_LOST',
        { owner: publicOwner(owner) },
      );
      this.markLost(error);
      throw error;
    }
    return true;
  }

  async refresh() {
    await this.assertOwned();
    const now = new Date();
    await fs.utimes(this.heartbeatFile, now, now);
  }

  markLost(error) {
    if (this.lost || this.closed) {
      return;
    }
    this.lost = error || leaseError(
      'Control data-directory lease was lost',
      'NADO_CONTROL_DATA_LEASE_LOST',
    );
    clearInterval(this.timer);
    this.timer = null;
    this.onLost?.(this.lost);
  }

  async release() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;

    const owner = await this.currentOwner().catch(() => null);
    if (owner?.leaseId !== this.leaseId) {
      return;
    }

    const released = `${this.lockDirectory}.released-${this.leaseId}`;
    let renamed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await fs.rename(this.lockDirectory, released);
        renamed = true;
        break;
      } catch (error) {
        if (error.code === 'ENOENT') {
          return;
        }
        if (error.code !== 'EPERM' && error.code !== 'EBUSY') {
          throw error;
        }
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!renamed) {
      throw lastError;
    }
    await fs.rm(released, { recursive: true, force: true });
  }
}

async function createLeaseDirectory(dataDir, options) {
  const lockDirectory = path.join(dataDir, CONTROL_DATA_LEASE_DIRECTORY);
  const leaseId = crypto.randomUUID();
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  try {
    const owner = {
      format: 'nado-control-data-lease',
      version: 1,
      leaseId,
      controlInstanceId: options.controlInstanceId || null,
      hostname: os.hostname(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      timeoutMs: options.timeoutMs,
    };
    await fs.writeFile(
      path.join(lockDirectory, OWNER_FILE),
      `${JSON.stringify(owner, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    const heartbeatFile = path.join(lockDirectory, `${HEARTBEAT_FILE_PREFIX}${leaseId}`);
    await fs.writeFile(heartbeatFile, `${leaseId}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return new ControlDataLease({
      dataDir,
      lockDirectory,
      leaseId,
      owner,
      timeoutMs: options.timeoutMs,
      heartbeatMs: options.heartbeatMs,
      heartbeatFile,
    }).start();
  } catch (error) {
    await fs.rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function acquireControlDataLease(dataDir, options = {}) {
  const resolvedDataDir = path.resolve(dataDir || '.nado');
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? process.env.NADO_CONTROL_DATA_LEASE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const heartbeatMs = Math.min(
    Math.max(1, timeoutMs - 1),
    positiveInteger(
      options.heartbeatMs ?? process.env.NADO_CONTROL_DATA_LEASE_HEARTBEAT_MS,
      Math.min(DEFAULT_HEARTBEAT_MS, Math.max(1, Math.floor(timeoutMs / 3))),
    ),
  );
  await fs.mkdir(resolvedDataDir, { recursive: true, mode: 0o700 });
  const lockDirectory = path.join(resolvedDataDir, CONTROL_DATA_LEASE_DIRECTORY);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await createLeaseDirectory(resolvedDataDir, {
        controlInstanceId: options.controlInstanceId,
        timeoutMs,
        heartbeatMs,
      });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }

    const observed = await observedLease(lockDirectory);
    if (observed.ageMs <= timeoutMs) {
      throw leaseError(
        `Control data directory is already owned by another live instance; retry after ${Math.max(1, Math.ceil((timeoutMs - observed.ageMs) / 1000))}s`,
        'NADO_CONTROL_DATA_DIR_LOCKED',
        {
          owner: publicOwner(observed.owner),
          ageMs: Math.round(observed.ageMs),
          timeoutMs,
        },
      );
    }

    const staleDirectory = `${lockDirectory}.stale-${crypto.randomUUID()}`;
    try {
      await fs.rename(lockDirectory, staleDirectory);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EEXIST') {
        continue;
      }
      if (error.code === 'EPERM' || error.code === 'EBUSY') {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      throw error;
    }
    await fs.rm(staleDirectory, { recursive: true, force: true }).catch(() => {});
  }
  throw leaseError(
    'Control data-directory lease changed repeatedly during startup; retry after confirming only one Control instance is starting',
    'NADO_CONTROL_DATA_DIR_LOCKED',
  );
}
