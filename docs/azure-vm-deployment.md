# Azure VM Deployment

This guide prepares a production-shaped Nado control node on an Azure VM. Workers remain separate Ubuntu/WSL hosts and register through bootstrap bundles.

## Recommended VM Size

The control node is mostly an HTTP gateway, scheduler, event store, artifact receiver, dashboard server, and MCP/CLI target. It should not run heavy LLM work itself.

- Small MVP: 2 vCPU, 4 GiB RAM, 30 GiB Premium SSD. Suitable for a few workers and light artifacts.
- Comfortable MVP: 2 vCPU, 8 GiB RAM, 64 GiB Premium SSD. Better default if batches, artifacts, or dashboard history are used regularly.
- Heavier artifact use: keep the same CPU class but grow disk first. Artifacts and task history are the likely bottleneck before CPU.

Worker machines need the real compute budget. GPU requirements belong on worker hosts, not on the control VM.

## Azure Network Shape

Use a dual-stack Azure VNet/subnet if IPv6 workers or IPv6-only client networks must reach the control node.

- Create an IPv4 subnet and IPv6 subnet prefix in the same VNet.
- Attach an IPv4 public IP and, if needed, an IPv6 public IP to the VM NIC or to the fronting load balancer/application gateway.
- For the bundled HTTPS path, allow TCP `80` for certificate issuance/redirects and TCP `443` for clients. Do not add a public rule for `8765`.
- Add an inbound rule for TCP `8765` only for an explicit temporary direct/overlay test, scoped to the overlay or operator source instead of the internet.
- Keep IPv6 literal URLs bracketed: `http://[2001:db8::10]:8765`.
- In Nado, set `NADO_PUBLIC_CONTROL_URL` to the URL that workers can actually reach.

Current Azure docs to check before provisioning:

- IPv6 for Azure Virtual Network: https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/ipv6-overview
- Create a dual-stack Azure VM: https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/create-vm-dual-stack-ipv6-portal
- Add dual-stack networking to an existing VM: https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/add-dual-stack-ipv6-vm-portal
- Azure public IP addresses: https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/public-ip-addresses
- Azure B-family VM sizes: https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/b-family
- Azure D-family VM sizes: https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/d-family

For a direct IPv6 test without a reverse proxy:

```bash
NADO_DOCKER_HOST_IP=::
NADO_PUBLIC_CONTROL_URL=http://[your-azure-ipv6]:8765
docker compose -f docker-compose.azure.yml up -d --build
```

For a public production dashboard, prefer HTTPS:

```bash
NADO_PUBLIC_CONTROL_URL=https://nado.example.com NADO_DOMAIN=nado.example.com
docker compose -f docker-compose.azure.yml -f docker-compose.azure-https.yml up -d --build
```

The HTTPS overlay starts Caddy, obtains/renews the public certificate, publishes only its `80/443` edge ports, and forwards to the control service over the private Compose network. The base compose publication of `8765` defaults to VM loopback for local health checks and cannot bypass Caddy from the public network.

## Reproducible Bicep Provisioning

[`deploy/azure/main.bicep`](../deploy/azure/main.bicep) creates the IPv4 production baseline without creating anything merely by compiling it: Standard static public IP and DNS label, VNet/subnet, NSG, NIC, Ubuntu 22.04 Trusted Launch VM, SSH-key-only login, automatic platform patching, managed boot diagnostics, and the existing Docker cloud-init. The NSG allows public `80/443`, limits SSH to the required operator CIDR, and explicitly denies Internet access to native Control port `8765`. IPv6/dual-stack remains an intentional follow-up using the Azure guidance above because globally routable IPv6 prefixes are subscription/deployment-specific.

Compile locally and inspect the generated ARM template without contacting Azure Resource Manager:

```bash
az bicep install
az bicep build --file deploy/azure/main.bicep --stdout >/dev/null
```

Then create an empty resource group and run `what-if` before any billable VM deployment. Replace the documentation-only CIDR; never use `*`, `Internet`, `0.0.0.0/0`, or `::/0` for SSH.

```bash
RESOURCE_GROUP=nado-agent-rg
LOCATION=eastus
SSH_SOURCE=203.0.113.10/32
SSH_KEY="$(cat ~/.ssh/id_ed25519.pub)"

az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
az deployment group what-if \
  --name nado-control \
  --resource-group "$RESOURCE_GROUP" \
  --template-file deploy/azure/main.bicep \
  --parameters allowedSshSourceCidr="$SSH_SOURCE" adminSshPublicKey="$SSH_KEY"
```

