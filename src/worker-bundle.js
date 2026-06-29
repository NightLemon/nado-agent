import fs from 'node:fs/promises';
import path from 'node:path';
import { buildWorkerInvite } from './invite.js';
import { buildZipArchive, safeZipPath } from './zip.js';

const DEFAULT_INCLUDE = [
  'package.json',
  'README.md',
  'AGENTS.md',
  'src',
  'docs',
];

const DEFAULT_EXCLUDE_DIRS = new Set([
  '.git',
  '.nado',
  'node_modules',
]);

function bundleRootName(workerId) {
  return safeZipPath(`nado-worker-${workerId || 'worker'}`).replaceAll('/', '-');
}

function bootstrapBundleRootName(name = 'bootstrap') {
  return safeZipPath(`nado-worker-${name || 'bootstrap'}`).replaceAll('/', '-');
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function collectPath(rootDir, relativePath, files) {
  const absolute = path.resolve(rootDir, relativePath);
  const stat = await fs.stat(absolute);
  if (stat.isDirectory()) {
    const name = path.basename(relativePath);
    if (DEFAULT_EXCLUDE_DIRS.has(name)) {
      return;
    }
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      await collectPath(rootDir, path.join(relativePath, entry.name), files);
    }
    return;
  }
  if (!stat.isFile()) {
    return;
  }
  files.push({
    relativePath: relativePath.replaceAll(path.sep, '/'),
    bytes: await fs.readFile(absolute),
  });
}

