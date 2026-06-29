import os from 'node:os';
import fs from 'node:fs';
import { originFromHostHeader, urlHost } from './utils.js';

function firstHeaderValue(value) {
  return String(Array.isArray(value) ? value[0] : value || '')
    .split(',')[0]
    .trim();
}

function trustedHostHeader(request, trustProxy = false, fallback = '127.0.0.1') {
  if (trustProxy) {
    const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host']);
    if (forwardedHost) {
      return forwardedHost;
    }
  }
  return String(request.headers.host || fallback).trim();
}

function trustedProtocol(request, trustProxy = false, fallback = 'http') {
  if (trustProxy) {
    const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto']).toLowerCase();
    if (forwardedProto === 'http' || forwardedProto === 'https') {
      return forwardedProto;
    }
  }
  return fallback;
}

function hostFromHeader(host) {
  const value = String(host || '127.0.0.1').trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end >= 0 ? value.slice(1, end) : value;
  }
  const parts = value.split(':');
  return parts.length > 2 ? value : parts[0];
}

function portFromHostHeader(host, fallbackPort) {
  const value = String(host || '').trim();
  if (value.startsWith('[')) {
    const rest = value.slice(value.indexOf(']') + 1);
    return rest.startsWith(':') ? Number(rest.slice(1)) || fallbackPort : fallbackPort;
  }
  const parts = value.split(':');
  return parts.length === 2 ? Number(parts[1]) || fallbackPort : fallbackPort;
}

function isLoopbackHost(host) {
  const value = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return value === 'localhost'
    || value === '::1'
    || value === '0.0.0.0'
    || value === '::'
    || value.startsWith('127.');
}

function addressFamily(address) {
  return address.family === 6 || address.family === 'IPv6' ? 'IPv6' : 'IPv4';
}

function isContainerRuntime() {
  return Boolean(process.env.NADO_CONTAINER || fs.existsSync('/.dockerenv'));
}