Only after reviewing resources, region, VM size, disk, public ingress, and estimated pricing should the operator create them:

```bash
az deployment group create \
  --name nado-control \
  --resource-group "$RESOURCE_GROUP" \
  --template-file deploy/azure/main.bicep \
  --parameters allowedSshSourceCidr="$SSH_SOURCE" adminSshPublicKey="$SSH_KEY"

az deployment group show \
  --name nado-control \
  --resource-group "$RESOURCE_GROUP" \
  --query properties.outputs \
  --output json
```

Use the emitted `publicFqdn` for `NADO_DOMAIN` and `publicHttpsUrl` for `NADO_PUBLIC_CONTROL_URL`, then complete the repository clone, `.env`, Compose, deployment-check v2, and Worker onboarding steps below. The template never embeds the administrator token, proxy secret, private SSH key, terminal-Agent credentials, or home-Worker credentials.

To remove the whole isolated deployment after preserving required Control/audit/Caddy backups, preview deletion in the Azure portal/resource list and then explicitly delete its resource group:

```bash
az resource list --resource-group "$RESOURCE_GROUP" --output table
az group delete --name "$RESOURCE_GROUP" --yes --no-wait
```

Resource-group deletion is destructive and cannot recover an unexported control database, audit mirror, artifact, or Caddy account state.

## VM Bootstrap

1. Create an Ubuntu 22.04 or 24.04 Azure VM.
2. Use a size close to the recommended control-node target above.
3. Open only the required NSG ports:
   - SSH from operator IPs
   - `80` and `443` for the bundled Caddy HTTPS path, or `8765` only for a source-restricted temporary direct/overlay test
4. Install Docker and the Compose plugin. `deploy/azure/cloud-init-control.yaml` contains a starter cloud-init for that.
5. Clone the GitHub repository into `/opt/nado-agent`.
6. Copy `.env.example` to `.env` and set real values:

```bash
cp .env.example .env
openssl rand -base64 48
openssl rand -hex 32
```

Set `NADO_DOMAIN` to a DNS name whose A/AAAA record already targets the VM, set `NADO_PUBLIC_CONTROL_URL=https://<that-domain>`, and use the distinct hex output for `NADO_TRUST_PROXY_SECRET`. Keep `NADO_DOCKER_HOST_IP=127.0.0.1`. Keep `NADO_AUDIT_NDJSON_FILE=/data/audit/nado-audit.ndjson` to mirror sanitized events into the separate `nado-control-audit` volume for a log collector; clear it only when manual audit export is an explicit operational choice.

The Azure Compose definition explicitly builds the Dockerfile `control` target. That target omits terminal Agent CLIs and Worker-only process tools; Agent runtimes belong on the outbound home/lab Worker hosts. npm downloads use a BuildKit cache and bounded retry policy so transient registry failures do not force every layer to restart, without disabling TLS verification.

At runtime the Control root filesystem is read-only and `no-new-privileges` is enabled. The entrypoint starts with only `CHOWN`, `SETUID`, `SETGID`, and `SETPCAP`, migrates fresh or legacy `/data/control` and `/data/audit` ownership once, clears its own bounding/inheritable/ambient capability sets, then executes Node as uid/gid 1000 with permitted and effective capabilities also at zero. A bounded `noexec` tmpfs supplies `/tmp`; only the two dedicated data volumes remain writable. Keep new Control write paths under one of those mounts instead of weakening the container-wide policy.

If a build reports an npm TLS handshake failure, verify registry access from the Docker network rather than from the VM host alone:

```bash
docker run --rm node:20-bookworm-slim node -e "fetch('https://registry.npmjs.org/').then(r => { console.log(r.status); process.exit(r.ok ? 0 : 1); }).catch(error => { console.error(error.cause?.code || error.message); process.exit(1); })"
```

When that probe fails, repair the Docker daemon's proxy/CA/network path and rerun the build. Do not disable npm `strict-ssl` or Node certificate verification; a persistent TLS failure is not a safe candidate for automatic retry or downgrade.

7. Start the control node:

