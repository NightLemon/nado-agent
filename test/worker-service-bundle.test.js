import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  buildWorkerBootstrapBundle,
  buildWorkerBundle,
} from '../src/worker-bundle.js';

const execFileAsync = promisify(execFile);
let syntaxCheckPromise = null;

function assertBashSyntax(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-n'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out checking generated bash syntax: ${stderr}`));
    }, 20_000);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Generated bash syntax failed: code=${code} signal=${signal || '-'} ${stderr}`));
    });
    child.stdin.end(script);
  });
}

async function assertPowerShellSyntax(script) {
  if (process.platform !== 'win32') return;
  const parser = [
    '$tokens=$null; $errors=$null;',
    '[System.Management.Automation.Language.Parser]::ParseInput($env:NADO_BUNDLE_SCRIPT,[ref]$tokens,[ref]$errors) | Out-Null;',
    'if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }',
  ].join(' ');
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parser], {
    env: { ...process.env, NADO_BUNDLE_SCRIPT: script },
    timeout: 20_000,
  });
}

function ensureServiceScriptSyntax(scripts) {
  if (!syntaxCheckPromise) {
    syntaxCheckPromise = (async () => {
      await assertBashSyntax(scripts.installSystemd);
      await assertBashSyntax(scripts.uninstallSystemd);
      await assertPowerShellSyntax(scripts.installScheduledTask);
      await assertPowerShellSyntax(scripts.uninstallScheduledTask);
      await assertBashSyntax(scripts.installLaunchd);
      await assertBashSyntax(scripts.uninstallLaunchd);
    })();
  }
  return syntaxCheckPromise;
}

function textFile(bundle, suffix) {
  const file = bundle.files.find((item) => item.name.endsWith(`/${suffix}`));
  assert.ok(file, `bundle must contain ${suffix}`);
  return file.bytes.toString('utf8');
}

async function assertPersistentServiceAssets(bundle) {
  assert.deepEqual(bundle.manifest.serviceInstallers, [
    'install-systemd.sh',
    'install-scheduled-task.ps1',
    'install-launchd.sh',
  ]);
  assert.equal(bundle.manifest.upgrade.preserveIdentityByReusingDataDir, true);
  assert.equal(bundle.manifest.upgrade.dataDirIsAbsolute, true);
  assert.equal(bundle.manifest.upgrade.requiresDrain, true);
  assert.equal(bundle.manifest.upgrade.serviceReinstallRestartsRuntime, true);
  assert.equal(bundle.manifest.upgrade.rollbackUsesPreviousBundle, true);
  assert.equal(bundle.manifest.runtime.build.protocolVersion, 1);
  assert.match(bundle.manifest.runtime.build.sourceFingerprint, /^sha256:[a-f0-9]{64}$/);

  const installSystemd = textFile(bundle, 'install-systemd.sh');
  const uninstallSystemd = textFile(bundle, 'uninstall-systemd.sh');
  const installScheduledTask = textFile(bundle, 'install-scheduled-task.ps1');
  const uninstallScheduledTask = textFile(bundle, 'uninstall-scheduled-task.ps1');
  const installLaunchd = textFile(bundle, 'install-launchd.sh');
  const uninstallLaunchd = textFile(bundle, 'uninstall-launchd.sh');
  const startBash = textFile(bundle, 'start-worker.sh');
  const startPowerShell = textFile(bundle, 'start-worker.ps1');
  const readme = textFile(bundle, 'BUNDLE.md');

  assert.match(installSystemd, /Wants=network-online\.target/);
  assert.match(installSystemd, /User=\$SERVICE_USER/);
  assert.match(installSystemd, /Environment="HOME=\$ESCAPED_HOME"/);
  assert.match(installSystemd, /Environment="PATH=\$ESCAPED_PATH"/);
  assert.match(installSystemd, /ExecStart=\/usr\/bin\/env bash "\$ESCAPED_BUNDLE\/start-worker\.sh"/);
  assert.match(installSystemd, /Restart=on-failure/);
  assert.match(installSystemd, /Refusing to install a root Worker/);
  assert.match(installSystemd, /systemctl enable "\$SERVICE_NAME\.service"/);
  assert.match(installSystemd, /systemctl restart "\$SERVICE_NAME\.service"/);
  assert.ok(installSystemd.indexOf('systemctl enable "$SERVICE_NAME.service"')
    < installSystemd.indexOf('systemctl restart "$SERVICE_NAME.service"'));
  assert.doesNotMatch(installSystemd, /NADO_TOKEN|enrollment-token/);
  assert.match(uninstallSystemd, /systemctl disable --now/);
  assert.match(uninstallSystemd, /data_retained=/);
  assert.ok(uninstallSystemd.includes(bundle.manifest.dataDir));

  assert.match(installScheduledTask, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(installScheduledTask, /-LogonType Interactive/);
  assert.match(installScheduledTask, /-RestartCount 999/);
  assert.match(installScheduledTask, /Stop-ScheduledTask -TaskName \$TaskName -ErrorAction SilentlyContinue/);
  assert.match(installScheduledTask, /Start-ScheduledTask/);
  assert.ok(installScheduledTask.indexOf('Stop-ScheduledTask')
    < installScheduledTask.indexOf('Register-ScheduledTask'));
  assert.match(uninstallScheduledTask, /Unregister-ScheduledTask/);
  assert.match(uninstallScheduledTask, /data_retained=/);
  assert.ok(uninstallScheduledTask.includes(bundle.manifest.dataDir.replaceAll("'", "''")));

  assert.match(installLaunchd, /Refusing to install a root Worker/);
  assert.match(installLaunchd, /Library\/LaunchAgents/);
  assert.match(installLaunchd, /<key>RunAtLoad<\/key>/);
  assert.match(installLaunchd, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(installLaunchd, /<key>HOME<\/key>/);
  assert.match(installLaunchd, /<key>PATH<\/key>/);
  assert.match(installLaunchd, /launchctl bootstrap "gui\/\$\{EUID\}"/);
  assert.match(installLaunchd, /plutil -lint/);
  assert.match(installLaunchd, /LOG_DIR="\$DATA_DIR\/logs"/);
  assert.ok(installLaunchd.includes(bundle.manifest.dataDir));
  assert.doesNotMatch(installLaunchd, /sudo|NADO_TOKEN|enrollment-token/);
  assert.match(uninstallLaunchd, /launchctl bootout/);
  assert.match(uninstallLaunchd, /data_retained=/);
  assert.ok(uninstallLaunchd.includes(bundle.manifest.dataDir));

  assert.match(readme, /Run Persistently/);
  assert.match(readme, /journalctl -u nado-worker\.service -f/);
  assert.match(readme, /current-user scheduled task/);
  assert.match(readme, /current-user LaunchAgent/);
  assert.match(readme, /does not install a root LaunchDaemon/);
  assert.match(readme, /identity and task data are intentionally retained/);
  assert.match(readme, /Upgrade Or Roll Back The Installed Worker/);
  assert.match(readme, /Drain the Worker from Control/);
  assert.match(readme, /same absolute data directory outside the extracted runtime folder/);
  assert.match(readme, /Keep the previous runtime directory until verification passes/);
  assert.match(readme, /revoke or prune that unused enrollment token/);
  assert.ok(readme.includes(`data directory \`${bundle.manifest.dataDir}\``));
  assert.ok(startBash.includes(`export NADO_BUILD_ID='${bundle.manifest.runtime.build.buildId}'`));
  assert.ok(startPowerShell.includes(`$env:NADO_BUILD_ID='${bundle.manifest.runtime.build.buildId}'`));

  await ensureServiceScriptSyntax({
    installSystemd,
    uninstallSystemd,
    installScheduledTask,
    uninstallScheduledTask,
    installLaunchd,
    uninstallLaunchd,
  });
}

