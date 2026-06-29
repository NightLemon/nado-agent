import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NadoClient } from './http-client.js';
import { ensureDir, safeName } from './utils.js';

function identityPath(dataDir) {
  return path.join(dataDir || '.nado', 'worker-identity.json');
}

function generatedWorkerId(prefix = 'worker') {
  const host = safeName(os.hostname() || 'host').slice(0, 24) || 'host';
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${safeName(prefix || 'worker')}-${host}-${suffix}`;
}

async function readIdentity(dataDir) {
  try {
    return JSON.parse(await fs.readFile(identityPath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

async function writeIdentity(dataDir, identity) {
  await ensureDir(dataDir || '.nado');
  await fs.writeFile(identityPath(dataDir), `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
}

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export async function ensureEnrolledWorker(options = {}) {
  const dataDir = path.resolve(options.dataDir || '.nado');
  const existing = await readIdentity(dataDir);
  if (!options.force && existing?.workerId && existing?.workerToken) {
    return {
      ...existing,
      dataDir,
      reused: true,
    };
  }

  const enrollmentToken = options.enrollmentToken;
  if (!enrollmentToken) {
    throw new Error('Worker bootstrap requires an enrollment token');
  }

  const keys = existing?.publicKeyPem && existing?.privateKeyPem
    ? { publicKeyPem: existing.publicKeyPem, privateKeyPem: existing.privateKeyPem }
    : generateKeyPair();
  const requestedWorkerId = options.id || existing?.workerId || generatedWorkerId(options.idPrefix || 'worker');
  const client = new NadoClient({
    controlUrl: options.controlUrl,
    token: enrollmentToken,
  });
  const enrolled = await client.enrollWorker({
    id: requestedWorkerId,
    publicKey: keys.publicKeyPem,
    label: options.label || '',
  });
  const identity = {
    workerId: enrolled.workerId,
    workerToken: enrolled.token,
    workerTokenId: enrolled.workerToken.id,
    workerTokenPreview: enrolled.workerToken.tokenPreview,
    enrollmentTokenId: enrolled.enrollmentToken?.id || null,
    publicKeyPem: keys.publicKeyPem,
    privateKeyPem: keys.privateKeyPem,
    controlUrl: options.controlUrl,
    createdAt: existing?.createdAt || new Date().toISOString(),
    enrolledAt: new Date().toISOString(),
  };
  await writeIdentity(dataDir, identity);
  return {
    ...identity,
    dataDir,
    reused: false,
    recovered: Boolean(options.force && existing?.workerId),
  };
}
