import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NADO_VERSION = '0.1.0';
export const NADO_PROTOCOL_VERSION = 1;

let defaultBuildInfoPromise = null;

function safeBuildText(value, maximum = 160) {
  const text = String(value || '').trim().replace(/[^\x20-\x7e]/g, '');
  return text ? text.slice(0, maximum) : null;
}

async function sourceFiles(rootDir) {
  const files = [];
  const walk = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(absolute);
      }
    }
  };
  await walk(path.join(rootDir, 'src'));
  const packageFile = path.join(rootDir, 'package.json');
  await fs.access(packageFile);
  files.push(packageFile);
  return files.sort((left, right) => left.localeCompare(right));
}

async function computeRuntimeBuildInfo(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const env = options.env || process.env;
  let sourceFingerprint = null;
  try {
    const hash = crypto.createHash('sha256');
    for (const file of await sourceFiles(rootDir)) {
      const relative = path.relative(rootDir, file).replaceAll(path.sep, '/');
      const content = String(await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
      hash.update(relative);
      hash.update('\0');
      hash.update(content);
      hash.update('\0');
    }
    sourceFingerprint = `sha256:${hash.digest('hex')}`;
  } catch {
    // Source files may be unavailable in a future packaged runtime. The explicit build ID remains usable.
  }
  const configuredBuildId = safeBuildText(env.NADO_BUILD_ID || env.NADO_GIT_COMMIT);
  return Object.freeze({
    version: NADO_VERSION,
    protocolVersion: NADO_PROTOCOL_VERSION,
    buildId: configuredBuildId || (sourceFingerprint ? `source-${sourceFingerprint.slice(7, 23)}` : null),
    buildIdSource: configuredBuildId ? 'environment' : sourceFingerprint ? 'source-fingerprint' : 'unavailable',
    sourceFingerprint,
  });
}

export function getRuntimeBuildInfo(options = {}) {
  if (options.rootDir || options.env) {
    return computeRuntimeBuildInfo(options);
  }
  if (!defaultBuildInfoPromise) {
    defaultBuildInfoPromise = computeRuntimeBuildInfo();
  }
  return defaultBuildInfoPromise;
}

export function normalizeRuntimeBuild(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const protocolVersion = Number(value.protocolVersion);
  const fingerprint = safeBuildText(value.sourceFingerprint, 96);
  return {
    version: safeBuildText(value.version, 64),
    protocolVersion: Number.isInteger(protocolVersion) && protocolVersion > 0 ? protocolVersion : null,
    buildId: safeBuildText(value.buildId),
    buildIdSource: safeBuildText(value.buildIdSource, 64),
    sourceFingerprint: fingerprint && /^sha256:[a-f0-9]{64}$/i.test(fingerprint) ? fingerprint.toLowerCase() : null,
  };
}

export function runtimeBuildCompatibility(controlValue, workerValue) {
  const control = normalizeRuntimeBuild(controlValue);
  const worker = normalizeRuntimeBuild(workerValue);
  if (!control || !worker) {
    return { status: 'unknown', compatible: null, reason: 'build evidence unavailable' };
  }
  if (control.protocolVersion && worker.protocolVersion && control.protocolVersion !== worker.protocolVersion) {
    return {
      status: 'protocol_mismatch',
      compatible: false,
      reason: `protocol ${worker.protocolVersion} does not match Control ${control.protocolVersion}`,
    };
  }
  if (control.sourceFingerprint && worker.sourceFingerprint) {
    return control.sourceFingerprint === worker.sourceFingerprint
      ? { status: 'compatible', compatible: true, reason: 'source fingerprints match' }
      : { status: 'build_mismatch', compatible: false, reason: 'source fingerprints differ' };
  }
  if (control.buildId && worker.buildId) {
    return control.buildId === worker.buildId
      ? { status: 'compatible', compatible: true, reason: 'build IDs match' }
      : { status: 'build_mismatch', compatible: false, reason: 'build IDs differ' };
  }
  if (control.version && worker.version && control.version !== worker.version) {
    return { status: 'build_mismatch', compatible: false, reason: `Worker ${worker.version} does not match Control ${control.version}` };
  }
  return { status: 'unknown', compatible: null, reason: 'insufficient comparable build evidence' };
}