async function collectBundleFiles(rootDir) {
  const files = [];
  for (const item of DEFAULT_INCLUDE) {
    if (await exists(path.resolve(rootDir, item))) {
      await collectPath(rootDir, item, files);
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function bundleReadme({ workerId, controlUrl }) {
  return `# Nado Worker Bundle

This bundle contains the same Nado worker runtime used by the control host.

## Start On Ubuntu / WSL

\`\`\`bash
bash ./start-worker.sh
\`\`\`

## Start On PowerShell

\`\`\`powershell
.\\start-worker.ps1
\`\`\`

The start scripts run \`worker preflight\` before \`worker start\`, using worker ID \`${workerId}\` and control URL \`${controlUrl}\`.
`;
}

function bootstrapReadme({ controlUrl }) {
  return `# Nado Self-Service Worker Bundle

This bundle contains the same Nado worker runtime used by the control host.

The first start generates a local Ed25519 keypair, registers the public key with the control server, receives a worker-scoped token, and stores the assigned worker ID in the local data directory.

## Start On Ubuntu / WSL

\`\`\`bash
bash ./start-worker.sh
\`\`\`

## Start On PowerShell

\`\`\`powershell
.\\start-worker.ps1
\`\`\`

The start scripts connect to \`${controlUrl}\`, enroll or reuse the local worker identity, run signed worker preflight, recover stale identity with the embedded enrollment token when possible, and then run the normal \`src/cli.js worker start\` path.
`;
}

function buildBootstrapStartOptions(options, quote) {
  const values = [
    ['--control', options.controlUrl],
    ['--enrollment-token', options.enrollmentToken],
    ['--data-dir', options.dataDir || '.nado'],
    ['--max-concurrency', options.maxConcurrency || null],
    ['--poll-ms', options.pollMs || null],
    ['--agent', options.agentPreset || null],
    ['--agent-command', options.agentCommand || null],
    ...((options.capabilities || []).map((capability) => ['--capability', capability])),
    ...((options.labels || []).map((label) => ['--label', label])),
    ...(options.cleanupWorkspaces ? [['--cleanup-workspaces', null]] : []),
  ];
  return values
    .filter(([, value]) => value !== undefined && value !== false && value !== '')
    .flatMap(([key, value]) => value === null ? [key] : [key, quote(value)])
    .join(' ');
}

function quoteBash(value) {
  return `'${String(value ?? '').replaceAll("'", "'\\''")}'`;
}

function quotePowerShell(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function buildBootstrapStartScript(options, format) {
  if (format === 'powershell') {
    return [
      '# Run from the extracted nado worker bundle folder.',
      'node .\\src\\cli.js worker bootstrap-start ' + buildBootstrapStartOptions(options, quotePowerShell),
    ].join('\n');
  }
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Run from the extracted nado worker bundle folder.',
    'node ./src/cli.js worker bootstrap-start ' + buildBootstrapStartOptions(options, quoteBash),
  ].join('\n');
}

export async function buildWorkerBundle(options = {}) {
  const {
    rootDir = process.cwd(),
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
    issuedWorkerToken = null,
  } = options;
  if (!id) {
    throw new Error('Worker bundle requires id');
  }
  if (!token) {
    throw new Error('Worker bundle requires token');
  }
  if (!controlUrl) {
    throw new Error('Worker bundle requires controlUrl');
  }

  const bundleRoot = bundleRootName(id);
  const sourceFiles = await collectBundleFiles(rootDir);
  const startBash = buildWorkerInvite({
    token,
    controlUrl,
    id,
    capabilities,
    labels,
    agentPreset,
    agentCommand,
    maxConcurrency,
    cleanupWorkspaces,
    pollMs,
    dataDir,
    format: 'bash',
  });
  const startPowerShell = buildWorkerInvite({
    token,
    controlUrl,
    id,
    capabilities,
    labels,
    agentPreset,
    agentCommand,
    maxConcurrency,
    cleanupWorkspaces,
    pollMs,
    dataDir,
    format: 'powershell',
  });
  const manifest = {
    name: 'nado-worker-bundle',
    workerId: id,
    controlUrl,
    createdAt: new Date().toISOString(),
    files: sourceFiles.length,
    startScripts: ['start-worker.sh', 'start-worker.ps1'],
    token: {
      embedded: true,
      workerScoped: Boolean(issuedWorkerToken),
      workerToken: issuedWorkerToken || null,
    },
    runtime: {
      node: '>=20',
      entrypoint: 'src/cli.js',
      command: 'worker start',
    },
  };
  const generated = [
    {
      relativePath: 'start-worker.sh',
      bytes: `${startBash}\n`,
    },
    {
      relativePath: 'start-worker.ps1',
      bytes: `${startPowerShell}\n`,
    },
    {
      relativePath: 'BUNDLE.md',
      bytes: bundleReadme({ workerId: id, controlUrl }),
    },
    {
      relativePath: 'nado-worker-bundle.json',
      bytes: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ];
  const files = [...generated, ...sourceFiles].map((file) => ({
    name: safeZipPath(bundleRoot, file.relativePath),
    bytes: file.bytes,
  }));
  return {
    manifest,
    bundleRoot,
    files,
    bytes: buildZipArchive(files),
  };
}

export async function buildWorkerBootstrapBundle(options = {}) {
  const {
    rootDir = process.cwd(),
    enrollmentToken,
    controlUrl,
    name = 'bootstrap',
    capabilities = [],
    labels = [],
    agentPreset = null,
    agentCommand = null,
    maxConcurrency = null,
    cleanupWorkspaces = false,
    pollMs = null,
    dataDir = '.nado',
    issuedEnrollmentToken = null,
  } = options;
  if (!enrollmentToken) {
    throw new Error('Worker bootstrap bundle requires enrollmentToken');
  }
  if (!controlUrl) {
    throw new Error('Worker bootstrap bundle requires controlUrl');
  }

  const bundleRoot = bootstrapBundleRootName(name);
  const sourceFiles = await collectBundleFiles(rootDir);
  const startBash = buildBootstrapStartScript({
    enrollmentToken,
    controlUrl,
    capabilities,
    labels,
    agentPreset,
    agentCommand,
    maxConcurrency,
    cleanupWorkspaces,
    pollMs,
    dataDir,
  }, 'bash');
  const startPowerShell = buildBootstrapStartScript({
    enrollmentToken,
    controlUrl,
    capabilities,
    labels,
    agentPreset,
    agentCommand,
    maxConcurrency,
    cleanupWorkspaces,
    pollMs,
    dataDir,
  }, 'powershell');
  const manifest = {
    name: 'nado-worker-bootstrap-bundle',
    controlUrl,
    createdAt: new Date().toISOString(),
    files: sourceFiles.length,
    startScripts: ['start-worker.sh', 'start-worker.ps1'],
    enrollment: {
      embedded: true,
      enrollmentToken: issuedEnrollmentToken || null,
      workerIdAssignedByControl: true,
      workerGeneratesPublicKey: true,
    },
    runtime: {
      node: '>=20',
      entrypoint: 'src/cli.js',
      command: 'worker bootstrap-start',
    },
  };
  const generated = [
    {
      relativePath: 'start-worker.sh',
      bytes: `${startBash}\n`,
    },
    {
      relativePath: 'start-worker.ps1',
      bytes: `${startPowerShell}\n`,
    },
    {
      relativePath: 'BUNDLE.md',
      bytes: bootstrapReadme({ controlUrl }),
    },
    {
      relativePath: 'nado-worker-bundle.json',
      bytes: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ];
  const files = [...generated, ...sourceFiles].map((file) => ({
    name: safeZipPath(bundleRoot, file.relativePath),
    bytes: file.bytes,
  }));
  return {
    manifest,
    bundleRoot,
    files,
    bytes: buildZipArchive(files),
  };
}
