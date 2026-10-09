# Private Overlay Deployment

This directory contains restrictive starting points for the VM Control + home Worker topology. The home Worker initiates every Nado request; neither Tailscale nor WireGuard requires a Nado listener on the home network.

## Tailscale

1. Merge `tailscale-acl.hujson` into the Tailnet policy and keep the two tags administrator-owned.
2. Join the VM as `tag:nado-control` and the home machine as `tag:nado-worker`. Use separately issued, revocable auth keys; do not copy the Nado administrator token into Tailnet configuration.
3. Read the VM address with `tailscale ip -4`. Use that exact address for both `NADO_DOCKER_HOST_IP` and `NADO_PUBLIC_CONTROL_URL`.
4. Start `docker-compose.azure.yml`. Do not create an Azure/VM firewall rule for TCP 8765 on the public interface.
5. On the VM, run:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js deployment check \
  --control http://100.64.10.20:8765 \
  --overlay tailscale \
  --overlay-interface tailscale0 \
  --out ./tailscale-deployment-check.json \
  --json
```

The check fails unless the URL is in Tailscale address space, that address exists on the named local interface, the running Compose service publishes TCP 8765 only on that address (plus optional loopback), the authenticated API is reachable directly, and `NADO_PUBLIC_CONTROL_URL` matches. Use `--compose-file` if the running project uses another Compose file. Preserve a Tailnet policy export or policy-test result separately; local interface inspection cannot prove the server-side ACL currently deployed by Tailscale.

## WireGuard

1. Generate independent keypairs on the VM and home machine with `wg genkey` and `wg pubkey`. Never commit the substituted private keys.
2. Copy the two `.conf.example` files outside the repository, replace every angle-bracket placeholder, install them as root-only WireGuard configuration, and bring up `wg0`.
3. Open UDP 51820 to the VM for WireGuard. Keep TCP 8765 closed on the public interface. The Nado Docker publication must bind only to `10.77.0.1`.
4. On the VM, run:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js deployment check \
  --control http://10.77.0.1:8765 \
  --overlay wireguard \
  --overlay-interface wg0 \
  --out ./wireguard-deployment-check.json \
  --json
```

The home configuration uses `PersistentKeepalive=25`, so a NATed home machine keeps the outbound tunnel usable without an inbound home firewall rule. The deployment check also rejects live Docker publications on `0.0.0.0`, `::`, or a non-overlay address. Retain `wg show`, VM firewall/NSG, and an Internet-side TCP 8765 denial probe as external acceptance evidence.