```bash
docker compose -f docker-compose.azure.yml -f docker-compose.azure-https.yml config --quiet
docker compose -f docker-compose.azure.yml -f docker-compose.azure-https.yml up -d --build
```

The compose file reads `NADO_TOKEN` from `.env` and does not pass it as a process command-line argument.
It also defaults `NADO_STORE=sqlite`, writing the control database to its persistent Docker volume. The audit mirror uses a different persistent volume so log rotation/shipping and control backup policies remain independent.

8. Verify from the VM:

```bash
docker compose -f docker-compose.azure.yml -f docker-compose.azure-https.yml ps
curl -f http://127.0.0.1:8765/health
curl -f https://nado.example.com/health
```

9. Verify from your workstation:

```bash
NADO_TOKEN=<admin-token> node ./src/cli.js status --control <public-control-url>
NADO_TOKEN=<admin-token> node ./src/cli.js network --control <public-control-url>
```

10. Generate worker bootstrap bundles from the dashboard or CLI with strict local readiness enabled, then start them on worker hosts. Dashboard self-service bundles enable it by default; CLI users should pass `--strict-local-readiness` so GPU/Agent prerequisites fail before enrollment and the persisted Ed25519 identity is checked after signed preflight.

## Reverse Proxy Notes

The repository includes `docker-compose.azure-https.yml` and `deploy/caddy/Caddyfile`. The overlay forces authenticated trusted-proxy mode and refuses to render unless both `NADO_DOMAIN` and `NADO_TRUST_PROXY_SECRET` are set. Use:

```bash
NADO_PUBLIC_CONTROL_URL=https://nado.example.com
NADO_TRUST_PROXY=true
NADO_TRUST_PROXY_SECRET=<distinct-output-of-openssl-rand-hex-32>
NADO_DOMAIN=nado.example.com
```

```bash
docker compose -f docker-compose.azure.yml -f docker-compose.azure-https.yml up -d --build
```

The bundled Caddy configuration overwrites `X-Nado-Proxy-Secret`, `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` on every upstream request. Nado ignores forwarded evidence unless the proxy-secret header matches. The native control port is loopback-only by default; keep Azure NSG and host firewall rules for `8765` closed as defense in depth.

For a host-installed Nginx/Caddy alternative, start only `docker-compose.azure.yml`, retain its loopback binding, and proxy to `http://127.0.0.1:8765` while applying the same overwrite rules. An external Application Gateway must reach a private VM address instead; explicitly bind that private address and restrict its NSG source to the gateway subnet.

## Operational Checks

Run these after every deployment:

```bash
NADO_TOKEN=<admin-token> node ./src/cli.js deployment check \
  --control https://nado.example.com \
  --backend http://127.0.0.1:8765 \
  --require-https \
  --require-proxy-auth \
  --require-container-hardening \
  --out ./deployment-check.json \
  --json
NADO_TOKEN=<admin-token> node ./src/cli.js demo health --control <public-control-url> --skip-verify
NADO_TOKEN=<admin-token> node ./src/cli.js network --control <public-control-url> --json
```

The deployment check exits with code `2` unless the public health request passes normal system certificate verification, Control observes HTTPS through an authenticated trusted proxy, `NADO_PUBLIC_CONTROL_URL` matches, the optional native backend probe remains private, and the running Control PID 1 plus Docker HostConfig satisfy the non-root/read-only/capability-free policy. The v2 receipt omits host mount source paths. It never disables TLS verification and never prints the administrator token or proxy secret. Keep separate NSG/firewall evidence that port `8765` is not publicly reachable; a probe executed on the VM cannot prove an Internet-side port closure by itself.

Use full verification after at least one worker is online:

```bash
NADO_TOKEN=<admin-token> node ./src/cli.js verify --control <public-control-url> --all-workers
```

## Backups And Rotation

- Back up the Docker volume `nado-control-data`. Preserve `nado-caddy-data` when certificate/account continuity matters; losing it does not lose Nado state but can trigger fresh certificate issuance and CA rate limits.
- Rotate `NADO_TOKEN` before moving from demo to real use and whenever a dashboard token may have been exposed.
- Revoke unused worker enrollment tokens after distributing bootstrap bundles.
- Revoke lost or decommissioned worker tokens from the dashboard or CLI.
- Rotate admin tokens by setting `NADO_ADMIN_TOKENS=old-token,new-token`, updating clients and MCP configs, then restarting with only the new token.
