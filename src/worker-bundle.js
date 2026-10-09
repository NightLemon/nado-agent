import fs from 'node:fs/promises';
import path from 'node:path';
import { buildWorkerInvite } from './invite.js';
import { getRuntimeBuildInfo } from './runtime-build.js';
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

function portableAbsolutePath(value) {
  const text = String(value || '');
  return path.posix.isAbsolute(text) || path.win32.isAbsolute(text);
}

function serviceReadme(dataDir = '.nado') {
  return `
## Run Persistently

Ubuntu hosts with systemd can install the Worker as a boot service:

\`\`\`bash
bash ./install-systemd.sh
journalctl -u nado-worker.service -f
\`\`\`

Set \`NADO_SERVICE_NAME\` before installation when this host runs more than one Worker. The installer preserves the invoking user's HOME and PATH so user-installed Node and terminal-Agent CLIs remain available, starts only after the network is online, and restarts the existing start script after failures. Remove it with \`bash ./uninstall-systemd.sh\`; the local \`.nado\` identity and task data are intentionally retained.

On native Windows PowerShell, install a current-user scheduled task:

\`\`\`powershell
.\\install-scheduled-task.ps1
Get-ScheduledTask -TaskName NadoWorker
\`\`\`

It starts at that user's logon so Codex/Claude credentials remain in the correct user profile and retries failures. Set \`NADO_TASK_NAME\` to choose another task name. Remove it with \`.\\uninstall-scheduled-task.ps1\`; Worker identity and data remain on disk.

On macOS, install a current-user LaunchAgent:

\`\`\`bash
bash ./install-launchd.sh
launchctl print gui/$(id -u)/com.nado.worker
\`\`\`

It starts when that user logs in, preserves the user's HOME and current PATH for terminal-Agent credentials and user-installed Node, and restarts only failed exits. The user must remain logged in; Nado deliberately does not install a root LaunchDaemon. Set \`NADO_LAUNCHD_LABEL\` when this Mac runs more than one Worker. Remove it with \`bash ./uninstall-launchd.sh\`; the local \`.nado\` identity, workspaces, and logs are retained.

## Upgrade Or Roll Back The Installed Worker

This bundle is configured to use Worker data directory \`${dataDir}\`. For a production home Worker, generate the first and every later bundle with the same absolute data directory outside the extracted runtime folder. That directory contains the signed identity, session workspaces, partial transfers, and diagnostics; never copy it into a bundle or run two Worker runtimes against it concurrently.

1. Drain the Worker from Control and wait until its running slots reach zero.
2. Extract the new bundle beside the old runtime. Run the new runtime's \`worker inspect --data-dir ${dataDir} --require-identity --json\` before switching.
3. Re-run the matching installer from the new bundle with the same service/task/LaunchAgent name. The Linux and Windows installers stop/restart an existing installation; launchd replaces the current-user job. No token or private key is written into the service definition.
4. Confirm the new runtime/build in \`nado workers\`, resume the Worker, and run a target-pinned Doctor self-test.

Keep the previous runtime directory until verification passes. Roll back by draining again and re-running the previous bundle's installer with the same service name and unchanged data directory. Do not delete or replace the shared data directory during rollback. If a newly generated self-service bundle left its enrollment token unused because the existing identity was valid, revoke or prune that unused enrollment token after the upgrade.
`;
}

function systemdInstallScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

BUNDLE_DIR="$(cd -- "$(dirname -- "${'${BASH_SOURCE[0]}'}")" && pwd -P)"
SERVICE_NAME="${'${NADO_SERVICE_NAME:-nado-worker}'}"
SERVICE_USER="${'${NADO_SERVICE_USER:-${SUDO_USER:-$(id -un)}}'}"
NODE_BIN="${'${NADO_NODE_BIN:-$(command -v node || true)}'}"
SERVICE_PATH="${'${PATH}'}"

