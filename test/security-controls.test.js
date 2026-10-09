import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-security-controls-'));
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function waitForAudit(client, predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  let events = [];
  while (Date.now() - startedAt < timeoutMs) {
    ({ auditEvents: events } = await client.listAuditEvents({ tail: 1_000 }));
    if (events.some(predicate)) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for audit event; received ${events.length} events`);
}

function authHeaders(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    ...extra,
  };
}

test('control security limits and durable audit trail cover privileged and denied requests', async () => {
  const root = await makeTempDir();
  const dataDir = path.join(root, 'control');
  const externalAuditFile = path.join(root, 'external-audit', 'audit.ndjson');
  const adminToken = 'security-admin-token';
  let running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token: adminToken,
    dataDir,
    storeBackend: 'sqlite',
    jsonBodyMaxBytes: 1_024,
    rateLimitIp: 0,
    rateLimitAdmin: 0,
    rateLimitWorker: 0,
    rateLimitEnrollment: 0,
    auditNdjsonFile: externalAuditFile,
  });

  try {
    let controlUrl = `http://127.0.0.1:${running.port}`;
    let admin = new NadoClient({ controlUrl, token: adminToken });

    const capabilities = await admin.capabilities();
    const status = await admin.status();
    assert.equal(capabilities.features.durableAuditTrail, true);
    assert.equal(capabilities.features.externalAuditNdjsonMirror, true);
    assert.equal(capabilities.features.apiRateLimits, true);
    assert.equal(capabilities.features.jsonRequestBodyLimit, true);
    assert.equal(capabilities.features.explicitStoreMigrations, true);
    assert.equal(capabilities.features.verifiedOfflineBackupRestore, true);
    assert.equal(capabilities.features.crossSiteAcceptanceReports, true);
    assert.equal(capabilities.features.retryableFailurePolicies, true);
    assert.equal(capabilities.security.audit.secretsStored, false);
    assert.equal(capabilities.security.audit.externalMirror.enabled, true);
    assert.equal(capabilities.security.audit.externalMirror.pathExposed, false);
    assert.equal(status.security.auditSink.enabled, true);
    assert.equal(capabilities.security.dashboard.nonceCsp, true);
    assert.equal(capabilities.storage.currentStateVersion, 2);
    assert.equal(capabilities.storage.currentSqliteSchemaVersion, 1);
    assert.equal(status.storage.backend, 'sqlite');
    assert.equal(status.storage.stateVersion, 2);
    assert.equal(status.storage.sqliteSchemaVersion, 1);

    const created = await admin.createTask({
      title: 'audited admin mutation',
      type: 'shell',
      command: 'echo audited',
    });
    assert.ok(created.task.id);

    const unauthorized = await fetch(`${controlUrl}/api/status`, {
      headers: authHeaders('invalid-secret-token'),
    });
    assert.equal(unauthorized.status, 401);

    const invalidJson = await fetch(`${controlUrl}/api/tasks`, {
      method: 'POST',
      headers: authHeaders(adminToken, { 'content-type': 'application/json' }),
      body: '{',
    });
    assert.equal(invalidJson.status, 400);

    const oversized = await fetch(`${controlUrl}/api/tasks`, {
      method: 'POST',
      headers: authHeaders(adminToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({ padding: 'x'.repeat(2_000) }),
    });
    assert.equal(oversized.status, 413);

    const issued = await admin.createWorkerToken({ workerId: 'audit-worker' });
    const worker = new NadoClient({ controlUrl, token: issued.token });
    await assert.rejects(
      () => worker.listAuditEvents(),
      /403: Worker tokens cannot call control-plane admin APIs/,
    );

    const events = await waitForAudit(admin, (event) => (
      event.path === '/api/audit' && event.statusCode === 403
    ));
    assert.ok(events.some((event) => event.path === '/api/tasks' && event.statusCode === 201 && event.outcome === 'success'));
    assert.ok(events.some((event) => event.path === '/api/status' && event.statusCode === 401 && event.outcome === 'denied'));
    assert.ok(events.some((event) => event.path === '/api/tasks' && event.statusCode === 400 && event.outcome === 'denied'));
    assert.ok(events.some((event) => event.path === '/api/tasks' && event.statusCode === 413 && event.outcome === 'denied'));
    assert.ok(events.some((event) => event.path === '/api/audit' && event.statusCode === 403 && event.actorType === 'worker'));

    const serializedEvents = JSON.stringify(events);
    assert.doesNotMatch(serializedEvents, new RegExp(adminToken));
    assert.doesNotMatch(serializedEvents, new RegExp(issued.token));
    assert.doesNotMatch(serializedEvents, /invalid-secret-token/);

    const exported = await admin.exportAuditEvents({ tail: 1_000 });
    const exportedRows = exported.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(exportedRows.length >= events.length);
    assert.ok(exportedRows.some((event) => event.path === '/api/tasks' && event.statusCode === 413));
    assert.doesNotMatch(exported, new RegExp(adminToken));
    assert.doesNotMatch(exported, new RegExp(issued.token));

    const cliStatus = await execFileAsync(process.execPath, [
      cliPath,
      'status',
      '--control', controlUrl,
    ], { env: { ...process.env, NADO_TOKEN: adminToken } });
    assert.match(cliStatus.stdout, /auditSink=healthy integrity=complete written=\d+ failed=0 dropped=0 pending=\d+\/1024/);

    const cliJson = await execFileAsync(process.execPath, [
      cliPath,
      'audit',
      '--control', controlUrl,
      '--tail', '1000',
      '--json',
    ], { env: { ...process.env, NADO_TOKEN: adminToken } });
    assert.ok(JSON.parse(cliJson.stdout).some((event) => event.statusCode === 413));

    const auditFile = path.join(root, 'exports', 'audit.ndjson');
    const cliExport = await execFileAsync(process.execPath, [
      cliPath,
      'audit',
      '--control', controlUrl,
      '--tail', '1000',
      '--out', auditFile,
    ], { env: { ...process.env, NADO_TOKEN: adminToken } });
    assert.match(cliExport.stdout, /auditExport=/);
    assert.match(await fs.readFile(auditFile, 'utf8'), /"statusCode":413/);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(auditFile)).mode & 0o777, 0o600);
    }

    await closeServer(running.server);
    running = null;
    const mirroredAudit = await fs.readFile(externalAuditFile, 'utf8');
    const mirroredRows = mirroredAudit.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(mirroredRows.some((event) => event.path === '/api/tasks' && event.statusCode === 201));
    assert.ok(mirroredRows.some((event) => event.path === '/api/status' && event.statusCode === 401));
    assert.doesNotMatch(mirroredAudit, new RegExp(adminToken));
    assert.doesNotMatch(mirroredAudit, new RegExp(issued.token));
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(externalAuditFile)).mode & 0o777, 0o600);
    }

    running = await startControlServer({
      host: '127.0.0.1',
      port: 0,
      token: adminToken,
      dataDir,
      storeBackend: 'sqlite',
      rateLimitIp: 0,
      rateLimitAdmin: 0,
      rateLimitWorker: 0,
      rateLimitEnrollment: 0,
      auditNdjsonFile: externalAuditFile,
    });
    controlUrl = `http://127.0.0.1:${running.port}`;
    admin = new NadoClient({ controlUrl, token: adminToken });
    const persisted = await admin.listAuditEvents({ tail: 1_000 });
    assert.ok(persisted.auditEvents.some((event) => event.path === '/api/tasks' && event.statusCode === 201));
    assert.ok(persisted.auditEvents.some((event) => event.path === '/api/tasks' && event.statusCode === 413));
  } finally {
    if (running) {
      await closeServer(running.server);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('external audit sink failure does not block API writes or durable audit', async () => {
  const root = await makeTempDir();
  const adminToken = 'audit-failure-isolation-token';
  const unusableFile = path.join(root, 'audit-target');
  await fs.mkdir(unusableFile);
  const running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token: adminToken,
    dataDir: path.join(root, 'control'),
    auditNdjsonFile: unusableFile,
    rateLimitIp: 0,
    rateLimitAdmin: 0,
    rateLimitWorker: 0,
    rateLimitEnrollment: 0,
  });
  const admin = new NadoClient({ controlUrl: `http://127.0.0.1:${running.port}`, token: adminToken });
  try {
    const created = await admin.createTask({
      title: 'audit sink failure remains isolated',
      type: 'shell',
      command: 'echo safe',
    });
    assert.ok(created.task.id);
    const startedAt = Date.now();
    while (running.auditSink.summary().failedEvents < 1 && Date.now() - startedAt < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(running.auditSink.summary().state, 'degraded');
    assert.equal(running.auditSink.summary().pathExposed, false);
    const status = await admin.status();
    assert.equal(status.security.auditSink.state, 'degraded');
    assert.ok(running.store.listAuditEvents({ tail: 100 }).some((event) => (
      event.path === '/api/tasks' && event.statusCode === 201
    )));
  } finally {
    await closeServer(running.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fixed-window API rate limits return retry guidance and are audited', async () => {
  const root = await makeTempDir();
  const adminToken = 'rate-limit-admin-token';
  const running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token: adminToken,
    dataDir: path.join(root, 'control'),
    rateLimitWindowMs: 150,
    rateLimitIp: 2,
    rateLimitAdmin: 0,
    rateLimitWorker: 0,
    rateLimitEnrollment: 0,
  });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  const admin = new NadoClient({ controlUrl, token: adminToken });

  try {
    assert.equal((await fetch(`${controlUrl}/api/status`, { headers: authHeaders(adminToken) })).status, 200);
    assert.equal((await fetch(`${controlUrl}/api/status`, { headers: authHeaders(adminToken) })).status, 200);
    const limited = await fetch(`${controlUrl}/api/status`, { headers: authHeaders(adminToken) });
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('retry-after'), /^\d+$/);
    assert.equal(limited.headers.get('x-ratelimit-remaining'), '0');

    await new Promise((resolve) => setTimeout(resolve, 200));
    const events = await waitForAudit(admin, (event) => event.statusCode === 429);
    assert.ok(events.some((event) => event.path === '/api/status' && event.statusCode === 429 && event.outcome === 'denied'));
  } finally {
    await closeServer(running.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});
