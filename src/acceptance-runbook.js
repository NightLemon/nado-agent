import { normalizeBaseUrl } from './utils.js';

const RUNBOOK_VERSION = 2;

function quoteBash(value) {
  return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function checkedOrigin(value) {
  const normalized = normalizeBaseUrl(value);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Acceptance runbook requires a valid --control URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password
      || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('Acceptance runbook Control URL must be an HTTP(S) origin without credentials, path, query, or fragment');
  }
  return normalized;
}

function command(parts) {
  const continuation = ` ${String.fromCharCode(92)}\n  `;
  return parts.filter(Boolean).join(continuation);
}

function exerciseCommand(name, options) {
  return command([
    'NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js acceptance exercise ' + name,
    '--control ' + quoteBash(options.controlUrl),
    '--worker ' + quoteBash(options.workerId),
    ...options.extra,
    '--evidence ' + quoteBash(options.evidenceFile),
  ]);
}

function operatorEvidenceCommand(scenario, note, reference, evidenceFile) {
  return command([
    'NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js acceptance evidence record',
    '--file ' + quoteBash(evidenceFile),
    '--scenario ' + quoteBash(scenario),
    '--status passed',
    '--note ' + quoteBash(note),
    '--reference ' + quoteBash(reference),
  ]);
}

function step(key, title, commandText, options = {}) {
  return {
    key,
    title,
    command: commandText,
    operatorEditRequired: Boolean(options.operatorEditRequired),
    disruptive: Boolean(options.disruptive),
    scenario: options.scenario || null,
  };
}