if [[ ! "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  echo "Invalid NADO_SERVICE_NAME: $SERVICE_NAME" >&2
  exit 2
fi
if [[ "$SERVICE_USER" == "root" && -z "${'${NADO_SERVICE_USER:-}'}" && -z "${'${SUDO_USER:-}'}" ]]; then
  echo "Refusing to install a root Worker; set NADO_SERVICE_USER to the dedicated login that owns the Agent credentials" >&2
  exit 2
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required; enable systemd first on this Ubuntu/WSL host" >&2
  exit 2
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "node is required on PATH before installing the Worker service" >&2
  exit 2
fi
if ! getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Service user does not exist: $SERVICE_USER" >&2
  exit 2
fi
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"

if [[ "${'${EUID}'}" -ne 0 ]]; then
  exec sudo env \
    NADO_SERVICE_NAME="$SERVICE_NAME" \
    NADO_SERVICE_USER="$SERVICE_USER" \
    NADO_SERVICE_BUNDLE_DIR="$BUNDLE_DIR" \
    NADO_SERVICE_HOME="$SERVICE_HOME" \
    NADO_SERVICE_PATH="$SERVICE_PATH" \
    NADO_NODE_BIN="$NODE_BIN" \
    bash "$0"
fi

BUNDLE_DIR="${'${NADO_SERVICE_BUNDLE_DIR:-$BUNDLE_DIR}'}"
SERVICE_HOME="${'${NADO_SERVICE_HOME:-$SERVICE_HOME}'}"
SERVICE_PATH="${'${NADO_SERVICE_PATH:-$SERVICE_PATH}'}"
UNIT_PATH="/etc/systemd/system/$SERVICE_NAME.service"

escape_unit_value() {
${String.raw`  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g'`}
}

ESCAPED_BUNDLE="$(escape_unit_value "$BUNDLE_DIR")"
ESCAPED_HOME="$(escape_unit_value "$SERVICE_HOME")"
ESCAPED_PATH="$(escape_unit_value "$SERVICE_PATH")"

cat >"$UNIT_PATH" <<UNIT
[Unit]
Description=Nado cross-site Agent Worker
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory="$ESCAPED_BUNDLE"
Environment="HOME=$ESCAPED_HOME"
Environment="PATH=$ESCAPED_PATH"
ExecStart=/usr/bin/env bash "$ESCAPED_BUNDLE/start-worker.sh"
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
KillMode=mixed

[Install]
WantedBy=multi-user.target
UNIT

chmod 0644 "$UNIT_PATH"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME.service"
systemctl restart "$SERVICE_NAME.service"
echo "installed=$SERVICE_NAME.service"
echo "logs=journalctl -u $SERVICE_NAME.service -f"
`;
}

function systemdUninstallScript(dataDir = '.nado') {
  return `#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${'${NADO_SERVICE_NAME:-nado-worker}'}"
BUNDLE_DIR="$(cd -- "$(dirname -- "${'${BASH_SOURCE[0]}'}")" && pwd -P)"
DATA_DIR=${quoteBash(dataDir)}
if [[ "$DATA_DIR" != /* ]]; then DATA_DIR="$BUNDLE_DIR/$DATA_DIR"; fi
if [[ ! "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  echo "Invalid NADO_SERVICE_NAME: $SERVICE_NAME" >&2
  exit 2
fi
if [[ "${'${EUID}'}" -ne 0 ]]; then
  exec sudo env NADO_SERVICE_NAME="$SERVICE_NAME" bash "$0"
fi

systemctl disable --now "$SERVICE_NAME.service" 2>/dev/null || true
rm -f -- "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl reset-failed "$SERVICE_NAME.service" 2>/dev/null || true
echo "removed=$SERVICE_NAME.service"
echo "data_retained=$DATA_DIR"
`;
}

function scheduledTaskInstallScript() {
  return `$ErrorActionPreference = 'Stop'
$BundleDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = if ($env:NADO_TASK_NAME) { $env:NADO_TASK_NAME } else { 'NadoWorker' }
if ($TaskName -notmatch '^[A-Za-z0-9._ -]{1,128}$') {
  throw "Invalid NADO_TASK_NAME: $TaskName"
}
$PowerShell = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $PowerShell) { $PowerShell = Get-Command powershell -ErrorAction Stop }
$StartScript = Join-Path $BundleDir 'start-worker.ps1'
$Action = New-ScheduledTaskAction -Execute $PowerShell.Source -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $StartScript + '"') -WorkingDirectory $BundleDir
$UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description 'Nado cross-site Agent Worker' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "installed=$TaskName"
Write-Output "inspect=Get-ScheduledTask -TaskName '$TaskName'"
`;
}

function scheduledTaskUninstallScript(dataDir = '.nado') {
  return `$ErrorActionPreference = 'Stop'
$TaskName = if ($env:NADO_TASK_NAME) { $env:NADO_TASK_NAME } else { 'NadoWorker' }
if ($TaskName -notmatch '^[A-Za-z0-9._ -]{1,128}$') {
  throw "Invalid NADO_TASK_NAME: $TaskName"
}
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
$BundleDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = ${quotePowerShell(dataDir)}
if (-not [IO.Path]::IsPathRooted($DataDir)) { $DataDir = Join-Path $BundleDir $DataDir }
Write-Output "removed=$TaskName"
Write-Output "data_retained=$DataDir"
`;
}

function launchdInstallScript(dataDir = '.nado') {
  return `#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "launchd installation is supported only on macOS" >&2
  exit 2
fi
if [[ "${'${EUID}'}" -eq 0 ]]; then
  echo "Refusing to install a root Worker; run as the macOS login that owns the Agent credentials" >&2
  exit 2
fi
if ! command -v launchctl >/dev/null 2>&1 || ! command -v plutil >/dev/null 2>&1; then
  echo "launchctl and plutil are required on macOS" >&2
  exit 2
fi

BUNDLE_DIR="$(cd -- "$(dirname -- "${'${BASH_SOURCE[0]}'}")" && pwd -P)"
DATA_DIR=${quoteBash(dataDir)}
if [[ "$DATA_DIR" != /* ]]; then DATA_DIR="$BUNDLE_DIR/$DATA_DIR"; fi
LABEL="${'${NADO_LAUNCHD_LABEL:-com.nado.worker}'}"
NODE_BIN="${'${NADO_NODE_BIN:-$(command -v node || true)}'}"
SERVICE_PATH="${'${PATH}'}"
USER_HOME="${'${HOME:?HOME is required for a current-user LaunchAgent}'}"

if [[ ! "$LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$ ]]; then
  echo "Invalid NADO_LAUNCHD_LABEL: $LABEL" >&2
  exit 2
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "node is required on PATH before installing the Worker LaunchAgent" >&2
  exit 2
fi
if [[ ! -f "$BUNDLE_DIR/start-worker.sh" ]]; then
  echo "start-worker.sh is missing from the Worker bundle" >&2
  exit 2
fi

NODE_DIR="$(dirname -- "$NODE_BIN")"
case ":$SERVICE_PATH:" in
  *":$NODE_DIR:"*) ;;
  *) SERVICE_PATH="$NODE_DIR:$SERVICE_PATH" ;;
esac

PLIST_DIR="$USER_HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$DATA_DIR/logs"
mkdir -p -- "$PLIST_DIR" "$LOG_DIR"
chmod 0700 "$DATA_DIR" "$LOG_DIR"

xml_escape() {
${String.raw`  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'`}
}

LABEL_XML="$(xml_escape "$LABEL")"
BUNDLE_XML="$(xml_escape "$BUNDLE_DIR")"
HOME_XML="$(xml_escape "$USER_HOME")"
PATH_XML="$(xml_escape "$SERVICE_PATH")"
START_XML="$(xml_escape "$BUNDLE_DIR/start-worker.sh")"
STDOUT_XML="$(xml_escape "$LOG_DIR/worker.stdout.log")"
STDERR_XML="$(xml_escape "$LOG_DIR/worker.stderr.log")"
PLIST_TMP="$(mktemp "$PLIST_DIR/.$LABEL.plist.XXXXXX")"
cleanup() { rm -f -- "$PLIST_TMP"; }
trap cleanup EXIT

cat >"$PLIST_TMP" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL_XML</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$START_XML</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$BUNDLE_XML</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME_XML</string>
    <key>PATH</key>
    <string>$PATH_XML</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>$STDOUT_XML</string>
  <key>StandardErrorPath</key>
  <string>$STDERR_XML</string>
</dict>
</plist>
PLIST

chmod 0600 "$PLIST_TMP"
plutil -lint "$PLIST_TMP" >/dev/null
launchctl bootout "gui/${'${EUID}'}/$LABEL" >/dev/null 2>&1 || true
mv -f -- "$PLIST_TMP" "$PLIST_PATH"
trap - EXIT
launchctl enable "gui/${'${EUID}'}/$LABEL"
launchctl bootstrap "gui/${'${EUID}'}" "$PLIST_PATH"
launchctl kickstart -k "gui/${'${EUID}'}/$LABEL"
echo "installed=$LABEL"
echo "inspect=launchctl print gui/${'${EUID}'}/$LABEL"
echo "logs=$LOG_DIR"
`;
}

function launchdUninstallScript(dataDir = '.nado') {
  return `#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "launchd removal is supported only on macOS" >&2
  exit 2
fi
if [[ "${'${EUID}'}" -eq 0 ]]; then
  echo "Refusing to remove a current-user LaunchAgent as root" >&2
  exit 2
fi

LABEL="${'${NADO_LAUNCHD_LABEL:-com.nado.worker}'}"
if [[ ! "$LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$ ]]; then
  echo "Invalid NADO_LAUNCHD_LABEL: $LABEL" >&2
  exit 2
fi

BUNDLE_DIR="$(cd -- "$(dirname -- "${'${BASH_SOURCE[0]}'}")" && pwd -P)"
DATA_DIR=${quoteBash(dataDir)}
if [[ "$DATA_DIR" != /* ]]; then DATA_DIR="$BUNDLE_DIR/$DATA_DIR"; fi
PLIST_PATH="${'${HOME:?HOME is required}'}/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/${'${EUID}'}/$LABEL" >/dev/null 2>&1 || true
rm -f -- "$PLIST_PATH"
echo "removed=$LABEL"
echo "data_retained=$DATA_DIR"
`;
}

function serviceFiles(dataDir = '.nado') {
  return [
    { relativePath: 'install-systemd.sh', bytes: systemdInstallScript() },
    { relativePath: 'uninstall-systemd.sh', bytes: systemdUninstallScript(dataDir) },
    { relativePath: 'install-scheduled-task.ps1', bytes: scheduledTaskInstallScript() },
    { relativePath: 'uninstall-scheduled-task.ps1', bytes: scheduledTaskUninstallScript(dataDir) },
    { relativePath: 'install-launchd.sh', bytes: launchdInstallScript(dataDir) },
    { relativePath: 'uninstall-launchd.sh', bytes: launchdUninstallScript(dataDir) },
  ];
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

function bundleReadme({ workerId, controlUrl, dataDir }) {
  return `# Nado Worker Bundle

This bundle contains the same Nado worker runtime used by the control host.

## Start On Ubuntu / WSL / macOS

\`\`\`bash
bash ./start-worker.sh
\`\`\`

## Start On PowerShell

\`\`\`powershell
.\\start-worker.ps1
\`\`\`

The start scripts run \`worker preflight\` before \`worker start\`, using worker ID \`${workerId}\` and control URL \`${controlUrl}\`.

Run \`node ./src/cli.js worker inspect --data-dir .nado --json\` for a control-independent local hardware/tool report. Add strict flags such as \`--require-agent\`, \`--require-gpu\`, and \`--require-identity\` for deployment gates. This report never proves WAN reachability; keep the signed online preflight in the start script.
${serviceReadme(dataDir)}
`;
}

function bootstrapReadme({ controlUrl, dataDir }) {
  return `# Nado Self-Service Worker Bundle

This bundle contains the same Nado worker runtime used by the control host.

The first start generates a local Ed25519 keypair, registers the public key with the control server, receives a worker-scoped token, and stores the assigned worker ID in the local data directory.

## Start On Ubuntu / WSL / macOS

\`\`\`bash
bash ./start-worker.sh
\`\`\`

## Start On PowerShell

\`\`\`powershell
.\\start-worker.ps1
\`\`\`

The start scripts connect to \`${controlUrl}\`, enroll or reuse the local worker identity, run signed worker preflight, recover stale identity with the embedded enrollment token when possible, and then run the normal \`src/cli.js worker start\` path.

Run \`node ./src/cli.js worker inspect --data-dir .nado --json\` before enrollment for a control-independent local hardware/tool report. After the first successful start, add \`--require-identity\` to validate the stored matching Ed25519 identity. Offline inspection does not prove WAN reachability or token validity.

If \`nado-worker-bundle.json\` records \`strictLocalReadiness: true\`, the start script runs equivalent fail-closed host checks before enrollment and validates the stored identity after signed online preflight. A damaged keypair requires a fresh enrollment token so bootstrap can replace it safely.
${serviceReadme(dataDir)}
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
    ...(options.strictLocalReadiness ? [['--strict-local-readiness', null]] : []),
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
      ...(options.buildId ? [`$env:NADO_BUILD_ID=${quotePowerShell(options.buildId)}`] : []),
      'node .\\src\\cli.js worker bootstrap-start ' + buildBootstrapStartOptions(options, quotePowerShell),
    ].join('\n');
  }
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Run from the extracted nado worker bundle folder.',
    ...(options.buildId ? [`export NADO_BUILD_ID=${quoteBash(options.buildId)}`] : []),
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
  const runtimeBuild = await getRuntimeBuildInfo({ rootDir });
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
    buildId: runtimeBuild.buildId,
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
    buildId: runtimeBuild.buildId,
    format: 'powershell',
  });
  const manifest = {
    name: 'nado-worker-bundle',
    workerId: id,
    controlUrl,
    createdAt: new Date().toISOString(),
    files: sourceFiles.length,
    dataDir,
    startScripts: ['start-worker.sh', 'start-worker.ps1'],
    serviceInstallers: ['install-systemd.sh', 'install-scheduled-task.ps1', 'install-launchd.sh'],
    token: {
      embedded: true,
      workerScoped: Boolean(issuedWorkerToken),
      workerToken: issuedWorkerToken || null,
    },
    runtime: {
      node: '>=20',
      entrypoint: 'src/cli.js',
      command: 'worker start',
      build: runtimeBuild,
    },
    upgrade: {
      preserveIdentityByReusingDataDir: true,
      dataDirIsAbsolute: portableAbsolutePath(dataDir),
      requiresDrain: true,
      serviceReinstallRestartsRuntime: true,
      rollbackUsesPreviousBundle: true,
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
      bytes: bundleReadme({ workerId: id, controlUrl, dataDir }),
    },
    {
      relativePath: 'nado-worker-bundle.json',
      bytes: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    ...serviceFiles(dataDir),
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
    strictLocalReadiness = false,
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
  const runtimeBuild = await getRuntimeBuildInfo({ rootDir });
  const startBash = buildBootstrapStartScript({
    enrollmentToken,
    controlUrl,
    capabilities,
    labels,
    agentPreset,
    agentCommand,
    maxConcurrency,
    strictLocalReadiness,
    cleanupWorkspaces,
    pollMs,
    dataDir,
    buildId: runtimeBuild.buildId,
  }, 'bash');
  const startPowerShell = buildBootstrapStartScript({
    enrollmentToken,
    controlUrl,
    capabilities,
    labels,
    agentPreset,
    agentCommand,
    maxConcurrency,
    strictLocalReadiness,
    cleanupWorkspaces,
    pollMs,
    dataDir,
    buildId: runtimeBuild.buildId,
  }, 'powershell');
  const manifest = {
    name: 'nado-worker-bootstrap-bundle',
    controlUrl,
    createdAt: new Date().toISOString(),
    files: sourceFiles.length,
    dataDir,
    startScripts: ['start-worker.sh', 'start-worker.ps1'],
    serviceInstallers: ['install-systemd.sh', 'install-scheduled-task.ps1', 'install-launchd.sh'],
    enrollment: {
      embedded: true,
      enrollmentToken: issuedEnrollmentToken || null,
      workerIdAssignedByControl: true,
      workerGeneratesPublicKey: true,
    },
    strictLocalReadiness: Boolean(strictLocalReadiness),
    runtime: {
      node: '>=20',
      entrypoint: 'src/cli.js',
      command: 'worker bootstrap-start',
      build: runtimeBuild,
    },
    upgrade: {
      preserveIdentityByReusingDataDir: true,
      dataDirIsAbsolute: portableAbsolutePath(dataDir),
      requiresDrain: true,
      serviceReinstallRestartsRuntime: true,
      rollbackUsesPreviousBundle: true,
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
      bytes: bootstrapReadme({ controlUrl, dataDir }),
    },
    {
      relativePath: 'nado-worker-bundle.json',
      bytes: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    ...serviceFiles(dataDir),
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
