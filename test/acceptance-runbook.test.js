import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildAcceptanceRunbook } from '../src/acceptance-runbook.js';
import {
  initializeAcceptanceEvidence,
  recordAcceptanceEvidence,
  validateDeploymentEvidence,
} from '../src/cross-site-acceptance.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

function stepKeys(runbook) {
  return runbook.steps.map((item) => item.key);
}

test('public HTTPS acceptance runbook contains every required live and operator step once', () => {
  const runbook = buildAcceptanceRunbook({
    controlUrl: 'https://nado.example.com',
    workerId: 'home-gpu',
    deploymentMode: 'public_https',
    requireGpu: true,
    requireAgent: true,
    sourceDataDir: '/var/lib/nado',
    backupDir: '/var/backups/nado-acceptance',
    restoredDataDir: '/var/lib/nado-restored',
  });

  assert.deepEqual(stepKeys(runbook), [
    'deployment_boundary',
    'initialize_evidence',
    'physical_separation',
    'outbound_only_onboarding',
    'remote_cancellation',
    'short_disconnect',
    'long_disconnect_recovery',
    'vm_restart_recovery',
    'worker_restart_recovery',
    'large_artifact_resume',
    'large_input_resume',
    'backup_restore',
    'agent_collaboration',
    'credential_revocation',
    'strict_report',
  ]);
  assert.equal(new Set(stepKeys(runbook)).size, runbook.steps.length);
  assert.match(runbook.steps[0].command, /--require-https/);
  assert.match(runbook.steps[0].command, /--require-proxy-auth/);
  assert.match(runbook.steps[0].command, /--require-container-hardening/);
  assert.match(runbook.steps.at(-1).command, /--require-gpu/);
  assert.match(runbook.steps.at(-1).command, /--require-complete/);
  assert.match(runbook.steps.at(-1).command, /--deployment-evidence '\.\/deployment-check\.json'/);
  assert.ok(stepKeys(runbook).indexOf('credential_revocation') < stepKeys(runbook).indexOf('strict_report'));
  assert.doesNotMatch(runbook.script, /\n\+  /);
  assert.match(runbook.script, /# EDIT AND RUN:[\s\S]*# NADO_TOKEN=.*acceptance evidence record/);
  assert.deepEqual(runbook.operatorEditsRequired, ['physical_separation', 'outbound_only_onboarding']);
  assert.deepEqual(runbook.unresolvedPlaceholders, []);
});

test('strict deployment evidence is bound to version, URL, mode, and every required check', () => {
  const keys = [
    'controlContainerHardening', 'httpsUrl', 'publicHealth', 'certificate', 'publicNetwork', 'proxyAuthenticated',
    'forwardedHttps', 'advertisedPublicUrl', 'backendSeparated', 'backendPrivateAddress',
    'backendHealth', 'backendNetwork', 'backendNotProxyAuthenticated', 'backendProxyBoundaryConfigured',
  ];
  const receipt = {
    reportVersion: 2,
    ok: true,
    mode: 'public_https',
    generatedAt: new Date().toISOString(),
    publicControlUrl: 'https://nado.example.com',
    checks: keys.map((key) => ({ key, status: 'passed' })),
  };
  assert.equal(validateDeploymentEvidence(receipt, 'https://nado.example.com').passed, true);

  const wrongUrl = validateDeploymentEvidence(receipt, 'https://other.example.com');
  assert.equal(wrongUrl.passed, false);
  const missing = validateDeploymentEvidence({
    ...receipt,
    checks: receipt.checks.filter((item) => item.key !== 'backendNotProxyAuthenticated'),
  }, 'https://nado.example.com');
  assert.equal(missing.passed, false);
  assert.deepEqual(missing.evidence.missingOrFailed, ['backendNotProxyAuthenticated']);
  assert.equal(validateDeploymentEvidence({ ...receipt, reportVersion: 1 }, 'https://nado.example.com').passed, false);
});

test('private-overlay runbook adds overlay evidence and remains explicit about placeholders', () => {
  const runbook = buildAcceptanceRunbook({
    controlUrl: 'http://100.64.10.20:8765',
    workerId: 'home-worker',
    deploymentMode: 'tailscale',
    overlayInterface: 'tailscale0',
    requireAgent: false,
  });

  assert.equal(runbook.deploymentMode, 'tailscale');
  assert.ok(stepKeys(runbook).includes('encrypted_private_overlay'));
  assert.equal(stepKeys(runbook).includes('agent_collaboration'), false);
  assert.match(runbook.steps[0].command, /--overlay tailscale/);
  assert.match(runbook.steps[0].command, /--overlay-interface 'tailscale0'/);
  assert.doesNotMatch(runbook.steps[0].command, /--require-proxy-auth/);
  assert.match(runbook.steps.at(-1).command, /--no-require-agent/);
  assert.deepEqual(runbook.unresolvedPlaceholders, [
    '<active-control-data-dir>',
    '<new-backup-dir>',
    '<new-restored-data-dir>',
  ]);
  assert.ok(runbook.operatorEditsRequired.includes('backup_restore'));
  const overlayStep = runbook.steps.find((item) => item.key === 'encrypted_private_overlay');
  assert.equal(overlayStep.operatorEditRequired, true);
  assert.match(runbook.script, /REPLACE_ME/);
});

test('acceptance evidence initialization is resumable and preserves completed records', () => {
  const initialized = initializeAcceptanceEvidence({
    version: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    scenarios: {
      physicalSeparation: {
        status: 'passed',
        evidence: 'VM and home host serial/network records inspected',
        references: ['evidence/physical.txt'],
      },
    },
  });

  assert.equal(initialized.generatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(initialized.scenarios.physicalSeparation.status, 'passed');
  assert.equal(initialized.scenarios.physicalSeparation.evidence, 'VM and home host serial/network records inspected');
  assert.equal(initialized.scenarios.shortDisconnect.status, 'pending');
  assert.throws(
    () => initializeAcceptanceEvidence({ version: 1, scenarios: { typo: { status: 'pending' } } }),
    /Unknown acceptance evidence scenario/,
  );
  assert.throws(
    () => recordAcceptanceEvidence(undefined, {
      scenario: 'physicalSeparation',
      status: 'passed',
      note: 'REPLACE_ME: inspect hosts',
      references: ['evidence/physical.txt'],
    }),
    /unresolved placeholder/,
  );
});

test('acceptance evidence init CLI is idempotent and runbook CLI emits structured steps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-acceptance-runbook-'));
  const evidence = path.join(root, 'acceptance-evidence.json');
  try {
    const first = await execFileAsync(process.execPath, [
      cliPath, 'acceptance', 'evidence', 'init', '--file', evidence,
    ]);
    assert.match(first.stdout, /status=created/);
    const second = await execFileAsync(process.execPath, [
      cliPath, 'acceptance', 'evidence', 'init', '--file', evidence,
    ]);
    assert.match(second.stdout, /status=ready/);

    const output = await execFileAsync(process.execPath, [
      cliPath,
      'acceptance',
      'runbook',
      '--control',
      'https://nado.example.com',
      '--worker',
      'home-gpu',
      '--deployment-mode',
      'public_https',
      '--json',
    ]);
    const runbook = JSON.parse(output.stdout);
    assert.equal(runbook.runbookVersion, 2);
    assert.ok(stepKeys(runbook).includes('credential_revocation'));
    assert.ok(stepKeys(runbook).includes('strict_report'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
