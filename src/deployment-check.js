import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeBaseUrl } from './utils.js';

const execFileAsync = promisify(execFile);

function checkedControlUrl(value, label) {
  const normalized = normalizeBaseUrl(value);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use http:// or https://`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an origin URL without a path, query, or fragment`);
  }
  return {
    value: normalized,
    parsed,
  };
}

function loopbackOrPrivateHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) {
    return true;
  }
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return true;
  }
  const match = host.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) {
    return true;
  }
  return /^f[cd][0-9a-f]*:/i.test(host) || /^fe[89ab][0-9a-f]*:/i.test(host);
}

function ipv4Number(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) {
    return null;
  }
  return parts.reduce((result, part) => ((result * 256) + Number(part)) >>> 0, 0);
}

function inIpv4Cidr(value, base, prefixLength) {
  const address = ipv4Number(value);
  const network = ipv4Number(base);
  if (address === null || network === null) {
    return false;
  }
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (address & mask) === (network & mask);
}

function normalizedAddress(value) {
  return String(value || '')
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .toLowerCase();
}

function overlayAddress(kind, hostname) {
  const host = normalizedAddress(hostname);
  if (kind === 'tailscale') {
    return inIpv4Cidr(host, '100.64.0.0', 10) || host.startsWith('fd7a:115c:a1e0:');
  }
  const loopback = ['localhost', '::1'].includes(host) || host.startsWith('127.');
  return loopbackOrPrivateHost(host) && !loopback;
}

function overlayInterfaceEvidence(kind, hostname, requestedInterface, interfaces = {}) {
  const host = normalizedAddress(hostname);
  const entries = [];
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    for (const address of addresses || []) {
      entries.push({ name, address: normalizedAddress(address.address), internal: Boolean(address.internal) });
    }
  }
  const nameMatches = (name) => {
    if (requestedInterface) {
      return name.toLowerCase() === requestedInterface.toLowerCase();
    }
    return kind === 'tailscale'
      ? name.toLowerCase().includes('tailscale')
      : /^(wg|wireguard)/i.test(name);
  };
  const match = entries.find((entry) => entry.address === host && nameMatches(entry.name));
  return {
    matched: Boolean(match && !match.internal),
    interface: match?.name || null,
    address: match?.address || null,
  };
}

function parsePublishedBinding(value) {
  const text = String(value || '').trim();
  const bracketed = text.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketed) {
    return { host: normalizedAddress(bracketed[1]), port: Number(bracketed[2]) };
  }
  const separator = text.lastIndexOf(':');
  if (separator <= 0) {
    return null;
  }
  const port = Number(text.slice(separator + 1));
  return Number.isInteger(port)
    ? { host: normalizedAddress(text.slice(0, separator)), port }
    : null;
}

export async function inspectDockerComposeBindings(options = {}) {
  const composeFile = options.composeFile || 'docker-compose.azure.yml';
  const service = options.service || 'control';
  const containerPort = Number(options.containerPort || 8765);
  const runner = options.execFile || execFileAsync;
  const { stdout } = await runner('docker', [
    'compose',
    '-f',
    composeFile,
    'port',
    service,
    String(containerPort),
  ], { windowsHide: true });
  const bindings = String(stdout || '')
    .split(/\r?\n/)
    .map(parsePublishedBinding)
    .filter(Boolean);
  if (!bindings.length) {
    throw new Error(`No live published binding found for ${service}:${containerPort}`);
  }
  return {
    composeFile,
    service,
    containerPort,
    bindings,
  };
}

function procStatusValue(status, key) {
  const line = String(status || '').split(/\r?\n/).find((item) => item.startsWith(`${key}:`));
  return line ? line.slice(line.indexOf(':') + 1).trim() : '';
}

function numericStatusValues(status, key) {
  return procStatusValue(status, key)
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
}

function zeroCapability(value) {
  return /^[0]+$/i.test(String(value || '').trim());
}

function byteSize(value) {
  const match = String(value || '').trim().match(/^(\d+)([kmgt]?)$/i);
  if (!match) {
    return null;
  }
  const powers = { '': 0, k: 1, m: 2, g: 3, t: 4 };
  return Number(match[1]) * (1024 ** powers[match[2].toLowerCase()]);
}

