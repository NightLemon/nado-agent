import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startControlServer } from '../src/control-server.js';
import {
  inspectDockerComposeBindings,
  inspectDockerComposeControlSecurity,
  runDeploymentCheck,
} from '../src/deployment-check.js';
import { NadoClient } from '../src/http-client.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

function fakeClient({ health = { status: 'ok' }, network, healthError, networkError }) {
  return {
    async health() {
      if (healthError) {
        throw healthError;
      }
      return health;
    },
    async networkInfo() {
      if (networkError) {
        throw networkError;
      }
      return network;
    },
  };
}

function check(report, key) {
  return report.checks.find((item) => item.key === key);
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-deployment-check-'));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function startForwardProxy({ backendUrl, proxySecret }) {
  const server = http.createServer(async (request, response) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) {
          headers.set(key, Array.isArray(value) ? value.join(',') : value);
        }
      }
      headers.set('x-nado-proxy-secret', proxySecret);
      headers.set('x-forwarded-host', request.headers.host || '127.0.0.1');
      headers.set('x-forwarded-proto', 'http');
      headers.set('x-forwarded-for', '198.51.100.20');
      const upstream = await fetch(`${backendUrl}${request.url}`, {
        method: request.method,
        headers,
      });
      response.statusCode = upstream.status;
      response.setHeader('content-type', upstream.headers.get('content-type') || 'application/octet-stream');
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      response.statusCode = 502;
      response.end(error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

test('deployment check proves the strict public HTTPS and private backend boundary', async () => {
  const publicControlUrl = 'https://nado.example.com';
  const publicClient = fakeClient({
    network: {
      requestProtocol: 'https',
      proxyAuthenticated: true,
      publicControlUrl,
    },
  });
  const backendClient = fakeClient({
    network: {
      requestProtocol: 'http',
      proxyAuthenticated: false,
      trustProxyConfigured: true,
      proxyAuthenticationConfigured: true,
    },
  });

  const report = await runDeploymentCheck({
    publicControlUrl,
    backendControlUrl: 'http://127.0.0.1:8765',
    requireHttps: true,
    requireProxyAuthentication: true,
    publicClient,
    backendClient,
  });

  assert.equal(report.ok, true);
  assert.equal(report.reportVersion, 2);
  assert.equal(check(report, 'controlContainerHardening').status, 'skipped');
  assert.equal(check(report, 'certificate').status, 'passed');
  assert.equal(check(report, 'proxyAuthenticated').status, 'passed');
  assert.equal(check(report, 'forwardedHttps').status, 'passed');
  assert.equal(check(report, 'advertisedPublicUrl').status, 'passed');
  assert.equal(check(report, 'backendPrivateAddress').status, 'passed');
  assert.equal(check(report, 'backendNotProxyAuthenticated').status, 'passed');
  assert.equal(check(report, 'backendProxyBoundaryConfigured').status, 'passed');
  assert.deepEqual(report.problems, []);
});

test('deployment check proves a direct Tailscale listener on the VM interface', async () => {
  const controlUrl = 'http://100.64.10.20:8765';
  const report = await runDeploymentCheck({
    publicControlUrl: controlUrl,
    overlayKind: 'tailscale',
    overlayInterface: 'tailscale0',
    networkInterfaces: {
      eth0: [{ address: '10.0.0.4', family: 'IPv4', internal: false }],
      tailscale0: [{ address: '100.64.10.20', family: 'IPv4', internal: false }],
    },
    overlayPublishedBindings: {
      composeFile: 'docker-compose.azure.yml',
      service: 'control',
      containerPort: 8765,
      bindings: [{ host: '100.64.10.20', port: 8765 }, { host: '127.0.0.1', port: 8765 }],
    },
    publicClient: fakeClient({
      network: {
        requestProtocol: 'http',
        proxyAuthenticated: false,
        publicControlUrl: controlUrl,
      },
    }),
  });

  assert.equal(report.ok, true);
  assert.equal(report.mode, 'private_overlay');
  assert.equal(check(report, 'overlayAddress').status, 'passed');
  assert.equal(check(report, 'overlayInterface').status, 'passed');
  assert.equal(check(report, 'overlayEncryptedTransport').status, 'passed');
  assert.equal(check(report, 'overlayPublishedBinding').status, 'passed');
  assert.equal(check(report, 'overlayDirectRequest').status, 'passed');
  assert.equal(check(report, 'advertisedPublicUrl').status, 'passed');
  assert.equal(check(report, 'backendSeparation').status, 'skipped');
  assert.equal(report.nextActions.some((item) => item.key === 'verify_backend_boundary'), false);
});

test('deployment check supports a private WireGuard listener', async () => {
  const controlUrl = 'http://10.77.0.1:8765';
  const report = await runDeploymentCheck({
    publicControlUrl: controlUrl,
    overlayKind: 'wireguard',
    networkInterfaces: {
      wg0: [{ address: '10.77.0.1', family: 'IPv4', internal: false }],
    },
    overlayPublishedBindings: {
      bindings: [{ host: '10.77.0.1', port: 8765 }],
    },
    publicClient: fakeClient({
      network: {
        requestProtocol: 'http',
        proxyAuthenticated: false,
        publicControlUrl: controlUrl,
      },
    }),
  });

  assert.equal(report.ok, true);
  assert.equal(check(report, 'overlayInterface').observed.interface, 'wg0');
});

test('deployment check fails closed when overlay URL and local interface do not match', async () => {
  const controlUrl = 'http://192.168.1.20:8765';
  const report = await runDeploymentCheck({
    publicControlUrl: controlUrl,
    overlayKind: 'tailscale',
    networkInterfaces: {
      tailscale0: [{ address: '100.64.10.20', family: 'IPv4', internal: false }],
    },
    overlayPublishedBindings: {
      bindings: [{ host: '0.0.0.0', port: 8765 }],
    },
    publicClient: fakeClient({
      network: {
        requestProtocol: 'http',
        proxyAuthenticated: true,
        publicControlUrl: 'http://100.64.10.20:8765',
      },
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(check(report, 'overlayAddress').status, 'failed');
  assert.equal(check(report, 'overlayInterface').status, 'failed');
  assert.equal(check(report, 'overlayEncryptedTransport').status, 'failed');
  assert.equal(check(report, 'overlayDirectRequest').status, 'failed');
  assert.equal(check(report, 'overlayPublishedBinding').status, 'failed');
  assert.equal(check(report, 'advertisedPublicUrl').status, 'failed');
  assert.ok(report.nextActions.some((item) => item.key === 'fix_overlay_binding'));
});

test('Docker Compose binding inspection parses live IPv4 and IPv6 publications', async () => {
  const result = await inspectDockerComposeBindings({
    composeFile: 'custom.yml',
    service: 'gateway',
    containerPort: 9876,
    execFile: async (file, args) => {
      assert.equal(file, 'docker');
      assert.deepEqual(args, ['compose', '-f', 'custom.yml', 'port', 'gateway', '9876']);
      return { stdout: '100.64.1.2:9876\n[::1]:9876\n' };
    },
  });
  assert.deepEqual(result.bindings, [
    { host: '100.64.1.2', port: 9876 },
    { host: '::1', port: 9876 },
  ]);
});

test('Docker control inspection proves the live non-root capability-free runtime', async () => {
  const processStatus = [
    'Uid:\t1000\t1000\t1000\t1000',
    'Gid:\t1000\t1000\t1000\t1000',
    'CapInh:\t0000000000000000',
    'CapPrm:\t0000000000000000',
    'CapEff:\t0000000000000000',
    'CapBnd:\t0000000000000000',
    'CapAmb:\t0000000000000000',
    'NoNewPrivs:\t1',
  ].join('\n');
  const security = await inspectDockerComposeControlSecurity({
    composeFile: 'custom.yml',
    service: 'gateway',
    execFile: async (file, args) => {
      assert.equal(file, 'docker');
      if (args[0] === 'compose') {
        assert.deepEqual(args, ['compose', '-f', 'custom.yml', 'ps', '-q', 'gateway']);
        return { stdout: 'container-id\n' };
      }
      if (args[0] === 'inspect') {
        return {
          stdout: JSON.stringify([{
            HostConfig: {
              ReadonlyRootfs: true,
              SecurityOpt: ['no-new-privileges:true'],
              Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=67108864,mode=1777' },
            },
            Mounts: [
              { Destination: '/data/control', Type: 'volume', RW: true, Source: '/secret/host/path' },
              { Destination: '/data/audit', Type: 'volume', RW: true, Source: '/another/host/path' },
              { Destination: '/etc/readonly.conf', Type: 'bind', RW: false, Source: '/private/config' },
            ],
          }]),
        };
      }
      assert.deepEqual(args, ['exec', 'container-id', 'sh', '-c', 'cat /proc/1/status']);
      return { stdout: processStatus };
    },
  });

  assert.equal(security.ok, true);
  assert.equal(security.process.capabilitiesZero, true);
  assert.deepEqual(security.process.uids, [1000, 1000, 1000, 1000]);
  assert.equal(security.tmpfs.safe, true);
  assert.equal(JSON.stringify(security).includes('/secret/host/path'), false);

  const passed = await runDeploymentCheck({
    publicControlUrl: 'http://127.0.0.1:8765',
    requireContainerHardening: true,
    controlSecurity: security,
    publicClient: fakeClient({ network: { requestProtocol: 'http', proxyAuthenticated: false } }),
  });
  assert.equal(passed.ok, true);
  assert.equal(check(passed, 'controlContainerHardening').status, 'passed');

  const failed = await runDeploymentCheck({
    publicControlUrl: 'http://127.0.0.1:8765',
    requireContainerHardening: true,
    controlSecurity: { ...security, ok: false, issues: ['Control PID 1 retains capabilities'] },
    publicClient: fakeClient({ network: { requestProtocol: 'http', proxyAuthenticated: false } }),
  });
  assert.equal(failed.ok, false);
  assert.equal(check(failed, 'controlContainerHardening').status, 'failed');
  assert.ok(failed.nextActions.some((item) => item.key === 'harden_control_container'));
});

test('deployment check rejects conflicting public-edge and private-overlay requirements', async () => {
  await assert.rejects(
    runDeploymentCheck({
      publicControlUrl: 'http://100.64.10.20:8765',
      overlayKind: 'tailscale',
      requireHttps: true,
      publicClient: {},
    }),
    /cannot be combined/,
  );
  await assert.rejects(
    runDeploymentCheck({
      publicControlUrl: 'http://100.64.10.20:8765',
      overlayKind: 'unknown',
      publicClient: {},
    }),
    /tailscale or wireguard/,
  );
});

test('deployment check fails closed on spoofable proxy evidence and a public backend', async () => {
  const report = await runDeploymentCheck({
    publicControlUrl: 'https://nado.example.com',
    backendControlUrl: 'https://backend.example.com',
    requireHttps: true,
    requireProxyAuthentication: true,
    publicClient: fakeClient({
      network: {
        requestProtocol: 'http',
        proxyAuthenticated: false,
        publicControlUrl: 'https://wrong.example.com',
      },
    }),
    backendClient: fakeClient({
      network: {
        proxyAuthenticated: true,
        trustProxyConfigured: false,
        proxyAuthenticationConfigured: false,
      },
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(check(report, 'proxyAuthenticated').status, 'failed');
  assert.equal(check(report, 'forwardedHttps').status, 'failed');
  assert.equal(check(report, 'advertisedPublicUrl').status, 'failed');
  assert.equal(check(report, 'backendPrivateAddress').status, 'failed');
  assert.equal(check(report, 'backendNotProxyAuthenticated').status, 'failed');
  assert.equal(check(report, 'backendProxyBoundaryConfigured').status, 'failed');
  assert.ok(report.nextActions.some((item) => item.key === 'fix_proxy_authentication'));
  assert.ok(report.nextActions.some((item) => item.key === 'isolate_backend'));
});

test('deployment check exercises a real authenticated proxy and direct backend separately', async () => {
  const root = await makeTempDir();
  const token = 'deployment-check-token';
  const proxySecret = 'deployment-check-proxy-secret';
  const control = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    trustProxy: true,
    trustProxySecret: proxySecret,
    dataDir: path.join(root, 'control'),
  });
  const backendControlUrl = `http://127.0.0.1:${control.port}`;
  const proxy = await startForwardProxy({ backendUrl: backendControlUrl, proxySecret });

  try {
    const report = await runDeploymentCheck({
      publicControlUrl: proxy.url,
      backendControlUrl,
      requireProxyAuthentication: true,
      publicClient: new NadoClient({ controlUrl: proxy.url, token }),
      backendClient: new NadoClient({ controlUrl: backendControlUrl, token }),
    });

    assert.equal(report.ok, true);
    assert.equal(check(report, 'proxyAuthenticated').status, 'passed');
    assert.equal(check(report, 'backendNotProxyAuthenticated').status, 'passed');
    assert.equal(check(report, 'backendProxyBoundaryConfigured').status, 'passed');
  } finally {
    await closeServer(proxy.server);
    await closeServer(control.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deployment check never bypasses TLS verification after a public request failure', async () => {
  const tlsError = new Error('fetch failed', { cause: new Error('self-signed certificate') });
  const report = await runDeploymentCheck({
    publicControlUrl: 'https://nado.example.com',
    requireHttps: true,
    requireProxyAuthentication: true,
    publicClient: fakeClient({ healthError: tlsError, networkError: tlsError }),
  });

  assert.equal(report.ok, false);
  assert.equal(check(report, 'publicHealth').status, 'failed');
  assert.equal(check(report, 'certificate').status, 'failed');
  assert.equal(check(report, 'publicNetwork').status, 'failed');
  assert.match(report.problems.join('\n'), /self-signed certificate/);
});

test('deployment check rejects credential-bearing or path-based Control URLs', async () => {
  await assert.rejects(
    runDeploymentCheck({ publicControlUrl: 'https://user:secret@nado.example.com', publicClient: {} }),
    /must not contain credentials/,
  );
  await assert.rejects(
    runDeploymentCheck({ publicControlUrl: 'https://nado.example.com/control', publicClient: {} }),
    /without a path/,
  );
});

test('deployment check CLI emits structured evidence and fails strict HTTPS on HTTP', async () => {
  const root = await makeTempDir();
  const token = 'deployment-check-cli-token';
  const control = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${control.port}`;
  const env = { ...process.env, NADO_TOKEN: token };

  try {
    const diagnostic = await execFileAsync(process.execPath, [
      cliPath,
      'deployment',
      'check',
      '--control',
      controlUrl,
      '--json',
    ], { env });
    const report = JSON.parse(diagnostic.stdout);
    assert.equal(report.ok, true);
    assert.equal(check(report, 'publicHealth').status, 'passed');
    assert.equal(check(report, 'httpsUrl').status, 'skipped');

    let strictError;
    try {
      await execFileAsync(process.execPath, [
        cliPath,
        'deployment',
        'check',
        '--control',
        controlUrl,
        '--require-https',
        '--json',
      ], { env });
    } catch (error) {
      strictError = error;
    }
    assert.equal(strictError?.code, 2);
    const strictReport = JSON.parse(strictError.stdout);
    assert.equal(strictReport.ok, false);
    assert.equal(check(strictReport, 'httpsUrl').status, 'failed');
  } finally {
    await closeServer(control.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});
