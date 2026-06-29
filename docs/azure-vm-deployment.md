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
- Add NSG inbound rules for TCP `8765` if exposing Nado directly, or TCP `443` if terminating HTTPS in a reverse proxy.
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
NADO_PUBLIC_CONTROL_URL=https://nado.example.com
docker compose -f docker-compose.azure.yml up -d --build
```

Then terminate TLS in Nginx, Caddy, Azure Application Gateway, or another trusted proxy and forward to `http://127.0.0.1:8765`.

## VM Bootstrap

1. Create an Ubuntu 22.04 or 24.04 Azure VM.
2. Use a size close to the recommended control-node target above.
3. Open only the required NSG ports:
   - SSH from operator IPs
   - `443` for HTTPS, or `8765` only for a temporary direct MVP test
4. Install Docker and the Compose plugin. `deploy/azure/cloud-init-control.yaml` contains a starter cloud-init for that.
5. Clone the GitHub repository into `/opt/nado-agent`.
6. Copy `.env.example` to `.env` and set real values:

```bash
cp .env.example .env
openssl rand -base64 48
```

7. Start the control node:

```bash
docker compose -f docker-compose.azure.yml up -d --build
```

The compose file reads `NADO_TOKEN` from `.env` and does not pass it as a process command-line argument.
It also defaults `NADO_STORE=sqlite`, writing the control database to the persistent Docker volume.

8. Verify from the VM:

```bash
docker compose -f docker-compose.azure.yml ps
curl -f http://127.0.0.1:8765/health
```

9. Verify from your workstation:

```bash
NADO_TOKEN=<admin-token> node ./src/cli.js status --control <public-control-url>
NADO_TOKEN=<admin-token> node ./src/cli.js network --control <public-control-url>
```

10. Generate worker bootstrap bundles from the dashboard or CLI, then start them on worker hosts.

## Reverse Proxy Notes

If a trusted proxy terminates HTTPS, run the container on the local VM and expose the proxy publicly. Set:

```bash
NADO_PUBLIC_CONTROL_URL=https://nado.example.com
```

If you start Nado directly rather than Docker, also pass `--trust-proxy` or set `NADO_TRUST_PROXY=true` so generated dashboard/context/bundle URLs can follow `X-Forwarded-Host` and `X-Forwarded-Proto`.

## Operational Checks

Run these after every deployment:

```bash
NADO_TOKEN=<admin-token> node ./src/cli.js demo health --control <public-control-url> --skip-verify
NADO_TOKEN=<admin-token> node ./src/cli.js network --control <public-control-url> --json
```

Use full verification after at least one worker is online:

```bash
NADO_TOKEN=<admin-token> node ./src/cli.js verify --control <public-control-url> --all-workers
```

## Backups And Rotation

- Back up the Docker volume `nado-control-data`.
- Rotate `NADO_TOKEN` before moving from demo to real use and whenever a dashboard token may have been exposed.
- Revoke unused worker enrollment tokens after distributing bootstrap bundles.
- Revoke lost or decommissioned worker tokens from the dashboard or CLI.
- Rotate admin tokens by setting `NADO_ADMIN_TOKENS=old-token,new-token`, updating clients and MCP configs, then restarting with only the new token.