function ipv4Parts(address) {
  const parts = String(address || '').split('.').map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isDockerBridgeAddress(address, interfaceName, inContainer) {
  if (!inContainer) {
    return false;
  }
  const parts = ipv4Parts(address);
  if (!parts) {
    return false;
  }
  return interfaceName === 'eth0' && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function configuredCandidate(publicControlUrl) {
  if (!publicControlUrl) {
    return null;
  }
  try {
    const parsed = new URL(publicControlUrl);
    return {
      url: parsed.toString().replace(/\/+$/, ''),
      address: parsed.hostname.replace(/^\[|\]$/g, ''),
      family: parsed.hostname.includes(':') ? 'IPv6' : 'IPv4',
      interface: 'configured',
      source: 'NADO_PUBLIC_CONTROL_URL',
      usable: true,
      warning: '',
    };
  } catch {
    return null;
  }
}

function sourceRank(source) {
  if (source === 'NADO_PUBLIC_CONTROL_URL') {
    return 0;
  }
  if (source === 'request') {
    return 1;
  }
  return 2;
}

function preferredRemoteCandidate(candidates) {
  return candidates.find((candidate) => candidate.usable !== false) || null;
}

function bashQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function setupExampleUrl(port) {
  return `http://[2001:db8::10]:${Number(port || 8765)}`;
}

function networkActionCommands({ code, requestUrl, controlUrl, port }) {
  const commands = [];
  if (code === 'configure_public_control_url') {
    const exampleUrl = setupExampleUrl(port);
    commands.push(
      {
        label: 'Set public Control URL (bash)',
        shell: 'bash',
        description: 'Replace the IPv6 example with the host address that workers can reach.',
        command: `export NADO_PUBLIC_CONTROL_URL=${bashQuote(exampleUrl)}`,
      },
      {
        label: 'Restart Docker demo on IPv6 (PowerShell)',
        shell: 'powershell',
        description: 'Use this when the control server runs in Docker and remote IPv6 workers must reach the published host port.',
        command: `$env:NADO_DOCKER_HOST_IP=${powerShellQuote('::')}; $env:NADO_PUBLIC_CONTROL_URL=${powerShellQuote(exampleUrl)}; docker compose up -d --build`,
      },
      {
        label: 'Start control on IPv6 directly',
        shell: 'bash',
        description: 'Use this for a non-Docker control server on an IPv6 or dual-stack host.',
        command: `node ./src/cli.js control start --host :: --port ${Number(port || 8765)} --public-control-url ${bashQuote(exampleUrl)}`,
      },
    );
    return commands;
  }

  if (controlUrl) {
    const adminUrl = requestUrl || controlUrl;
    commands.push(
      {
        label: 'Build self-service worker bundle',
        shell: 'bash',
        description: 'Creates a bundle whose worker side connects to the preferred remote Control URL.',
        command: `NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker bootstrap-bundle --control ${bashQuote(adminUrl)} --bundle-control-url ${bashQuote(controlUrl)} --out ./nado-worker-bootstrap.zip`,
      },
      {
        label: 'Build self-service worker bundle (PowerShell)',
        shell: 'powershell',
        description: 'Creates the same worker bundle from a Windows control terminal.',
        command: `node .\\src\\cli.js worker bootstrap-bundle --control ${powerShellQuote(adminUrl)} --bundle-control-url ${powerShellQuote(controlUrl)} --out .\\nado-worker-bootstrap.zip`,
      },
    );
  }
  return commands;
}

function remoteWorkerReason({ requestIsLoopback, preferred }) {
  if (!preferred) {
    return 'No usable non-loopback control URL candidate was detected for remote workers.';
  }
  if (preferred.source === 'NADO_PUBLIC_CONTROL_URL') {
    return 'NADO_PUBLIC_CONTROL_URL is configured; remote workers should use the preferred control URL.';
  }
  if (requestIsLoopback) {
    return 'The browser is using a loopback URL, but a non-loopback candidate is available for remote workers.';
  }
  return 'The current request host and preferred candidate look usable for remote workers.';
}

function networkNextAction({ requestIsLoopback, preferred, candidates = [], port, inContainer, requestUrl }) {
  if (preferred?.source === 'NADO_PUBLIC_CONTROL_URL') {
    return {
      code: 'generate_worker_bundle',
      severity: 'ok',
      controlUrl: preferred.url,
      message: 'Remote workers should use the configured public Control URL.',
      cli: 'Generate a self-service worker bundle or invite from this Control URL.',
      commands: networkActionCommands({
        code: 'generate_worker_bundle',
        requestUrl,
        controlUrl: preferred.url,
        port,
      }),
    };
  }
  if (preferred) {
    const code = requestIsLoopback ? 'use_preferred_remote_url' : 'generate_worker_bundle';
    return {
      code,
      severity: requestIsLoopback ? 'info' : 'ok',
      controlUrl: preferred.url,
      message: requestIsLoopback
        ? 'The browser is using loopback; worker bundles should use the detected non-loopback Control URL.'
        : 'Remote workers can use the detected non-loopback Control URL.',
      cli: 'Generate a self-service worker bundle or invite using the preferred Control URL.',
      commands: networkActionCommands({
        code,
        requestUrl,
        controlUrl: preferred.url,
        port,
      }),
    };
  }

  const onlyDockerBridge = candidates.length > 0
    && candidates.every((candidate) => candidate.usable === false && /Docker bridge/i.test(candidate.warning || ''));
  const examplePort = Number(port || 8765);
  const code = 'configure_public_control_url';
  return {
    code,
    severity: 'warning',
    controlUrl: null,
    message: onlyDockerBridge || inContainer
      ? 'The control server only sees container-internal addresses. Set NADO_PUBLIC_CONTROL_URL to the host LAN or bracketed IPv6 URL before generating remote worker bundles.'
      : 'Set NADO_PUBLIC_CONTROL_URL to a reachable LAN or bracketed IPv6 URL before generating remote worker bundles.',
    cli: `Example: NADO_PUBLIC_CONTROL_URL=http://[2001:db8::10]:${examplePort}`,
    commands: networkActionCommands({
      code,
      requestUrl,
      controlUrl: null,
      port: examplePort,
    }),
  };
}

export function candidateControlUrls({
  port,
  protocol = 'http',
  publicControlUrl = process.env.NADO_PUBLIC_CONTROL_URL,
  inContainer = isContainerRuntime(),
  interfaces = os.networkInterfaces(),
} = {}) {
  const seen = new Set();
  const urls = [];
  const configured = configuredCandidate(publicControlUrl);
  if (configured) {
    seen.add(configured.url);
    urls.push(configured);
  }
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.internal || !address.address) {
        continue;
      }
      const url = `${protocol}://${urlHost(address.address)}:${port}`;
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);
      const containerInternal = isDockerBridgeAddress(address.address, name, inContainer);
      urls.push({
        url,
        address: address.address,
        family: addressFamily(address),
        interface: name,
        source: 'interface',
        usable: !containerInternal,
        warning: containerInternal
          ? 'This looks like a container-internal Docker bridge address. Remote workers should use the host LAN/IPv6 address or NADO_PUBLIC_CONTROL_URL instead.'
          : '',
      });
    }
  }
  return urls.sort((a, b) => (
    Number(b.usable) - Number(a.usable)
    || sourceRank(a.source) - sourceRank(b.source)
    || a.family.localeCompare(b.family)
    || a.interface.localeCompare(b.interface)
    || a.address.localeCompare(b.address)
  ));
}

