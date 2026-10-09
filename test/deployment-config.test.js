import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('.');

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), 'utf8');
}

test('Azure HTTPS deployment keeps native control loopback-only and authenticates Caddy forwarding', async () => {
  const [dockerfile, controlEntrypoint, local, base, https, caddy, envExample, cloudInit, ci] = await Promise.all([
    read('Dockerfile'),
    read('deploy/docker/control-entrypoint.sh'),
    read('docker-compose.yml'),
    read('docker-compose.azure.yml'),
    read('docker-compose.azure-https.yml'),
    read('deploy/caddy/Caddyfile'),
    read('.env.example'),
    read('deploy/azure/cloud-init-control.yaml'),
    read('.github/workflows/ci.yml'),
  ]);

  const controlStageStart = dockerfile.indexOf('FROM runtime AS control');
  const workerStageStart = dockerfile.indexOf('FROM runtime AS worker');
  assert.ok(controlStageStart > 0);
  assert.ok(workerStageStart > controlStageStart);
  assert.doesNotMatch(dockerfile.slice(controlStageStart, workerStageStart), /claude-code|apt-get|procps/);
  assert.match(dockerfile.slice(workerStageStart), /@anthropic-ai\/claude-code@2\.1\.96/);
  assert.match(dockerfile, /--mount=type=cache,id=nado-npm-cache/);
  assert.match(dockerfile, /--fetch-retries=5/);
  assert.match(dockerfile, /COPY deploy\/docker\/control-entrypoint\.sh \/usr\/local\/bin\/nado-control-entrypoint/);
  assert.match(dockerfile, /ENTRYPOINT \["nado-control-entrypoint"\]/);

  assert.match(controlEntrypoint, /^#!\/bin\/sh/);
  assert.match(controlEntrypoint, /initialize_volume \/data\/control/);
  assert.match(controlEntrypoint, /initialize_volume \/data\/audit/);
  assert.match(controlEntrypoint, /--reuid="\$control_uid"/);
  assert.match(controlEntrypoint, /--regid="\$control_gid"/);
  assert.match(controlEntrypoint, /--bounding-set=-all/);
  assert.match(controlEntrypoint, /--inh-caps=-all/);
  assert.match(controlEntrypoint, /--ambient-caps=-all/);
  assert.match(controlEntrypoint, /--no-new-privs/);

  assert.match(local, /control:[\s\S]*?target: control[\s\S]*?image: nado-agent-control:local/);
  assert.match(local, /worker-code:[\s\S]*?image: nado-agent-worker:local[\s\S]*?target: worker/);
  assert.match(local, /worker-gpu:[\s\S]*?image: nado-agent-worker:local[\s\S]*?target: worker/);
  assert.match(base, /control:[\s\S]*?target: control[\s\S]*?image: nado-agent-control:azure/);

  const localControl = local.slice(local.indexOf('  control:'), local.indexOf('\n  worker-code:'));
  for (const controlDefinition of [localControl, base]) {
    assert.match(controlDefinition, /read_only: true/);
    assert.match(controlDefinition, /tmpfs:\s*\n\s+- \/tmp:rw,noexec,nosuid,size=67108864,mode=1777/);
    assert.match(controlDefinition, /cap_drop:\s*\n\s+- ALL/);
    assert.match(controlDefinition, /cap_add:\s*\n\s+- CHOWN\s*\n\s+- SETGID\s*\n\s+- SETPCAP\s*\n\s+- SETUID/);
    assert.match(controlDefinition, /security_opt:\s*\n\s+- no-new-privileges:true/);
    assert.match(controlDefinition, /nado-control-data:\/data\/control/);
    assert.match(controlDefinition, /nado-control-audit:\/data\/audit/);
  }

  assert.match(base, /host_ip: "\$\{NADO_DOCKER_HOST_IP:-127\.0\.0\.1\}"/);
  assert.doesNotMatch(base, /NADO_DOCKER_HOST_IP:-0\.0\.0\.0/);

  assert.match(https, /NADO_TRUST_PROXY: "true"/);
  assert.match(https, /NADO_TRUST_PROXY_SECRET: \$\{NADO_TRUST_PROXY_SECRET:\?[^}]+\}/);
  assert.match(https, /NADO_DOMAIN: \$\{NADO_DOMAIN:\?[^}]+\}/);
  assert.match(https, /image: caddy:2\.10-alpine/);
  assert.match(https, /target: 80[\s\S]*published: "\$\{NADO_HTTP_PORT:-80\}"/);
  assert.match(https, /target: 443[\s\S]*published: "\$\{NADO_HTTPS_PORT:-443\}"/);

  assert.match(caddy, /reverse_proxy control:8765/);
  assert.match(caddy, /header_up X-Nado-Proxy-Secret \{\$NADO_TRUST_PROXY_SECRET\}/);
  assert.match(caddy, /header_up X-Forwarded-Host \{host\}/);
  assert.match(caddy, /header_up X-Forwarded-Proto \{scheme\}/);
  assert.match(caddy, /header_up X-Forwarded-For \{remote_host\}/);

  assert.match(envExample, /^NADO_DOCKER_HOST_IP=127\.0\.0\.1$/m);
  assert.match(envExample, /^NADO_DOMAIN=nado\.example\.com$/m);
  assert.match(cloudInit, /NADO_DOCKER_HOST_IP=127\.0\.0\.1/);
  assert.match(cloudInit, /docker-compose\.azure-https\.yml/);

  assert.match(ci, /docker compose -f docker-compose\.yml config --quiet/);
  assert.match(ci, /docker compose -f docker-compose\.azure\.yml -f docker-compose\.azure-https\.yml config --quiet/);
  assert.match(ci, /caddy:2\.10-alpine[\s\S]*?caddy validate --config \/etc\/caddy\/Caddyfile/);
  assert.match(ci, /az bicep install --version v0\.46\.1/);
  assert.match(ci, /az bicep build --file deploy\/azure\/main\.bicep --stdout/);
  assert.match(ci, /docker build --target control -t nado-agent-control:ci \./);
  assert.match(ci, /docker build --target worker -t nado-agent-worker:ci \./);
});

