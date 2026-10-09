import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';
import {
  confirmPendingWorkerTokenRotation,
  ensureEnrolledWorker,
  generateWorkerToken,
  readWorkerIdentity,
  rotateEnrolledWorkerToken,
  writeWorkerIdentity,
} from '../src/worker-enrollment.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-token-rotation-'));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function signedClient(controlUrl, identity, token = identity.workerToken) {
  return new NadoClient({
    controlUrl,
    token,
    workerId: identity.workerId,
    privateKeyPem: identity.privateKeyPem,
  });
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for condition');
}

test('signed Worker token rotation is two-phase, secure, idempotent, and rejects the old token', async () => {
  const root = await makeTempDir();
  const adminToken = 'rotation-admin-token';
  const { server, store, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token: adminToken,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const admin = new NadoClient({ controlUrl, token: adminToken });

  try {
    const enrollment = await admin.createWorkerEnrollmentToken({ maxUses: 1 });
    const identity = await ensureEnrolledWorker({
      id: 'rotation-worker',
      controlUrl,
      enrollmentToken: enrollment.token,
      dataDir: path.join(root, 'worker'),
    });
    const oldClient = signedClient(controlUrl, identity);
    await oldClient.registerWorker({ id: identity.workerId, capabilities: ['code'] });
    const unsigned = new NadoClient({ controlUrl, token: identity.workerToken });
    const candidate = generateWorkerToken();

    await assert.rejects(
      () => unsigned.prepareWorkerTokenRotation(identity.workerId, candidate),
      /401: Signed worker request headers are required/,
    );
    await assert.rejects(
      () => admin.prepareWorkerTokenRotation(identity.workerId, candidate),
      /403: A signed Worker identity is required/,
    );
    await assert.rejects(
      () => oldClient.prepareWorkerTokenRotation('another-worker', candidate),
      /403: Worker token is not valid for worker/,
    );
    await assert.rejects(
      () => oldClient.prepareWorkerTokenRotation(identity.workerId, 'nado_wt_too-short'),
      /400: Replacement Worker token must be a locally generated high-entropy/,
    );

    const expiredCandidate = generateWorkerToken();
    const expiring = await oldClient.prepareWorkerTokenRotation(identity.workerId, expiredCandidate);
    store.state.workerTokens[expiring.workerToken.id].rotationExpiresAt = new Date(Date.now() - 1_000).toISOString();
    store.state.workerTokens[expiring.workerToken.id].expiresAt = new Date(Date.now() - 1_000).toISOString();
    const expired = await store.expirePendingWorkerTokenRotations();
    assert.equal(expired.some((token) => token.id === expiring.workerToken.id), true);
    assert.equal(store.getWorkerToken(expiring.workerToken.id).rotationStatus, 'expired');
    assert.equal(store.getWorkerToken(identity.workerTokenId).revokedAt, null);

    const abandonedCandidate = generateWorkerToken();
    const abandoned = await oldClient.prepareWorkerTokenRotation(identity.workerId, abandonedCandidate);
    const prepared = await oldClient.prepareWorkerTokenRotation(identity.workerId, candidate);
    assert.equal(store.getWorkerToken(abandoned.workerToken.id).rotationStatus, 'superseded');
    assert.ok(store.getWorkerToken(abandoned.workerToken.id).revokedAt);
    await assert.rejects(
      () => signedClient(controlUrl, identity, abandonedCandidate).workerPreflight(identity.workerId),
      /401: Unauthorized/,
    );
    const repeatedPrepare = await oldClient.prepareWorkerTokenRotation(identity.workerId, candidate);
    assert.equal(prepared.workerToken.rotationStatus, 'pending');
    assert.equal(prepared.workerToken.rotationFromTokenId, identity.workerTokenId);
    assert.equal(repeatedPrepare.workerToken.id, prepared.workerToken.id);
    assert.equal(repeatedPrepare.idempotent, true);
    assert.equal(JSON.stringify(prepared).includes(candidate), false);

    await assert.rejects(
      () => oldClient.confirmWorkerTokenRotation(identity.workerId),
      /409: Replacement Worker token is not a rotation token/,
    );
    const unsignedReplacement = new NadoClient({ controlUrl, token: candidate });
    await assert.rejects(
      () => unsignedReplacement.confirmWorkerTokenRotation(identity.workerId),
      /401: Signed worker request headers are required/,
    );
    const replacementClient = signedClient(controlUrl, identity, candidate);
    await assert.rejects(
      () => replacementClient.prepareWorkerTokenRotation(identity.workerId, generateWorkerToken()),
      /409: Pending Worker token must be confirmed/,
    );
    const confirmed = await replacementClient.confirmWorkerTokenRotation(identity.workerId);
    const repeatedConfirm = await replacementClient.confirmWorkerTokenRotation(identity.workerId);
    assert.equal(confirmed.workerToken.rotationStatus, 'confirmed');
    assert.ok(confirmed.previousWorkerToken.revokedAt);
    assert.equal(repeatedConfirm.idempotent, true);
    assert.equal((await replacementClient.heartbeat(identity.workerId, {
      observedState: 'idle',
      currentTaskIds: [],
      maxConcurrency: 1,
    })).worker.id, identity.workerId);
    await assert.rejects(
      () => oldClient.workerPreflight(identity.workerId),
      /401: Unauthorized/,
    );

    await waitUntil(() => store.listAuditEvents({ tail: 100 }).some((event) => (
      event.path.endsWith('/token/rotation/confirm') && event.outcome === 'success'
    )));
    const auditJson = JSON.stringify(store.listAuditEvents({ tail: 100 }));
    assert.equal(auditJson.includes(candidate), false);
    assert.match(auditJson, /token\/rotation\/prepare/);
    assert.match(auditJson, /token\/rotation\/confirm/);
  } finally {
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('persisted pending rotation recovers after a lost response and runtime rotation stays online', async () => {
  const root = await makeTempDir();
  const dataDir = path.join(root, 'worker');
  const adminToken = 'rotation-recovery-admin';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token: adminToken,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const admin = new NadoClient({ controlUrl, token: adminToken });
  const evidenceFile = path.join(root, 'acceptance-evidence.json');
  let worker = null;

  try {
    const enrollment = await admin.createWorkerEnrollmentToken({ maxUses: 1 });
    const original = await ensureEnrolledWorker({
      id: 'rotation-recovery-worker',
      controlUrl,
      enrollmentToken: enrollment.token,
      dataDir,
    });
    const originalClient = signedClient(controlUrl, original);
    await originalClient.registerWorker({ id: original.workerId, capabilities: ['code'] });

    const candidate = generateWorkerToken();
    const prepared = await originalClient.prepareWorkerTokenRotation(original.workerId, candidate);
    await writeWorkerIdentity(dataDir, {
      ...original,
      workerToken: candidate,
      workerTokenId: prepared.workerToken.id,
      workerTokenPreview: prepared.workerToken.tokenPreview,
      tokenRotation: {
        status: 'pending',
        fromTokenId: original.workerTokenId,
        toTokenId: prepared.workerToken.id,
        preparedAt: prepared.workerToken.createdAt,
        expiresAt: prepared.workerToken.rotationExpiresAt,
      },
    });
    await signedClient(controlUrl, original, candidate).confirmWorkerTokenRotation(original.workerId);

    const recovered = await confirmPendingWorkerTokenRotation({ dataDir, controlUrl });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.identity.tokenRotation, undefined);
    assert.equal(recovered.identity.lastTokenRotation.status, 'confirmed');
    assert.equal((await readWorkerIdentity(dataDir)).workerTokenId, prepared.workerToken.id);
    assert.equal((await readWorkerIdentity(dataDir)).dataDir, undefined);
    assert.equal((await readWorkerIdentity(dataDir)).reused, undefined);
    assert.deepEqual(
      (await fs.readdir(dataDir)).filter((name) => name.includes('worker-identity.json.') && name.endsWith('.tmp')),
      [],
    );

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'worker',
      'token',
      'rotate',
      '--control',
      controlUrl,
      '--data-dir',
      dataDir,
      '--verify',
      '--evidence',
      evidenceFile,
    ], { timeout: 8_000 });
    assert.match(stdout, /rotated wtok_/);
    assert.match(stdout, /recovered=false/);
    assert.match(stdout, /previousTokenRejected=true/);
    assert.match(stdout, /acceptanceEvidence=/);
    const directEvidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8')).scenarios.credentialRevocation;
    assert.equal(directEvidence.status, 'passed');
    assert.equal(directEvidence.source, 'automated_exercise');
    assert.equal(directEvidence.details.mode, 'direct_verified_rotation');
    assert.equal(directEvidence.details.verification.previousTokenStatus, 401);
    const afterCli = await readWorkerIdentity(dataDir);
    assert.notEqual(afterCli.workerTokenId, prepared.workerToken.id);
    assert.equal(afterCli.tokenRotation, undefined);

    worker = await startWorker({
      id: afterCli.workerId,
      controlUrl,
      token: afterCli.workerToken,
      privateKeyPem: afterCli.privateKeyPem,
      dataDir,
      capabilities: ['code'],
      pollMs: 25,
      longPollMs: 0,
      credentialRotationIntervalMs: 0,
      rotateCredentials: ({ client, verifyPreviousToken }) => rotateEnrolledWorkerToken({
        dataDir,
        controlUrl,
        client,
        verifyPreviousToken,
      }),
    });
    const busyTask = await admin.createTask({
      title: 'keep worker busy during credential rotation request',
      type: 'shell',
      workerId: afterCli.workerId,
      command: 'node -e "setTimeout(() => console.log(\'done\'), 800)"',
    });
    await waitUntil(async () => (await admin.getTask(busyTask.task.id)).task.status === 'running');
    const { stdout: managedRotationOutput } = await execFileAsync(process.execPath, [
      cliPath,
      'worker',
      'manage',
      '--control',
      controlUrl,
      '--id',
      afterCli.workerId,
      '--action',
      'rotate_token',
      '--wait',
      '--timeout',
      '8000',
      '--evidence',
      evidenceFile,
    ], {
      env: { ...process.env, NADO_TOKEN: adminToken },
      timeout: 12_000,
    });
    assert.match(managedRotationOutput, /commandStatus=completed/);
    assert.match(managedRotationOutput, /previousTokenRejected=true/);
    const queuedCommandId = managedRotationOutput.match(/queued (cmd_[^ ]+)/)?.[1];
    assert.ok(queuedCommandId);
    const completedCommand = await waitUntil(async () => {
      const current = await admin.getWorker(afterCli.workerId);
      const command = current.worker.commands.find((item) => item.id === queuedCommandId);
      return command?.status === 'completed' ? command : null;
    }, 8_000);
    assert.equal(completedCommand.result.verification.passed, true);
    assert.equal(completedCommand.result.verification.previousTokenRejected, true);
    const recordedEvidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8'));
    assert.match(recordedEvidence.scenarios.credentialRevocation.evidence, /Control-triggered rotation/);
    assert.ok(recordedEvidence.scenarios.credentialRevocation.references.includes(`worker-command:${queuedCommandId}`));
    assert.equal(recordedEvidence.scenarios.credentialRevocation.source, 'automated_exercise');
    assert.equal(recordedEvidence.scenarios.credentialRevocation.details.mode, 'control_triggered_rotation');
    assert.equal(recordedEvidence.scenarios.credentialRevocation.details.commandId, queuedCommandId);
    assert.equal(recordedEvidence.scenarios.credentialRevocation.details.verification.previousTokenStatus, 401);
    assert.equal((await admin.getTask(busyTask.task.id)).task.status, 'succeeded');
    const runtimeIdentity = await waitUntil(async () => {
      const current = await readWorkerIdentity(dataDir);
      return current.workerTokenId !== afterCli.workerTokenId && !current.tokenRotation ? current : null;
    }, 6_000);
    assert.equal(runtimeIdentity.tokenRotation, undefined);
    assert.equal((await signedClient(controlUrl, runtimeIdentity).workerPreflight(runtimeIdentity.workerId)).ok, true);
    const tokens = await admin.listWorkerTokens({ workerId: runtimeIdentity.workerId });
    const previous = tokens.workerTokens.find((token) => token.id === afterCli.workerTokenId);
    const latest = tokens.workerTokens.find((token) => token.id === runtimeIdentity.workerTokenId);
    assert.ok(previous.revokedAt);
    assert.equal(latest.rotationStatus, 'confirmed');
    const workerEvents = await admin.listWorkerEvents(runtimeIdentity.workerId, { tail: 100 });
    const rotationEvent = [...workerEvents.events].reverse().find((event) => event.type === 'worker_token_rotated');
    assert.ok(rotationEvent);
    assert.equal(rotationEvent.data.nextRotationAt, null);
  } finally {
    if (worker) {
      worker.stop();
      await worker.done;
    }
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