export function buildNetworkInfo(request, options = {}) {
  const serverPort = options.port || request.socket?.localPort || 8765;
  const trustProxy = Boolean(options.trustProxy);
  const hostHeader = trustedHostHeader(request, trustProxy, `127.0.0.1:${serverPort}`);
  const protocol = trustedProtocol(request, trustProxy, options.protocol || 'http');
  const port = portFromHostHeader(hostHeader, serverPort);
  const requestUrl = originFromHostHeader(hostHeader || `127.0.0.1:${port}`, protocol);
  const requestHost = hostFromHeader(hostHeader);
  const configuredPublicControlUrl = options.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL || '';
  const candidates = candidateControlUrls({
    port,
    publicControlUrl: configuredPublicControlUrl,
    protocol,
    inContainer: options.inContainer,
    interfaces: options.interfaces,
  });
  const requestIsLoopback = isLoopbackHost(requestHost);
  if (!requestIsLoopback && !candidates.some((candidate) => candidate.url === requestUrl)) {
    candidates.push({
      url: requestUrl,
      address: requestHost,
      family: requestHost.includes(':') ? 'IPv6' : 'IPv4',
      interface: trustProxy ? 'forwarded-request' : 'request',
      source: 'request',
      usable: true,
      warning: '',
    });
    candidates.sort((a, b) => (
      Number(b.usable) - Number(a.usable)
      || sourceRank(a.source) - sourceRank(b.source)
      || a.family.localeCompare(b.family)
      || a.interface.localeCompare(b.interface)
      || a.address.localeCompare(b.address)
    ));
  }
  const preferred = preferredRemoteCandidate(candidates);
  return {
    requestUrl,
    requestHost,
    requestProtocol: protocol,
    trustProxy,
    bindHost: options.host || null,
    port,
    requestIsLoopback,
    currentRequestRemoteReady: !requestIsLoopback,
    remoteWorkerReady: Boolean(preferred),
    preferredRemoteControlUrl: preferred?.url || null,
    remoteWorkerReason: remoteWorkerReason({ requestIsLoopback, preferred }),
    nextAction: networkNextAction({
      requestIsLoopback,
      preferred,
      candidates,
      port,
      inContainer: options.inContainer,
      requestUrl,
    }),
    publicControlUrl: configuredPublicControlUrl || null,
    candidates,
  };
}