test('private overlay assets keep Nado on tagged or peer-scoped addresses', async () => {
  const [readme, tailscaleAcl, wireguardControl, wireguardWorker] = await Promise.all([
    read('deploy/overlay/README.md'),
    read('deploy/overlay/tailscale-acl.hujson'),
    read('deploy/overlay/wg0-control.conf.example'),
    read('deploy/overlay/wg0-worker.conf.example'),
  ]);

  assert.match(tailscaleAcl, /tag:nado-worker/);
  assert.match(tailscaleAcl, /tag:nado-control:8765/);
  assert.doesNotMatch(tailscaleAcl, /tag:nado-worker:\*/);
  assert.match(wireguardControl, /^Address = 10\.77\.0\.1\/24$/m);
  assert.match(wireguardControl, /^AllowedIPs = 10\.77\.0\.2\/32$/m);
  assert.match(wireguardWorker, /^AllowedIPs = 10\.77\.0\.1\/32$/m);
  assert.match(wireguardWorker, /^PersistentKeepalive = 25$/m);
  assert.match(readme, /home machine keeps the outbound tunnel usable without an inbound home firewall rule/);
  assert.match(readme, /Internet-side TCP 8765 denial probe/);
});

test('Azure Bicep provisions a what-if-ready HTTPS Control baseline without public native port access', async () => {
  const bicep = await read('deploy/azure/main.bicep');
  assert.match(bicep, /^targetScope = 'resourceGroup'$/m);
  assert.match(bicep, /@secure\(\)\s*\n@description\('OpenSSH public key[^\n]+\nparam adminSshPublicKey string/);
  assert.match(bicep, /param allowedSshSourceCidr string/);
  assert.match(bicep, /sourceAddressPrefix: allowedSshSourceCidr/);
  assert.match(bicep, /name: 'allow-http-acme'[\s\S]*?destinationPortRange: '80'[\s\S]*?sourceAddressPrefix: 'Internet'/);
  assert.match(bicep, /name: 'allow-https-control'[\s\S]*?destinationPortRange: '443'[\s\S]*?sourceAddressPrefix: 'Internet'/);
  assert.match(bicep, /name: 'deny-public-native-control'[\s\S]*?access: 'Deny'[\s\S]*?destinationPortRange: '8765'[\s\S]*?sourceAddressPrefix: 'Internet'/);
  assert.doesNotMatch(bicep, /name: 'allow[^']*'[\s\S]{0,400}destinationPortRange: '8765'/);
  assert.match(bicep, /securityType: 'TrustedLaunch'/);
  assert.match(bicep, /secureBootEnabled: true/);
  assert.match(bicep, /vTpmEnabled: true/);
  assert.match(bicep, /disablePasswordAuthentication: true/);
  assert.match(bicep, /patchMode: 'AutomaticByPlatform'/);
  assert.match(bicep, /customData: base64\(cloudInit\)/);
  assert.match(bicep, /var cloudInit = loadTextContent\('cloud-init-control\.yaml'\)/);
  assert.match(bicep, /output publicHttpsUrl string/);
  assert.doesNotMatch(bicep, /NADO_TOKEN|NADO_TRUST_PROXY_SECRET|private.?key/i);
});
