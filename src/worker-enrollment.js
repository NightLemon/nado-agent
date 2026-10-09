import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NadoClient } from './http-client.js';
import { ensureDir, safeName } from './utils.js';

export function workerIdentityPath(dataDir) {
  return path.join(dataDir || '.nado', 'worker-identity.json');
}

function generatedWorkerId(prefix = 'worker') {
  const host = safeName(os.hostname() || 'host').slice(0, 24) || 'host';
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${safeName(prefix || 'worker')}-${host}-${suffix}`;
}

export async function readWorkerIdentity(dataDir) {
  try {
    return JSON.parse(await fs.readFile(workerIdentityPath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

export function workerIdentityKeyPairStatus(identity) {
  if (!identity?.privateKeyPem || !identity?.publicKeyPem) {
    return {
      ready: false,
      error: 'worker identity does not contain both private and public signing keys',
    };
  }
  try {
    const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
    const publicKey = crypto.createPublicKey(identity.publicKeyPem);
    const derivedPublic = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
    const declaredPublic = publicKey.export({ type: 'spki', format: 'pem' });
    const ready = privateKey.asymmetricKeyType === 'ed25519'
      && publicKey.asymmetricKeyType === 'ed25519'
      && derivedPublic === declaredPublic;
    return {
      ready,
      error: ready ? null : 'worker identity does not contain a matching Ed25519 keypair',
    };
  } catch (error) {
    return {
      ready: false,
      error: `worker identity key validation failed: ${error.message}`,
    };
  }
}

export async function writeWorkerIdentity(dataDir, identity) {
  const directory = path.resolve(dataDir || '.nado');
  const target = workerIdentityPath(directory);
  const temporary = `${target}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await ensureDir(directory);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600).catch(() => {});
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function generateWorkerToken() {
  return `nado_wt_${crypto.randomBytes(32).toString('hex')}`;
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
  const existing = await readWorkerIdentity(dataDir);
  const existingKeyStatus = workerIdentityKeyPairStatus(existing);
  if (!options.force && existing?.workerId && existing?.workerToken && existingKeyStatus.ready) {
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

  const keys = existingKeyStatus.ready
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
  await writeWorkerIdentity(dataDir, identity);
  return {
    ...identity,
    dataDir,
    reused: false,
    recovered: Boolean(options.force && existing?.workerId),
  };
}

function requireRotatableIdentity(identity) {
  if (!identity?.workerId || !identity?.workerToken || !identity?.privateKeyPem) {
    throw new Error('Worker token rotation requires a self-service Worker identity with token and private key');
  }
  return identity;
}

function persistentWorkerIdentity(identity) {
  const {
    dataDir,
    reused,
    recovered,
    rotationRecoveryError,
    ...persistent
  } = identity || {};
  return persistent;
}

function identityClient(identity, options = {}) {
  const controlUrl = options.controlUrl || identity.controlUrl;
  if (!controlUrl) {
    throw new Error('Worker token rotation requires a Control URL');
  }
  const client = options.client || new NadoClient({
    controlUrl,
    token: identity.workerToken,
    workerId: identity.workerId,
    privateKeyPem: identity.privateKeyPem,
  });
  client.controlUrl = client.controlUrl || controlUrl;
  client.workerId = identity.workerId;
  client.privateKeyPem = identity.privateKeyPem;
  client.token = identity.workerToken;
  return { client, controlUrl };
}

export async function confirmPendingWorkerTokenRotation(options = {}) {
  const dataDir = path.resolve(options.dataDir || '.nado');
  const identity = requireRotatableIdentity(options.identity || await readWorkerIdentity(dataDir));
  if (identity.tokenRotation?.status !== 'pending') {
    return {
      identity,
      rotation: identity.lastTokenRotation || null,
      recovered: false,
    };
  }
  const { client, controlUrl } = identityClient(identity, options);
  const confirmed = await client.confirmWorkerTokenRotation(identity.workerId);
  const { tokenRotation, ...baseIdentity } = persistentWorkerIdentity(identity);
  const nextIdentity = {
    ...baseIdentity,
    controlUrl,
    workerTokenId: confirmed.workerToken.id,
    workerTokenPreview: confirmed.workerToken.tokenPreview,
    lastTokenRotation: {
      status: 'confirmed',
      fromTokenId: tokenRotation.fromTokenId,
      toTokenId: confirmed.workerToken.id,
      preparedAt: tokenRotation.preparedAt,
      confirmedAt: confirmed.workerToken.rotationConfirmedAt || new Date().toISOString(),
      recovered: Boolean(confirmed.idempotent),
    },
  };
  await writeWorkerIdentity(dataDir, nextIdentity);
  return {
    identity: nextIdentity,
    rotation: confirmed,
    recovered: Boolean(confirmed.idempotent),
  };
}

export async function rotateEnrolledWorkerToken(options = {}) {
  const dataDir = path.resolve(options.dataDir || '.nado');
  let identity = requireRotatableIdentity(options.identity || await readWorkerIdentity(dataDir));
  if (identity.tokenRotation?.status === 'pending') {
    const recovered = await confirmPendingWorkerTokenRotation({
      ...options,
      dataDir,
      identity,
    });
    return options.verifyPreviousToken ? {
      ...recovered,
      verification: {
        passed: false,
        newTokenAccepted: null,
        previousTokenRejected: null,
        reason: 'pending rotation recovered, but the predecessor raw token is intentionally no longer stored',
        checkedAt: new Date().toISOString(),
      },
    } : recovered;
  }

  const previousIdentity = persistentWorkerIdentity(identity);
  const { client, controlUrl } = identityClient(identity, options);
  const replacementToken = generateWorkerToken();
  const prepared = await client.prepareWorkerTokenRotation(identity.workerId, replacementToken, {
    ttlMs: options.ttlMs,
  });
  const previousTokenId = identity.workerTokenId;
  identity = {
    ...persistentWorkerIdentity(identity),
    controlUrl,
    workerToken: replacementToken,
    workerTokenId: prepared.workerToken.id,
    workerTokenPreview: prepared.workerToken.tokenPreview,
    tokenRotation: {
      status: 'pending',
      fromTokenId: previousTokenId,
      toTokenId: prepared.workerToken.id,
      preparedAt: prepared.workerToken.createdAt || new Date().toISOString(),
      expiresAt: prepared.workerToken.rotationExpiresAt || prepared.workerToken.expiresAt,
    },
  };
  await writeWorkerIdentity(dataDir, identity);
  client.token = replacementToken;
  try {
    const confirmed = await confirmPendingWorkerTokenRotation({
      ...options,
      dataDir,
      identity,
      client,
      controlUrl,
    });
    if (!options.verifyPreviousToken) {
      return confirmed;
    }
    const verification = {
      passed: false,
      newTokenAccepted: false,
      previousTokenRejected: false,
      previousTokenStatus: null,
      checkedAt: new Date().toISOString(),
      reason: null,
    };
    try {
      const currentClient = identityClient(confirmed.identity, { controlUrl }).client;
      const preflight = await currentClient.workerPreflight(confirmed.identity.workerId);
      verification.newTokenAccepted = Boolean(preflight?.ok);
    } catch (error) {
      verification.reason = `replacement token preflight failed: ${error.message}`;
      return { ...confirmed, verification };
    }
    try {
      const previousClient = identityClient(previousIdentity, { controlUrl }).client;
      await previousClient.workerPreflight(previousIdentity.workerId);
      verification.previousTokenStatus = 200;
      verification.reason = 'predecessor token unexpectedly remained authorized';
    } catch (error) {
      verification.previousTokenStatus = Number(error.status || 0) || null;
      verification.previousTokenRejected = Number(error.status || 0) === 401;
      if (!verification.previousTokenRejected) {
        verification.reason = `predecessor rejection check failed: ${error.message}`;
      }
    }
    verification.passed = verification.newTokenAccepted && verification.previousTokenRejected;
    return { ...confirmed, verification };
  } catch (error) {
    error.workerIdentityUpdated = true;
    error.workerTokenId = prepared.workerToken.id;
    throw error;
  }
}