export async function inspectDockerComposeControlSecurity(options = {}) {
  const composeFile = options.composeFile || 'docker-compose.azure.yml';
  const service = options.service || 'control';
  const runner = options.execFile || execFileAsync;
  const run = async (args) => runner('docker', args, { windowsHide: true });
  const { stdout: psOutput } = await run(['compose', '-f', composeFile, 'ps', '-q', service]);
  const containerIds = String(psOutput || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (containerIds.length !== 1) {
    throw new Error(`Expected exactly one running ${service} container, found ${containerIds.length}`);
  }
  const containerId = containerIds[0];
  const [{ stdout: inspectOutput }, { stdout: procStatus }] = await Promise.all([
    run(['inspect', containerId]),
    run(['exec', containerId, 'sh', '-c', 'cat /proc/1/status']),
  ]);
  let inspect;
  try {
    [inspect] = JSON.parse(String(inspectOutput || '[]'));
  } catch {
    throw new Error('Docker inspect returned invalid JSON');
  }
  if (!inspect?.HostConfig) {
    throw new Error('Docker inspect did not return HostConfig evidence');
  }

  const hostConfig = inspect.HostConfig;
  const mounts = (inspect.Mounts || []).map((mount) => ({
    destination: mount.Destination || null,
    type: mount.Type || null,
    writable: mount.RW === true,
  }));
  const writableMounts = mounts.filter((mount) => mount.writable);
  const allowedWritable = new Set(['/data/control', '/data/audit']);
  const unexpectedWritable = writableMounts.filter((mount) => !allowedWritable.has(mount.destination));
  const stateWritable = writableMounts.some((mount) => mount.destination === '/data/control');
  const auditWritable = writableMounts.some((mount) => mount.destination === '/data/audit');

  const tmpfsOptions = String(hostConfig.Tmpfs?.['/tmp'] || '');
  const tmpfsParts = new Set(tmpfsOptions.split(',').map((item) => item.trim()).filter(Boolean));
  const sizePart = [...tmpfsParts].find((item) => item.startsWith('size='));
  const tmpfsBytes = byteSize(sizePart?.slice('size='.length));
  const tmpfsSafe = tmpfsParts.has('noexec')
    && tmpfsParts.has('nosuid')
    && tmpfsParts.has('mode=1777')
    && Number.isFinite(tmpfsBytes)
    && tmpfsBytes > 0
    && tmpfsBytes <= 64 * 1024 * 1024;

  const uids = numericStatusValues(procStatus, 'Uid');
  const gids = numericStatusValues(procStatus, 'Gid');
  const capabilityFields = {
    inheritable: procStatusValue(procStatus, 'CapInh'),
    permitted: procStatusValue(procStatus, 'CapPrm'),
    effective: procStatusValue(procStatus, 'CapEff'),
    bounding: procStatusValue(procStatus, 'CapBnd'),
    ambient: procStatusValue(procStatus, 'CapAmb'),
  };
  const processNonRoot = uids.length === 4 && gids.length === 4
    && uids.every((value) => value === 1000)
    && gids.every((value) => value === 1000);
  const capabilitiesZero = Object.values(capabilityFields).every(zeroCapability);
  const processNoNewPrivileges = procStatusValue(procStatus, 'NoNewPrivs') === '1';
  const securityOptions = (hostConfig.SecurityOpt || []).map(String);
  const configuredNoNewPrivileges = securityOptions.some((item) => item === 'no-new-privileges'
    || item === 'no-new-privileges:true');
  const readonlyRootfs = hostConfig.ReadonlyRootfs === true;
  const issues = [];
  if (!readonlyRootfs) issues.push('Control root filesystem is writable');
  if (!configuredNoNewPrivileges) issues.push('Docker no-new-privileges is not configured');
  if (!processNoNewPrivileges) issues.push('Control PID 1 does not report NoNewPrivs=1');
  if (!processNonRoot) issues.push('Control PID 1 is not running entirely as uid/gid 1000');
  if (!capabilitiesZero) issues.push('Control PID 1 retains one or more Linux capabilities');
  if (!tmpfsSafe) issues.push('Control /tmp is not a bounded 64 MiB-or-smaller noexec/nosuid tmpfs with mode 1777');
  if (!stateWritable || !auditWritable) issues.push('Control state and audit volumes are not both writable');
  if (unexpectedWritable.length) issues.push('Control has unexpected writable mounts');

  return {
    ok: issues.length === 0,
    composeFile,
    service,
    containerId,
    readonlyRootfs,
    configuredNoNewPrivileges,
    process: {
      uids,
      gids,
      noNewPrivileges: processNoNewPrivileges,
      capabilities: capabilityFields,
      capabilitiesZero,
    },
    tmpfs: {
      path: '/tmp',
      options: [...tmpfsParts].sort(),
      sizeBytes: tmpfsBytes,
      safe: tmpfsSafe,
    },
    mounts,
    unexpectedWritableMounts: unexpectedWritable.map((mount) => mount.destination),
    issues,
  };
}

function normalizedComparableUrl(value) {
  try {
    return normalizeBaseUrl(new URL(value).toString());
  } catch {
    return normalizeBaseUrl(value);
  }
}

function errorMessage(error) {
  const cause = error?.cause?.message ? ` (${error.cause.message})` : '';
  return `${error?.message || String(error)}${cause}`;
}

function addCheck(report, key, status, summary, observed = undefined) {
  const check = { key, status, summary };
  if (observed !== undefined) {
    check.observed = observed;
  }
  report.checks.push(check);
  if (status === 'failed') {
    report.problems.push(summary);
  }
  return check;
}

function addNextAction(report, key, action) {
  if (!report.nextActions.some((item) => item.key === key)) {
    report.nextActions.push({ key, action });
  }
}

async function inspectEndpoint(client, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const healthStarted = Date.now();
  let health;
  let healthError;
  try {
    health = await client.health({ signal });
  } catch (error) {
    healthError = error;
  }
  const healthDurationMs = Date.now() - healthStarted;

  let network;
  let networkError;
  try {
    network = await client.networkInfo({ signal });
  } catch (error) {
    networkError = error;
  }
  return {
    health,
    healthError,
    healthDurationMs,
    network,
    networkError,
  };
}

export async function runDeploymentCheck(options = {}) {
  const publicUrl = checkedControlUrl(options.publicControlUrl, '--control');
  const backendUrl = options.backendControlUrl
    ? checkedControlUrl(options.backendControlUrl, '--backend')
    : null;
  const requireHttps = Boolean(options.requireHttps);
  const requireProxyAuthentication = Boolean(options.requireProxyAuthentication);
  const requireContainerHardening = Boolean(options.requireContainerHardening);
  const overlayKind = options.overlayKind ? String(options.overlayKind).trim().toLowerCase() : null;
  if (overlayKind && !['tailscale', 'wireguard'].includes(overlayKind)) {
    throw new Error('--overlay must be tailscale or wireguard');
  }
  if (overlayKind && (requireHttps || requireProxyAuthentication)) {
    throw new Error('--overlay cannot be combined with --require-https or --require-proxy-auth');
  }
  const requestedTimeoutMs = Number(options.timeoutMs || 15_000);
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : 15_000;
  const report = {
    reportVersion: 2,
    ok: false,
    generatedAt: new Date().toISOString(),
    mode: overlayKind ? 'private_overlay' : requireHttps || requireProxyAuthentication ? 'public_https' : 'diagnostic',
    publicControlUrl: publicUrl.value,
    backendControlUrl: backendUrl?.value || null,
    requirements: {
      https: requireHttps,
      proxyAuthentication: requireProxyAuthentication,
      backendSeparation: Boolean(backendUrl),
      privateOverlay: overlayKind,
      containerHardening: requireContainerHardening,
    },
    checks: [],
    problems: [],
    nextActions: [],
  };

  const controlSecurity = options.controlSecurity || null;
  const controlSecurityError = options.controlSecurityError || null;
  const hardeningPassed = !controlSecurityError && controlSecurity?.ok === true;
  addCheck(
    report,
    'controlContainerHardening',
    requireContainerHardening ? hardeningPassed ? 'passed' : 'failed' : 'skipped',
    requireContainerHardening
      ? hardeningPassed
        ? 'The live Control container is non-root, capability-free, read-only, and limited to expected writable mounts.'
        : controlSecurityError
          ? `The live Control container hardening could not be inspected: ${errorMessage(controlSecurityError)}`
          : `The live Control container failed hardening checks: ${(controlSecurity?.issues || ['unknown failure']).join('; ')}`
      : 'Live Control container hardening was not required for this diagnostic run.',
    controlSecurityError ? { error: errorMessage(controlSecurityError) } : controlSecurity,
  );
  if (requireContainerHardening && !hardeningPassed) {
    addNextAction(
      report,
      'harden_control_container',
      'Deploy the current control Compose target, restart it, and rerun deployment check on the VM with --require-container-hardening.',
    );
  }

  const publicIsHttps = publicUrl.parsed.protocol === 'https:';
  addCheck(
    report,
    'httpsUrl',
    publicIsHttps ? 'passed' : requireHttps ? 'failed' : 'skipped',
    publicIsHttps
      ? 'The public Control URL uses HTTPS.'
      : requireHttps
        ? 'The public Control URL must use HTTPS.'
        : 'HTTPS was not required for this diagnostic run.',
    publicUrl.parsed.protocol.replace(':', ''),
  );
  if (requireHttps && !publicIsHttps) {
    addNextAction(report, 'configure_https', 'Expose Control through a trusted HTTPS reverse proxy and rerun with its public URL.');
  }

  let localOverlay = null;
  if (overlayKind) {
    const addressMatchesOverlay = overlayAddress(overlayKind, publicUrl.parsed.hostname);
    addCheck(
      report,
      'overlayAddress',
      addressMatchesOverlay ? 'passed' : 'failed',
      addressMatchesOverlay
        ? `The Control URL uses a ${overlayKind} overlay address.`
        : `The Control URL host is not a recognized ${overlayKind} overlay address.`,
      publicUrl.parsed.hostname,
    );
    localOverlay = overlayInterfaceEvidence(
      overlayKind,
      publicUrl.parsed.hostname,
      options.overlayInterface || null,
      options.networkInterfaces || os.networkInterfaces(),
    );
    addCheck(
      report,
      'overlayInterface',
      localOverlay.matched ? 'passed' : 'failed',
      localOverlay.matched
        ? `The Control URL address is assigned to local overlay interface ${localOverlay.interface}.`
        : `The Control URL address is not assigned to the expected local ${options.overlayInterface || overlayKind} interface.`,
      localOverlay,
    );
    addCheck(
      report,
      'overlayEncryptedTransport',
      addressMatchesOverlay && localOverlay.matched ? 'passed' : 'failed',
      addressMatchesOverlay && localOverlay.matched
        ? 'The direct Control listener is bound through the local encrypted overlay interface.'
        : 'Encrypted overlay transport could not be established from the URL and local interface evidence.',
    );
    if (!addressMatchesOverlay || !localOverlay.matched) {
      addNextAction(report, 'fix_overlay_binding', `Run this check on the VM and bind Control to its ${overlayKind} interface address.`);
    }

    const published = options.overlayPublishedBindings;
    const publishedError = options.overlayPublishedBindingError;
    const expectedHost = normalizedAddress(publicUrl.parsed.hostname);
    const bindings = published?.bindings || [];
    const allowedHosts = new Set([expectedHost, '127.0.0.1', '::1']);
    const expectedPublished = bindings.some((binding) => normalizedAddress(binding.host) === expectedHost);
    const unsafeBindings = bindings.filter((binding) => !allowedHosts.has(normalizedAddress(binding.host)));
    const safePublication = !publishedError && expectedPublished && unsafeBindings.length === 0;
    addCheck(
      report,
      'overlayPublishedBinding',
      safePublication ? 'passed' : 'failed',
      safePublication
        ? `The live Docker publication is restricted to ${expectedHost}${bindings.length > 1 ? ' plus loopback' : ''}.`
        : publishedError
          ? `The live Docker publication could not be inspected: ${errorMessage(publishedError)}`
          : !expectedPublished
            ? `The live Docker publication does not include overlay address ${expectedHost}.`
            : `The live Docker publication also exposes non-overlay address(es): ${unsafeBindings.map((item) => item.host).join(', ')}.`,
      {
        composeFile: published?.composeFile || null,
        service: published?.service || null,
        containerPort: published?.containerPort || 8765,
        bindings,
      },
    );
    if (!safePublication) {
      addNextAction(report, 'restrict_overlay_publication', `Set NADO_DOCKER_HOST_IP=${expectedHost}, restart the Compose service, and keep TCP 8765 closed on public interfaces.`);
    }
  }

  const publicResult = await inspectEndpoint(options.publicClient, timeoutMs);
  if (publicResult.healthError) {
    addCheck(report, 'publicHealth', 'failed', `Public Control health request failed: ${errorMessage(publicResult.healthError)}`);
    addNextAction(report, 'fix_public_reachability', 'Check public DNS, certificate chain, reverse proxy, firewall, and the --control URL.');
  } else {
    addCheck(report, 'publicHealth', 'passed', 'The public Control health endpoint is reachable.', {
      durationMs: publicResult.healthDurationMs,
      status: publicResult.health?.status || 'ok',
    });
  }
  addCheck(
    report,
    'certificate',
    publicIsHttps
      ? publicResult.healthError ? 'failed' : 'passed'
      : 'skipped',
    publicIsHttps
      ? publicResult.healthError
        ? 'The normal system TLS verifier could not establish the public HTTPS request.'
        : 'The public request passed the normal system TLS and certificate verification path.'
      : 'Certificate verification does not apply to an HTTP URL.',
  );

  const publicNetwork = publicResult.network;
  if (publicResult.networkError) {
    addCheck(report, 'publicNetwork', 'failed', `Public network diagnostics failed: ${errorMessage(publicResult.networkError)}`);
  } else {
    addCheck(report, 'publicNetwork', 'passed', 'The authenticated public network diagnostics endpoint is reachable.');
    const proxyAuthenticated = publicNetwork.proxyAuthenticated === true;
    addCheck(
      report,
      'proxyAuthenticated',
      proxyAuthenticated ? 'passed' : requireProxyAuthentication ? 'failed' : 'skipped',
      proxyAuthenticated
        ? 'The Control authenticated this request as coming through its trusted reverse proxy.'
        : requireProxyAuthentication
          ? 'The public request was not authenticated as trusted-proxy traffic.'
          : 'Trusted-proxy authentication was not required for this diagnostic run.',
      proxyAuthenticated,
    );
    if (requireProxyAuthentication && !proxyAuthenticated) {
      addNextAction(report, 'fix_proxy_authentication', 'Enable NADO_TRUST_PROXY with a distinct secret and make the edge proxy overwrite X-Nado-Proxy-Secret and forwarded headers.');
    }

    addCheck(
      report,
      'forwardedHttps',
      publicIsHttps
        ? publicNetwork.requestProtocol === 'https' ? 'passed' : 'failed'
        : 'skipped',
      publicIsHttps
        ? publicNetwork.requestProtocol === 'https'
          ? 'Control observed HTTPS as the external request protocol.'
          : `Control observed ${publicNetwork.requestProtocol || 'an unknown protocol'} instead of HTTPS.`
        : 'Forwarded HTTPS evidence does not apply to an HTTP URL.',
      publicNetwork.requestProtocol || null,
    );
    if (publicIsHttps && publicNetwork.requestProtocol !== 'https') {
      addNextAction(report, 'fix_forwarded_protocol', 'Configure the trusted edge to overwrite X-Forwarded-Proto=https and verify its proxy secret.');
    }

    if (overlayKind) {
      const directOverlayRequest = publicNetwork.proxyAuthenticated === false
        && publicNetwork.requestProtocol === publicUrl.parsed.protocol.replace(':', '');
      addCheck(
        report,
        'overlayDirectRequest',
        directOverlayRequest ? 'passed' : 'failed',
        directOverlayRequest
          ? 'Control observed a direct request using the overlay URL protocol without trusted-proxy evidence.'
          : 'Control did not observe the expected direct overlay request path.',
        {
          protocol: publicNetwork.requestProtocol || null,
          proxyAuthenticated: publicNetwork.proxyAuthenticated === true,
        },
      );
    }

    const advertised = normalizedComparableUrl(publicNetwork.publicControlUrl || '');
    const expected = normalizedComparableUrl(publicUrl.value);
    const advertisedMatches = advertised === expected;
    const requireAdvertisedUrl = requireHttps || Boolean(overlayKind);
    addCheck(
      report,
      'advertisedPublicUrl',
      advertisedMatches ? 'passed' : requireAdvertisedUrl ? 'failed' : 'skipped',
      advertisedMatches
        ? 'NADO_PUBLIC_CONTROL_URL matches the checked public URL.'
        : requireAdvertisedUrl
          ? 'NADO_PUBLIC_CONTROL_URL does not match the checked public URL.'
          : 'No matching advertised public URL was required for this diagnostic run.',
      publicNetwork.publicControlUrl || null,
    );
    if (requireAdvertisedUrl && !advertisedMatches) {
      addNextAction(report, 'fix_public_url', `Set NADO_PUBLIC_CONTROL_URL=${publicUrl.value} on the Control deployment.`);
    }
  }

  if (backendUrl) {
    const separate = normalizedComparableUrl(backendUrl.value) !== normalizedComparableUrl(publicUrl.value);
    addCheck(
      report,
      'backendSeparated',
      separate ? 'passed' : 'failed',
      separate ? 'The backend URL is distinct from the public edge URL.' : 'The backend URL must be distinct from the public edge URL.',
    );
    const privateBackend = loopbackOrPrivateHost(backendUrl.parsed.hostname);
    addCheck(
      report,
      'backendPrivateAddress',
      privateBackend ? 'passed' : 'failed',
      privateBackend
        ? 'The supplied backend URL uses a loopback or private IP address.'
        : 'The supplied backend URL is not a loopback or private IP address.',
      backendUrl.parsed.hostname,
    );
    if (!privateBackend) {
      addNextAction(report, 'isolate_backend', 'Bind the native Control listener to loopback or a restricted private address and keep its port closed publicly.');
    }

    const backendResult = await inspectEndpoint(options.backendClient, timeoutMs);
    addCheck(
      report,
      'backendHealth',
      backendResult.healthError ? 'failed' : 'passed',
      backendResult.healthError
        ? `Backend Control health request failed: ${errorMessage(backendResult.healthError)}`
        : 'The native backend health endpoint is reachable from this deployment host.',
    );
    if (backendResult.networkError) {
      addCheck(report, 'backendNetwork', 'failed', `Backend network diagnostics failed: ${errorMessage(backendResult.networkError)}`);
    } else {
      addCheck(report, 'backendNetwork', 'passed', 'The authenticated backend network diagnostics endpoint is reachable.');
      addCheck(
        report,
        'backendNotProxyAuthenticated',
        backendResult.network.proxyAuthenticated === false ? 'passed' : 'failed',
        backendResult.network.proxyAuthenticated === false
          ? 'A direct backend request is not mistaken for authenticated proxy traffic.'
          : 'A direct backend request was incorrectly authenticated as proxy traffic.',
        backendResult.network.proxyAuthenticated,
      );
      if (requireProxyAuthentication) {
        const configured = backendResult.network.trustProxyConfigured === true
          && backendResult.network.proxyAuthenticationConfigured === true;
        addCheck(
          report,
          'backendProxyBoundaryConfigured',
          configured ? 'passed' : 'failed',
          configured
            ? 'The backend requires authenticated trusted-proxy evidence before accepting forwarded headers.'
            : 'The backend does not report a complete authenticated trusted-proxy configuration.',
        );
      }
    }
  } else {
    addCheck(
      report,
      'backendSeparation',
      'skipped',
      overlayKind
        ? 'A direct private-overlay listener does not use a public-edge/private-backend split.'
        : 'No --backend URL was supplied; native backend isolation was not probed.',
    );
    if (!overlayKind) {
      addNextAction(report, 'verify_backend_boundary', 'Run this command on the VM with --backend http://127.0.0.1:8765 to verify public-edge/backend separation.');
    }
  }

  report.ok = !report.checks.some((check) => check.status === 'failed');
  return report;
}