export function buildAcceptanceRunbook(options = {}) {
  const controlUrl = checkedOrigin(options.controlUrl);
  const workerId = String(options.workerId || '').trim();
  if (!workerId) {
    throw new Error('Acceptance runbook requires workerId');
  }
  const inferredMode = new URL(controlUrl).protocol === 'https:' ? 'public_https' : 'tailscale';
  const deploymentMode = String(options.deploymentMode || inferredMode).trim().toLowerCase();
  if (!['public_https', 'tailscale', 'wireguard'].includes(deploymentMode)) {
    throw new Error('deploymentMode must be public_https, tailscale, or wireguard');
  }
  const requireGpu = Boolean(options.requireGpu);
  const requireAgent = options.requireAgent !== false;
  const evidenceFile = options.evidenceFile || './acceptance-evidence.json';
  const deploymentReport = options.deploymentReport || './deployment-check.json';
  const acceptanceReport = options.acceptanceReport || './acceptance-report.json';
  const overlayInterface = options.overlayInterface
    || (deploymentMode === 'tailscale' ? 'tailscale0' : deploymentMode === 'wireguard' ? 'wg0' : null);
  const sourceDataDir = options.sourceDataDir || '<active-control-data-dir>';
  const backupDir = options.backupDir || '<new-backup-dir>';
  const restoredDataDir = options.restoredDataDir || '<new-restored-data-dir>';
  const backendControlUrl = options.backendControlUrl || 'http://127.0.0.1:8765';
  const placeholders = [sourceDataDir, backupDir, restoredDataDir]
    .filter((value) => /^<[^>]+>$/.test(value));

  const deployment = deploymentMode === 'public_https'
    ? command([
      'NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js deployment check',
      '--control ' + quoteBash(controlUrl),
      '--backend ' + quoteBash(backendControlUrl),
      '--require-https',
      '--require-proxy-auth',
      '--require-container-hardening',
      '--out ' + quoteBash(deploymentReport),
      '--json',
    ])
    : command([
      'NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js deployment check',
      '--control ' + quoteBash(controlUrl),
      '--overlay ' + deploymentMode,
      '--overlay-interface ' + quoteBash(overlayInterface),
      '--require-container-hardening',
      '--out ' + quoteBash(deploymentReport),
      '--json',
    ]);

  const steps = [
    step('deployment_boundary', 'Capture the network deployment boundary receipt', deployment),
    step('initialize_evidence', 'Create or validate the resumable evidence document', command([
      'node ./src/cli.js acceptance evidence init',
      '--file ' + quoteBash(evidenceFile),
    ])),
    step(
      'physical_separation',
      'Record VM/home physical and network separation after inspection',
      operatorEvidenceCommand(
        'physicalSeparation',
        'REPLACE_ME: identify the VM and home host/network observations',
        'REPLACE_ME: evidence/physical-separation.txt',
        evidenceFile,
      ),
      { operatorEditRequired: true, scenario: 'physicalSeparation' },
    ),
    step(
      'outbound_only_onboarding',
      'Record that the home Worker has no inbound listener or router forwarding',
      operatorEvidenceCommand(
        'outboundOnlyOnboarding',
        'REPLACE_ME: record router, host firewall, and Worker outbound-only observations',
        'REPLACE_ME: evidence/outbound-only.txt',
        evidenceFile,
      ),
      { operatorEditRequired: true, scenario: 'outboundOnlyOnboarding' },
    ),
  ];

  if (deploymentMode !== 'public_https') {
    steps.push(step(
      'encrypted_private_overlay',
      'Record the deployed overlay peer/ACL and public-port denial evidence',
      operatorEvidenceCommand(
        'encryptedPrivateOverlay',
        `REPLACE_ME: inspected ${deploymentMode} peers/ACLs and public TCP 8765 denial`,
        'REPLACE_ME: evidence/private-overlay.txt',
        evidenceFile,
      ),
      { operatorEditRequired: true, scenario: 'encryptedPrivateOverlay' },
    ));
  }

  const exerciseOptions = (extra = []) => ({ controlUrl, workerId, evidenceFile, extra });
  steps.push(
    step('remote_cancellation', 'Prove VM-triggered process cancellation', exerciseCommand('remote-cancellation', exerciseOptions()), { scenario: 'remoteCancellation' }),
    step('short_disconnect', 'Prove same-attempt recovery after a short link outage', exerciseCommand('short-disconnect', exerciseOptions(['--timeout 180000'])), { disruptive: true, scenario: 'shortDisconnect' }),
    step('long_disconnect_recovery', 'Prove lease recovery and stale-result rejection after a long outage', exerciseCommand('long-disconnect-recovery', exerciseOptions(['--timeout 300000'])), { disruptive: true, scenario: 'longDisconnectRecovery' }),
    step('vm_restart_recovery', 'Prove SQLite and Worker recovery across a VM Control restart', exerciseCommand('vm-restart-recovery', exerciseOptions(['--timeout 300000'])), { disruptive: true, scenario: 'vmRestartRecovery' }),
    step('worker_restart_recovery', 'Prove the installed home Worker service recovers with the same signed identity and a new runtime', exerciseCommand('worker-restart-recovery', exerciseOptions(['--timeout 300000'])), { disruptive: true, scenario: 'workerRestartRecovery' }),
    step('large_artifact_resume', 'Prove resumable large artifact upload', exerciseCommand('large-artifact-resume', exerciseOptions(['--timeout 300000'])), { disruptive: true, scenario: 'largeArtifactResume' }),
    step('large_input_resume', 'Prove resumable ranged large input download', exerciseCommand('large-input-resume', exerciseOptions(['--timeout 300000'])), { disruptive: true, scenario: 'largeInputResume' }),
    step('backup_restore', 'Prove verified backup/restore into a fresh Control directory', exerciseCommand('backup-restore', exerciseOptions([
      '--source-data-dir ' + quoteBash(sourceDataDir),
      '--backup-dir ' + quoteBash(backupDir),
      '--restored-data-dir ' + quoteBash(restoredDataDir),
      '--timeout 600000',
    ])), { disruptive: true, operatorEditRequired: placeholders.length > 0, scenario: 'backupRestore' }),
  );
  if (requireAgent) {
    steps.push(step('agent_collaboration', 'Prove two-turn real terminal-Agent collaboration', exerciseCommand('agent-collaboration', exerciseOptions(['--timeout 180000'])), { scenario: 'agentCollaboration' }));
  }
  steps.push(
    step('credential_revocation', 'Rotate the selected Worker credential and prove predecessor rejection', command([
      'NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker manage',
      '--control ' + quoteBash(controlUrl),
      '--id ' + quoteBash(workerId),
      '--action rotate_token',
      '--wait',
      '--evidence ' + quoteBash(evidenceFile),
    ]), { scenario: 'credentialRevocation' }),
    step('strict_report', 'Run the strict final completeness gate', command([
      'NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js acceptance',
      '--control ' + quoteBash(controlUrl),
      '--worker ' + quoteBash(workerId),
      requireGpu ? '--require-gpu' : null,
      requireAgent ? null : '--no-require-agent',
      '--run-verify',
      '--deployment-evidence ' + quoteBash(deploymentReport),
      '--evidence ' + quoteBash(evidenceFile),
      '--out ' + quoteBash(acceptanceReport),
      '--require-complete',
    ])),
  );

  const lines = [
    '# Nado cross-site acceptance runbook',
    '# Run steps in order from an operator terminal. Commands marked EDIT AND RUN',
    '# contain evidence placeholders and must never be accepted unchanged.',
    '',
  ];
  steps.forEach((item, index) => {
    lines.push(`# ${index + 1}. ${item.title}`);
    if (item.disruptive) {
      lines.push('# DISRUPTIVE/SUPERVISED: follow the CLI prompt and deployment guide.');
    }
    if (item.operatorEditRequired) {
      lines.push('# EDIT AND RUN: replace every REPLACE_ME or angle-bracket placeholder first.');
      lines.push(item.command.split('\n').map((line) => `# ${line}`).join('\n'));
    } else {
      lines.push(item.command);
    }
    lines.push('');
  });

  return {
    runbookVersion: RUNBOOK_VERSION,
    generatedAt: new Date().toISOString(),
    controlUrl,
    workerId,
    deploymentMode,
    requirements: { requireGpu, requireAgent },
    files: { evidenceFile, deploymentReport, acceptanceReport },
    operatorEditsRequired: steps.filter((item) => item.operatorEditRequired).map((item) => item.key),
    unresolvedPlaceholders: placeholders,
    steps,
    script: `${lines.join('\n').trimEnd()}\n`,
  };
}