test('fixed-ID Worker bundle includes persistent service installers without duplicating runtime credentials', async () => {
  const bundle = await buildWorkerBundle({
    rootDir: process.cwd(),
    token: 'fixed-worker-token',
    controlUrl: 'https://nado.example.com',
    id: 'home-gpu',
    capabilities: ['code', 'gpu'],
    dataDir: '/var/lib/nado/home-gpu',
  });
  await assertPersistentServiceAssets(bundle);
  assert.equal(bundle.manifest.dataDir, '/var/lib/nado/home-gpu');
  assert.match(textFile(bundle, 'start-worker.sh'), /--data-dir '\/var\/lib\/nado\/home-gpu'/);
});

test('self-service Worker bundle uses the same persistent service wrapper around bootstrap-start', async () => {
  const bundle = await buildWorkerBootstrapBundle({
    rootDir: process.cwd(),
    enrollmentToken: 'nado_enroll_test',
    controlUrl: 'https://nado.example.com',
    capabilities: ['code'],
    strictLocalReadiness: true,
    dataDir: 'C:\\Users\\agent\\.nado-home-worker',
  });
  await assertPersistentServiceAssets(bundle);
  assert.match(textFile(bundle, 'start-worker.sh'), /worker bootstrap-start/);
  assert.equal(bundle.manifest.dataDir, 'C:\\Users\\agent\\.nado-home-worker');
  assert.match(textFile(bundle, 'start-worker.ps1'), /--data-dir 'C:\\Users\\agent\\\.nado-home-worker'/);
});
