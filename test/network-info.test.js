import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNetworkInfo, candidateControlUrls } from '../src/network-info.js';

test('network candidates mark container bridge addresses as not remote-usable', () => {
  const candidates = candidateControlUrls({
    port: 59610,
    inContainer: true,
    publicControlUrl: '',
    interfaces: {
      eth0: [{ address: '172.19.0.2', family: 'IPv4', internal: false }],
      eth1: [{ address: '192.168.1.22', family: 'IPv4', internal: false }],
    },
  });

  const bridge = candidates.find((candidate) => candidate.address === '172.19.0.2');
  const lan = candidates.find((candidate) => candidate.address === '192.168.1.22');
  assert.equal(bridge.usable, false);
  assert.match(bridge.warning, /container-internal Docker bridge/);
  assert.equal(lan.usable, true);
});

test('configured public control URL is preferred over interface guesses', () => {
  const candidates = candidateControlUrls({
    port: 59610,
    inContainer: true,
    publicControlUrl: 'http://[2001:db8::10]:59610/',
    interfaces: {
      eth0: [{ address: '172.19.0.2', family: 'IPv4', internal: false }],
    },
  });

  assert.equal(candidates[0].url, 'http://[2001:db8::10]:59610');
  assert.equal(candidates[0].source, 'NADO_PUBLIC_CONTROL_URL');
  assert.equal(candidates[0].usable, true);
  assert.equal(candidates[1].usable, false);
});

test('interface IPv6 candidates use bracketed URL syntax', () => {
  const candidates = candidateControlUrls({
    port: 59610,
    inContainer: false,
    publicControlUrl: '',
    interfaces: {
      Ethernet: [{ address: '2001:db8::22', family: 'IPv6', internal: false }],
    },
  });

  assert.equal(candidates[0].url, 'http://[2001:db8::22]:59610');
  assert.equal(candidates[0].family, 'IPv6');
  assert.equal(candidates[0].usable, true);
});

test('network diagnostics parse bracketed IPv6 request hosts', () => {
  const request = {
    headers: { host: '[::1]:59610' },
    socket: { localPort: 59610 },
  };

  const info = buildNetworkInfo(request, {
    port: 59610,
    host: '::1',
    publicControlUrl: 'http://[2001:db8::10]:59610',
  });

  assert.equal(info.requestUrl, 'http://[::1]:59610');
  assert.equal(info.requestHost, '::1');
  assert.equal(info.requestIsLoopback, true);
  assert.equal(info.currentRequestRemoteReady, false);
  assert.equal(info.remoteWorkerReady, true);
  assert.equal(info.preferredRemoteControlUrl, 'http://[2001:db8::10]:59610');
  assert.match(info.remoteWorkerReason, /NADO_PUBLIC_CONTROL_URL/);
  assert.equal(info.nextAction.code, 'generate_worker_bundle');
  assert.equal(info.nextAction.controlUrl, 'http://[2001:db8::10]:59610');
  assert.ok(info.nextAction.commands.some((command) => (
    command.command.includes('--bundle-control-url')
    && command.command.includes('http://[2001:db8::10]:59610')
  )));
  assert.equal(info.candidates[0].url, 'http://[2001:db8::10]:59610');
});

test('network diagnostics separate loopback browser URL from usable remote candidates', () => {
  const request = {
    headers: { host: '127.0.0.1:59610' },
    socket: { localPort: 59610 },
  };

  const info = buildNetworkInfo(request, {
    port: 59610,
    host: '0.0.0.0',
    publicControlUrl: '',
    interfaces: {
      Ethernet: [{ address: '192.168.1.22', family: 'IPv4', internal: false }],
    },
  });

  assert.equal(info.requestIsLoopback, true);
  assert.equal(info.currentRequestRemoteReady, false);
  assert.equal(info.remoteWorkerReady, true);
  assert.ok(info.preferredRemoteControlUrl);
  assert.match(info.remoteWorkerReason, /non-loopback candidate/);
  assert.equal(info.nextAction.code, 'use_preferred_remote_url');
  assert.equal(info.nextAction.controlUrl, 'http://192.168.1.22:59610');
  assert.ok(info.nextAction.commands.some((command) => command.command.includes('http://192.168.1.22:59610')));
});

test('network diagnostics recommend public URL when only Docker bridge addresses are visible', () => {
  const request = {
    headers: { host: '127.0.0.1:59610' },
    socket: { localPort: 59610 },
  };

  const info = buildNetworkInfo(request, {
    port: 59610,
    host: '0.0.0.0',
    publicControlUrl: '',
    inContainer: true,
    interfaces: {
      eth0: [{ address: '172.19.0.2', family: 'IPv4', internal: false }],
    },
  });

  assert.equal(info.remoteWorkerReady, false);
  assert.equal(info.preferredRemoteControlUrl, null);
  assert.equal(info.nextAction.code, 'configure_public_control_url');
  assert.equal(info.nextAction.severity, 'warning');
  assert.match(info.nextAction.message, /container-internal/);
  assert.match(info.nextAction.cli, /NADO_PUBLIC_CONTROL_URL=http:\/\/\[2001:db8::10\]:59610/);
  assert.ok(info.nextAction.commands.some((command) => command.command.includes('NADO_DOCKER_HOST_IP')));
  assert.ok(info.nextAction.commands.some((command) => command.command.includes('--host ::')));
});

test('network diagnostics can trust forwarded proxy host and protocol when enabled', () => {
  const request = {
    headers: {
      host: '127.0.0.1:8765',
      'x-forwarded-host': 'control.example.com',
      'x-forwarded-proto': 'https',
    },
    socket: { localPort: 8765 },
  };

  const ignored = buildNetworkInfo(request, {
    port: 8765,
    publicControlUrl: '',
    interfaces: {},
  });
  assert.equal(ignored.requestUrl, 'http://127.0.0.1:8765');
  assert.equal(ignored.requestIsLoopback, true);

  const trusted = buildNetworkInfo(request, {
    port: 8765,
    publicControlUrl: '',
    interfaces: {},
    trustProxy: true,
  });
  assert.equal(trusted.requestUrl, 'https://control.example.com');
  assert.equal(trusted.requestHost, 'control.example.com');
  assert.equal(trusted.requestProtocol, 'https');
  assert.equal(trusted.trustProxy, true);
  assert.equal(trusted.currentRequestRemoteReady, true);
  assert.equal(trusted.preferredRemoteControlUrl, 'https://control.example.com');
  assert.equal(trusted.nextAction.code, 'generate_worker_bundle');
  assert.ok(trusted.nextAction.commands.some((command) => command.command.includes('https://control.example.com')));
});
