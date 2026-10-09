import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { inspectLocalWorker } from '../src/worker-inspect.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

function fakeInventory(overrides = {}) {
  return {
    host: {
      hostname: 'home-compute',
      platform: 'linux',
      arch: 'x64',
      cpus: 24,
      totalmem: 128 * 1024 ** 3,
    },
    tools: {
      node: { available: true, version: process.version },
      codex: { available: true, version: 'codex test' },
      claude: { available: false },
      amdSmi: { available: true, version: 'AMD SMI test' },
      ...overrides.tools,
    },
    resources: {
      gpus: [{
        index: 0,
        vendor: 'amd',
        name: 'AMD Instinct MI300X',
        memoryTotalBytes: 192 * 1024 ** 3,
        memoryFreeBytes: 180 * 1024 ** 3,
        temperatureC: 51,
        utilizationPercent: 3,
      }],
      temperatures: [],
      ...overrides.resources,
    },
    inferredCapabilities: ['agent', 'code', 'gpu', 'shell'],
    collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function signedIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    workerId: 'home-compute-signed',
    workerToken: 'secret-worker-token-must-not-leak',
    workerTokenId: 'wtok_home_compute',
    controlUrl: 'https://nado.example.com',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

test('local Worker inspect proves hardware tools Agent and signed identity without leaking secrets', async () => {
  const report = await inspectLocalWorker({
    inventory: fakeInventory(),
    identity: signedIdentity(),
    dataDirectoryCheck: { ok: true, directory: '/worker-data' },
    agentCommand: 'codex exec {promptFile}',
    agentPreset: 'codex',
    requireGpu: true,
    requireAgent: true,
    requireIdentity: true,
    requiredCapabilities: ['gpu', 'agent'],
    requiredTools: ['amd-smi', 'codex'],
    requiredResources: {
      cpuCores: 8,
      memory: '32GiB',
      gpuCount: 1,
      gpuMemory: '128GiB',
      gpuModel: 'MI300',
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.identity.signedKeyReady, true);
  assert.equal(report.resources.gpuCount, 1);
  assert.equal(report.checks.find((item) => item.key === 'terminalAgentRuntime').status, 'passed');
  assert.equal(report.checks.find((item) => item.key === 'requiredResources').status, 'passed');
  assert.equal(JSON.stringify(report).includes('secret-worker-token-must-not-leak'), false);
  assert.equal(JSON.stringify(report).includes('PRIVATE KEY'), false);
});

test('local Worker inspect fails closed with actionable hardware Agent identity and data-dir gaps', async () => {
  const inventory = fakeInventory({
    tools: {
      codex: { available: false },
      amdSmi: { available: false },
    },
    resources: { gpus: [] },
    inferredCapabilities: ['shell'],
  });
  const report = await inspectLocalWorker({
    inventory,
    identity: null,
    dataDirectoryCheck: { ok: false, directory: '/read-only', error: 'access denied' },
    agentCommand: 'codex exec {promptFile}',
    agentPreset: 'codex',
    requireGpu: true,
    requireAgent: true,
    requireIdentity: true,
    requiredTools: ['amd-smi', 'codex'],
    requiredResources: { cpuCores: 32, gpuCount: 1, gpuMemory: '16GiB' },
  });

  assert.equal(report.ok, false);
  assert.ok(report.summary.failed >= 5);
  assert.equal(report.checks.find((item) => item.key === 'dataDirectory').status, 'failed');
  assert.equal(report.checks.find((item) => item.key === 'gpuRuntime').status, 'failed');
  assert.equal(report.checks.find((item) => item.key === 'workerIdentity').status, 'failed');
  assert.ok(report.nextActions.some((item) => item.key === 'terminalAgentRuntime'));
});

test('local Worker inspect rejects a mismatched enrolled signing keypair', async () => {
  const identity = signedIdentity();
  const other = signedIdentity();
  identity.publicKeyPem = other.publicKeyPem;
  const report = await inspectLocalWorker({
    inventory: fakeInventory(),
    identity,
    dataDirectoryCheck: { ok: true, directory: '/worker-data' },
    requireIdentity: true,
  });

  assert.equal(report.ok, false);
  assert.equal(report.identity.present, true);
  assert.equal(report.identity.signedKeyReady, false);
  assert.match(report.identity.error, /matching Ed25519 keypair/);
  assert.equal(report.checks.find((item) => item.key === 'workerIdentity').status, 'failed');
  assert.equal(JSON.stringify(report).includes(identity.workerToken), false);
});

test('worker inspect CLI emits standalone JSON and strict requirements use exit code 2', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-worker-inspect-'));
  try {
    const normal = await execFileAsync(process.execPath, [
      cliPath,
      'worker',
      'inspect',
      '--data-dir',
      path.join(root, 'normal'),
      '--json',
    ]);
    const normalReport = JSON.parse(normal.stdout);
    assert.equal(normalReport.ok, true);
    assert.equal(normalReport.checks.find((item) => item.key === 'dataDirectory').status, 'passed');

    await assert.rejects(
      () => execFileAsync(process.execPath, [
        cliPath,
        'worker',
        'inspect',
        '--data-dir',
        path.join(root, 'strict'),
        '--require-identity',
        '--json',
      ]),
      (error) => {
        assert.equal(error.code, 2);
        const report = JSON.parse(error.stdout);
        assert.equal(report.ok, false);
        assert.equal(report.checks.find((item) => item.key === 'workerIdentity').status, 'failed');
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
