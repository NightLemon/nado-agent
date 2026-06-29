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

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-worker-token-'));
}

async function waitForTask(client, taskId, predicate, timeoutMs = 8_000) {
  const started = Date.now();
  let lastTask = null;
  while (Date.now() - started < timeoutMs) {
    const { task } = await client.getTask(taskId);
    lastTask = task;
    if (predicate(task)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for task ${taskId}; last status ${lastTask?.status}`);
}

async function runCli(args, env) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    timeout: 8_000,
  });
  return stdout;
}

test('worker-specific tokens are bound to one worker execution path', async () => {
  const root = await makeTempDir();
  const adminToken = 'admin-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token: adminToken,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const admin = new NadoClient({ controlUrl, token: adminToken });
  let worker;

  try {
    const issued = await admin.createWorkerToken({
      workerId: 'secure-worker',
      label: 'lab host',
    });
    assert.match(issued.token, /^nado_wt_[a-f0-9]+$/);
    assert.equal(issued.workerToken.workerId, 'secure-worker');
    assert.equal(issued.workerToken.label, 'lab host');
    assert.equal(JSON.stringify(await admin.listWorkerTokens()).includes(issued.token), false);

    const workerScoped = new NadoClient({ controlUrl, token: issued.token });
    await assert.rejects(
      () => workerScoped.listWorkers(),
      /403: Worker tokens cannot call control-plane admin APIs/,
    );
    await assert.rejects(
      () => workerScoped.registerWorker({ id: 'other-worker', capabilities: ['code'] }),
      /403: Worker token is not valid for worker: other-worker/,
    );
    await assert.rejects(
      () => workerScoped.workerPreflight('other-worker'),
      /403: Worker token is not valid for worker: other-worker/,
    );

    worker = await startWorker({
      id: 'secure-worker',
      controlUrl,
      token: issued.token,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
    });

    const created = await admin.createTask({
      title: 'worker token task',
      type: 'shell',
      workerId: 'secure-worker',
      command: 'node -e "require(\'fs\').writeFileSync(\'token.txt\', process.env.NADO_WORKER_ID); console.log(process.env.NADO_WORKER_ID)"',
    });
    const done = await waitForTask(admin, created.task.id, (task) => task.status === 'succeeded');
    assert.equal(done.assignedWorkerId, 'secure-worker');
    assert.match(done.stdout, /secure-worker/);
    assert.equal(await fs.readFile(path.join(done.workspace, 'token.txt'), 'utf8'), 'secure-worker');

    const tokensAfterUse = await admin.listWorkerTokens({ workerId: 'secure-worker' });
    assert.equal(tokensAfterUse.workerTokens.length, 1);
    assert.ok(tokensAfterUse.workerTokens[0].lastUsedAt);

    worker.stop();
    await worker.done;
    worker = null;

    const revoked = await admin.revokeWorkerToken(issued.workerToken.id);
    assert.equal(revoked.workerToken.revokedAt !== null, true);
    await assert.rejects(
      () => workerScoped.registerWorker({ id: 'secure-worker', capabilities: ['code'] }),
      /401: Unauthorized/,
    );
  } finally {
    if (worker) {
      worker.stop();
      await worker.done;
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI worker invite can issue a dedicated worker token', async () => {
  const root = await makeTempDir();
  const adminToken = 'invite-admin-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token: adminToken,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const admin = new NadoClient({ controlUrl, token: adminToken });
  let worker;

  try {
    const invite = await runCli([
      'worker',
      'invite',
      '--control',
      controlUrl,
      '--id',
      'invited-worker',
      '--capability',
      'code',
      '--issue-token',
      '--token-label',
      'ubuntu laptop',
      '--poll-ms',
      '50',
    ], { NADO_TOKEN: adminToken });
    assert.match(invite, /Issued worker token wtok_/);
    assert.doesNotMatch(invite, new RegExp(`export NADO_TOKEN='${adminToken}'`));
    const issuedToken = invite.match(/export NADO_TOKEN='([^']+)'/)?.[1];
    assert.match(issuedToken, /^nado_wt_[a-f0-9]+$/);
    assert.match(invite, /--id 'invited-worker'/);
    assert.match(invite, /--capability 'code'/);
    assert.match(invite, /worker preflight --control "\$NADO_CONTROL" --id 'invited-worker'/);

    const listed = await admin.listWorkerTokens({ workerId: 'invited-worker' });
    assert.equal(listed.workerTokens.length, 1);
    assert.equal(listed.workerTokens[0].label, 'ubuntu laptop');

    const preflight = await runCli([
      'worker',
      'preflight',
      '--control',
      controlUrl,
      '--id',
      'invited-worker',
      '--data-dir',
      path.join(root, 'preflight'),
    ], { NADO_TOKEN: issuedToken });
    assert.match(preflight, /preflight=ok/);
    assert.match(preflight, /worker=invited-worker/);
    assert.match(preflight, /auth=worker/);

    const bundleOut = path.join(root, 'issued-worker-bundle.zip');
    const bundle = await runCli([
      'worker',
      'bundle',
      '--control',
      controlUrl,
      '--id',
      'bundled-worker',
      '--capability',
      'code',
      '--issue-token',
      '--token-label',
      'bundle host',
      '--out',
      bundleOut,
    ], { NADO_TOKEN: adminToken });
    assert.match(bundle, /issuedWorkerToken=wtok_/);
    assert.match(bundle, /bundle=.*issued-worker-bundle\.zip/);
    const bundleBytes = await fs.readFile(bundleOut);
    assert.ok(bundleBytes.includes(Buffer.from('nado-worker-bundled-worker/start-worker.sh')));
    assert.doesNotMatch(bundleBytes.toString('latin1'), new RegExp(adminToken));
    assert.match(bundleBytes.toString('latin1'), /nado_wt_[a-f0-9]+/);
    const bundledTokens = await admin.listWorkerTokens({ workerId: 'bundled-worker' });
    assert.equal(bundledTokens.workerTokens.length, 1);
    assert.equal(bundledTokens.workerTokens[0].label, 'bundle host');

    worker = await startWorker({
      id: 'invited-worker',
      controlUrl,
      token: issuedToken,
      dataDir: root,
      capabilities: ['code'],
      pollMs: 50,
    });
    const created = await admin.createTask({
      title: 'issued token task',
      type: 'shell',
      workerId: 'invited-worker',
      command: 'node -e "console.log(process.env.NADO_WORKER_ID)"',
    });
    const done = await waitForTask(admin, created.task.id, (task) => task.status === 'succeeded');
    assert.equal(done.assignedWorkerId, 'invited-worker');
  } finally {
    if (worker) {
      worker.stop();
      await worker.done;
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HTTP worker bundle endpoint issues and embeds a dedicated worker token', async () => {
  const root = await makeTempDir();
  const adminToken = 'http-bundle-admin-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token: adminToken,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const admin = new NadoClient({ controlUrl, token: adminToken });

  try {
    const denied = await fetch(`${controlUrl}/api/workers/bundle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'http-bundled-worker' }),
    });
    assert.equal(denied.status, 401);

    const bundle = await admin.downloadWorkerBundle({
      id: 'http-bundled-worker',
      issueToken: true,
      tokenLabel: 'http bundle host',
      capabilities: ['code'],
      labels: ['zone=http'],
      agentPreset: 'node-copy',
      maxConcurrency: 2,
      pollMs: 50,
      cleanupWorkspaces: true,
    });
    assert.match(bundle.contentType, /application\/zip/);
    assert.equal(bundle.fileName, 'nado-worker-http-bundled-worker.zip');
    assert.match(bundle.workerToken.id, /^wtok_/);
    assert.equal(bundle.workerToken.workerId, 'http-bundled-worker');
    assert.ok(bundle.bytes.includes(Buffer.from('nado-worker-http-bundled-worker/start-worker.sh')));
    assert.ok(bundle.bytes.includes(Buffer.from('nado-worker-http-bundled-worker/src/cli.js')));
    assert.doesNotMatch(bundle.bytes.toString('latin1'), new RegExp(adminToken));
    assert.match(bundle.bytes.toString('latin1'), /nado_wt_[a-f0-9]+/);
    assert.match(bundle.bytes.toString('latin1'), /worker preflight --control "\$NADO_CONTROL" --id 'http-bundled-worker'/);
    assert.match(bundle.bytes.toString('latin1'), /--capability 'code'/);
    assert.match(bundle.bytes.toString('latin1'), /--label 'zone=http'/);
    assert.match(bundle.bytes.toString('latin1'), /--max-concurrency '2'/);

    const listed = await admin.listWorkerTokens({ workerId: 'http-bundled-worker' });
    assert.equal(listed.workerTokens.length, 1);
    assert.equal(listed.workerTokens[0].label, 'http bundle host');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('self-service worker enrollment assigns identity and starts the normal worker path', async () => {
  const root = await makeTempDir();
  const adminToken = 'self-service-admin-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token: adminToken,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const admin = new NadoClient({ controlUrl, token: adminToken });

  try {
    const issued = await admin.createWorkerEnrollmentToken({
      label: 'lab bootstrap',
      maxUses: 2,
    });
    assert.match(issued.token, /^nado_enroll_[a-f0-9]+$/);
    assert.equal(issued.enrollmentToken.label, 'lab bootstrap');

    let failedBootstrapStderr = '';
    try {
      await runCli([
        'worker',
        'bootstrap-start',
        '--control',
        controlUrl,
        '--enrollment-token',
        'nado_enroll_not-valid',
        '--data-dir',
        path.join(root, 'bad-bootstrap-worker'),
        '--once',
      ], {});
      assert.fail('expected invalid enrollment token to fail');
    } catch (error) {
      failedBootstrapStderr = error.stderr || '';
    }
    assert.match(failedBootstrapStderr, /Worker enrollment failed/);
    assert.match(failedBootstrapStderr, /fresh self-service bundle/);

    const workerData = path.join(root, 'bootstrap-worker');
    const firstStart = await runCli([
      'worker',
      'bootstrap-start',
      '--control',
      controlUrl,
      '--enrollment-token',
      issued.token,
      '--data-dir',
      workerData,
      '--capability',
      'code',
      '--poll-ms',
      '50',
      '--once',
    ], {});
    assert.match(firstStart, /enrollment=created/);
    assert.match(firstStart, /worker=worker-/);
    assert.match(firstStart, /preflight=ok/);
    assert.match(firstStart, /auth=worker/);
    assert.match(firstStart, /registered .*code/);
    const workerId = firstStart.match(/worker=(worker-[^\r\n]+)/)?.[1];
    assert.ok(workerId);

    const identity = JSON.parse(await fs.readFile(path.join(workerData, 'worker-identity.json'), 'utf8'));
    assert.equal(identity.workerId, workerId);
    assert.match(identity.workerToken, /^nado_wt_[a-f0-9]+$/);
    assert.match(identity.publicKeyPem, /BEGIN PUBLIC KEY/);
    assert.match(identity.privateKeyPem, /BEGIN PRIVATE KEY/);

    const listedWorkers = await admin.listWorkers();
    assert.ok(listedWorkers.workers.some((worker) => worker.id === workerId));
    const workerTokens = await admin.listWorkerTokens({ workerId });
    assert.equal(workerTokens.workerTokens.length, 1);
    assert.equal(workerTokens.workerTokens[0].enrollmentTokenId, issued.enrollmentToken.id);
    assert.match(workerTokens.workerTokens[0].publicKey, /BEGIN PUBLIC KEY/);
    const unsignedWorkerClient = new NadoClient({ controlUrl, token: identity.workerToken });
    await assert.rejects(
      () => unsignedWorkerClient.workerPreflight(workerId),
      /401: Signed worker request headers are required/,
    );
    const signedWorkerClient = new NadoClient({
      controlUrl,
      token: identity.workerToken,
      workerId,
      privateKeyPem: identity.privateKeyPem,
    });
    const signedPreflight = await signedWorkerClient.workerPreflight(workerId);
    assert.equal(signedPreflight.auth, 'worker');
    const replayPath = `/api/workers/${encodeURIComponent(workerId)}/preflight`;
    const replayHeaders = {
      accept: 'application/json',
      authorization: `Bearer ${identity.workerToken}`,
      ...signedWorkerClient.signingHeaders('GET', replayPath, ''),
    };
    const firstReplayAttempt = await fetch(`${controlUrl}${replayPath}`, { headers: replayHeaders });
    assert.equal(firstReplayAttempt.status, 200);
    const secondReplayAttempt = await fetch(`${controlUrl}${replayPath}`, { headers: replayHeaders });
    assert.equal(secondReplayAttempt.status, 401);
    assert.match(await secondReplayAttempt.text(), /nonce has already been used/);
    const heartbeatPath = `/api/workers/${encodeURIComponent(workerId)}/heartbeat`;
    const heartbeatBody = JSON.stringify({
      observedState: 'idle',
      currentTaskIds: [],
      maxConcurrency: 1,
    });
    const heartbeatHeaders = {
      accept: 'application/json',
      authorization: `Bearer ${identity.workerToken}`,
      'content-type': 'application/json',
      ...signedWorkerClient.signingHeaders('POST', heartbeatPath, heartbeatBody),
    };
    const tamperedHeartbeat = await fetch(`${controlUrl}${heartbeatPath}`, {
      method: 'POST',
      headers: heartbeatHeaders,
      body: JSON.stringify({ observedState: 'running' }),
    });
    assert.equal(tamperedHeartbeat.status, 401);
    assert.match(await tamperedHeartbeat.text(), /body hash mismatch/);
    const untamperedHeartbeat = await fetch(`${controlUrl}${heartbeatPath}`, {
      method: 'POST',
      headers: heartbeatHeaders,
      body: heartbeatBody,
    });
    assert.equal(untamperedHeartbeat.status, 200);
    const enrollmentTokens = await admin.listWorkerEnrollmentTokens();
    const used = enrollmentTokens.enrollmentTokens.find((token) => token.id === issued.enrollmentToken.id);
    assert.equal(used.useCount, 1);
    assert.ok(used.lastUsedAt);

    const secondStart = await runCli([
      'worker',
      'bootstrap-start',
      '--control',
      controlUrl,
      '--data-dir',
      workerData,
      '--poll-ms',
      '50',
      '--once',
    ], {});
    assert.match(secondStart, /enrollment=reused/);
    assert.match(secondStart, new RegExp(`worker=${workerId}`));
    assert.match(secondStart, /preflight=ok/);
    assert.match(secondStart, /auth=worker/);

    await admin.revokeWorkerToken(identity.workerTokenId);
    const recoveryToken = await admin.createWorkerEnrollmentToken({
      label: 'recover bootstrap identity',
      maxUses: 1,
    });
    const recoveredStart = await runCli([
      'worker',
      'bootstrap-start',
      '--control',
      controlUrl,
      '--enrollment-token',
      recoveryToken.token,
      '--data-dir',
      workerData,
      '--poll-ms',
      '50',
      '--once',
    ], {});
    assert.match(recoveredStart, /enrollment=reused/);
    assert.match(recoveredStart, /preflight=recovering/);
    assert.match(recoveredStart, /recovery=reenroll/);
    assert.match(recoveredStart, /enrollment=recovered/);
    assert.match(recoveredStart, new RegExp(`worker=${workerId}`));
    assert.match(recoveredStart, /preflight=ok/);
    assert.match(recoveredStart, /auth=worker/);
    const recoveredIdentity = JSON.parse(await fs.readFile(path.join(workerData, 'worker-identity.json'), 'utf8'));
    assert.equal(recoveredIdentity.workerId, workerId);
    assert.notEqual(recoveredIdentity.workerTokenId, identity.workerTokenId);

    const bundle = await admin.downloadWorkerBootstrapBundle({
      issueEnrollmentToken: true,
      tokenLabel: 'bundle bootstrap',
      capabilities: ['code'],
      labels: ['zone=auto'],
      maxUses: 3,
    });
    assert.match(bundle.contentType, /application\/zip/);
    assert.equal(bundle.fileName, 'nado-worker-bootstrap.zip');
    assert.match(bundle.enrollmentToken.id, /^wenroll_/);
    assert.ok(bundle.bytes.includes(Buffer.from('nado-worker-bootstrap/start-worker.sh')));
    assert.ok(bundle.bytes.includes(Buffer.from('worker bootstrap-start')));
    assert.ok(bundle.bytes.includes(Buffer.from("--capability 'code'")));
    assert.ok(bundle.bytes.includes(Buffer.from("--label 'zone=auto'")));
    assert.match(bundle.bytes.toString('latin1'), /nado_enroll_[a-f0-9]+/);
    assert.doesNotMatch(bundle.bytes.toString('latin1'), new RegExp(adminToken));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI lists and revokes worker enrollment tokens', async () => {
  const root = await makeTempDir();
  const adminToken = 'enrollment-cli-admin-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token: adminToken,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const admin = new NadoClient({ controlUrl, token: adminToken });

  try {
    const issued = await admin.createWorkerEnrollmentToken({
      label: 'cli bootstrap host',
      maxUses: 1,
    });

    const listed = await runCli([
      'worker',
      'enrollments',
      '--control',
      controlUrl,
    ], { NADO_TOKEN: adminToken });
    assert.match(listed, new RegExp(issued.enrollmentToken.id));
    assert.match(listed, /cli bootstrap host/);
    assert.match(listed, /active/);
    assert.match(listed, /0\/1/);

    const revoked = await runCli([
      'worker',
      'enrollment',
      'revoke',
      issued.enrollmentToken.id,
      '--control',
      controlUrl,
    ], { NADO_TOKEN: adminToken });
    assert.match(revoked, new RegExp(`revoked ${issued.enrollmentToken.id}`));

    const after = await runCli([
      'worker',
      'enrollments',
      '--control',
      controlUrl,
    ], { NADO_TOKEN: adminToken });
    assert.match(after, new RegExp(issued.enrollmentToken.id));
    assert.match(after, /revoked/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI previews and prunes only unused worker enrollment tokens', async () => {
  const root = await makeTempDir();
  const adminToken = 'enrollment-prune-admin-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token: adminToken,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const admin = new NadoClient({ controlUrl, token: adminToken });

  try {
    const unused = await admin.createWorkerEnrollmentToken({
      label: 'unused bootstrap package',
      maxUses: 1,
    });
    const used = await admin.createWorkerEnrollmentToken({
      label: 'used bootstrap package',
      maxUses: 2,
    });
    const alreadyRevoked = await admin.createWorkerEnrollmentToken({
      label: 'already revoked package',
    });
    await admin.revokeWorkerEnrollmentToken(alreadyRevoked.enrollmentToken.id);
    await new NadoClient({ controlUrl, token: used.token }).enrollWorker({
      id: 'used-enrollment-worker',
      publicKey: '-----BEGIN PUBLIC KEY-----\nunused-test-key\n-----END PUBLIC KEY-----',
    });

    const preview = await admin.previewWorkerEnrollmentTokenPrune();
    assert.equal(preview.prunableCount, 1);
    assert.deepEqual(preview.prunableTokens.map((token) => token.id), [unused.enrollmentToken.id]);

    const dryRun = await runCli([
      'worker',
      'enrollments',
      'prune',
      '--dry-run',
      '--control',
      controlUrl,
    ], { NADO_TOKEN: adminToken });
    assert.match(dryRun, /prunableEnrollmentTokens=1/);
    assert.match(dryRun, new RegExp(unused.enrollmentToken.id));
    assert.doesNotMatch(dryRun, new RegExp(used.enrollmentToken.id));

    const pruned = await runCli([
      'worker',
      'enrollments',
      'prune',
      '--control',
      controlUrl,
    ], { NADO_TOKEN: adminToken });
    assert.match(pruned, /prunedEnrollmentTokens=1/);
    assert.match(pruned, new RegExp(unused.enrollmentToken.id));

    const after = await admin.listWorkerEnrollmentTokens();
    const unusedAfter = after.enrollmentTokens.find((token) => token.id === unused.enrollmentToken.id);
    const usedAfter = after.enrollmentTokens.find((token) => token.id === used.enrollmentToken.id);
    const revokedAfter = after.enrollmentTokens.find((token) => token.id === alreadyRevoked.enrollmentToken.id);
    assert.ok(unusedAfter.revokedAt);
    assert.equal(usedAfter.revokedAt, null);
    assert.equal(usedAfter.useCount, 1);
    assert.ok(revokedAfter.revokedAt);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
