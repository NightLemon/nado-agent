function quoteBash(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildWorkerStartOptions({
  id,
  dataDir = '.nado',
  capabilities = [],
  labels = [],
  agentPreset = null,
  agentCommand = null,
  maxConcurrency = null,
  cleanupWorkspaces = false,
  pollMs = null,
}, quote) {
  if (!id) {
    throw new Error('Worker invite requires id');
  }
  const options = [
    ['--id', id],
    ['--data-dir', dataDir],
  ];
  for (const capability of capabilities) {
    options.push(['--capability', capability]);
  }
  for (const label of labels) {
    options.push(['--label', label]);
  }
  if (agentPreset) {
    options.push(['--agent', agentPreset]);
  }
  if (agentCommand) {
    options.push(['--agent-command', agentCommand]);
  }
  if (maxConcurrency) {
    options.push(['--max-concurrency', maxConcurrency]);
  }
  if (cleanupWorkspaces) {
    options.push(['--cleanup-workspaces', null]);
  }
  if (pollMs) {
    options.push(['--poll-ms', pollMs]);
  }
  return options.flatMap(([key, value]) => (value === null ? [key] : [key, quote(value)])).join(' ');
}

function buildWorkerPreflightCommand({ id, dataDir = '.nado', format = 'bash' }, quote) {
  const cli = format === 'powershell' ? '.\\src\\cli.js' : './src/cli.js';
  const control = format === 'powershell' ? '$env:NADO_CONTROL' : '"$NADO_CONTROL"';
  return `node ${cli} worker preflight --control ${control} --id ${quote(id)} --data-dir ${quote(dataDir)}`;
}

export function buildWorkerInvite({
  token,
  controlUrl,
  id,
  capabilities = [],
  labels = [],
  agentPreset = null,
  agentCommand = null,
  maxConcurrency = null,
  cleanupWorkspaces = false,
  pollMs = null,
  dataDir = '.nado',
  format = 'bash',
}) {
  if (!token) {
    throw new Error('Worker invite requires token');
  }
  if (!controlUrl) {
    throw new Error('Worker invite requires controlUrl');
  }
  if (!['bash', 'powershell'].includes(format)) {
    throw new Error('Worker invite format must be bash or powershell');
  }

  if (format === 'powershell') {
    const options = buildWorkerStartOptions({
      id,
      dataDir,
      capabilities,
      labels,
      agentPreset,
      agentCommand,
      maxConcurrency,
      cleanupWorkspaces,
      pollMs,
    }, quotePowerShell);
    return [
      '# Run from the nado-agent repository root on the worker host.',
      `$env:NADO_TOKEN=${quotePowerShell(token)}`,
      `$env:NADO_CONTROL=${quotePowerShell(controlUrl)}`,
      buildWorkerPreflightCommand({ id, dataDir, format }, quotePowerShell),
      `node .\\src\\cli.js worker start ${options}`,
    ].join('\n');
  }

  const options = buildWorkerStartOptions({
    id,
    dataDir,
    capabilities,
    labels,
    agentPreset,
    agentCommand,
    maxConcurrency,
    cleanupWorkspaces,
    pollMs,
  }, quoteBash);
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Run from the nado-agent repository root on the worker host.',
    `export NADO_TOKEN=${quoteBash(token)}`,
    `export NADO_CONTROL=${quoteBash(controlUrl)}`,
    buildWorkerPreflightCommand({ id, dataDir, format }, quoteBash),
    `node ./src/cli.js worker start ${options}`,
  ].join('\n');
}
