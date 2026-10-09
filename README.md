# Nado Agent

Nado Agent is a gateway MVP for coordinating multiple Ubuntu/WSL-style worker machines from one control-side agent.

The control node exposes an HTTP API, CLI, and MCP tool server. Worker nodes register themselves, advertise capabilities, keep heartbeats alive while work is running, execute tasks in per-task workspaces, and report observed state, metrics, current task, runtime events, resource diagnostics, agent readiness diagnostics, and results back to the gateway. A control-side LLM agent such as Codex, Claude Code, or another terminal agent can use MCP tools to discover workers, dispatch work, inspect status/logs, and manage worker state.

For the shortest hands-on verification path, see [DEMO.md](./DEMO.md). For pre-push safety, Azure VM deployment, and the target VM-to-home-worker topology, see [docs/github-readiness.md](./docs/github-readiness.md), [docs/azure-vm-deployment.md](./docs/azure-vm-deployment.md), and [docs/cross-site-deployment.md](./docs/cross-site-deployment.md).

This MVP is the first production-shaped slice of the project. The HTTP protocol, worker polling model, task lifecycle, CLI, and worker execution abstraction are intended to remain the foundation as storage, sandboxing, dashboards, and MCP integrations are added.

## Quick Start

Requirements:

- Node.js 20+
- Network connectivity from each worker to the control host

Start a directly usable one-machine gateway:

```bash
NADO_TOKEN=dev-token npm run quickstart -- --port 8765
```

`quickstart` starts the same control server and worker runtime used in normal operation, runs a real doctor self-test task through the gateway, writes `.nado/quickstart/AGENTS.md`, writes `.nado/quickstart/mcp.json`, and prints the Dashboard URL plus token. It keeps running until you press `Ctrl+C`; use `--once` for CI or a one-shot health check.

Install the current gateway context into a project-level `AGENTS.md` for Codex-style control agents:

```bash
NADO_TOKEN=dev-token node ./src/cli.js context install --control http://127.0.0.1:8765 --out ./AGENTS.md
```

This preserves any existing `AGENTS.md` text and updates only the generated `nado-agent-context` block on later runs.

Run a local two-worker gateway demo:

```bash
npm run demo
```

Run the same control/worker architecture through Docker Compose:

```bash
NADO_TOKEN=docker-demo-token docker compose up --build
```

This compose file is for local demo use. For an Azure/public VM, use `docker-compose.azure.yml` plus a real `.env`; add `docker-compose.azure-https.yml` for the bundled Caddy TLS edge. The production base binds native port `8765` to host loopback by default, while the HTTPS overlay publishes `80/443`, forces authenticated trusted-proxy mode, and refuses missing domain/proxy-secret configuration. [`deploy/azure/main.bicep`](./deploy/azure/main.bicep) supplies a `what-if`-first Azure VM/VNet/NSG/public-IP baseline without embedding runtime secrets or opening 8765 to the Internet.

The compose stack starts one control container and two worker containers (`docker-code` and `docker-gpu`) on the Docker network. Compose builds the Control from the minimal `control` target and the demo Workers from the Agent-capable `worker` target, so the public Control image does not contain Claude CLI or Worker-only process tools. The Control root filesystem is read-only and `no-new-privileges` is active. Its entrypoint receives only `CHOWN`, `SETUID`, `SETGID`, and `SETPCAP` long enough to migrate fresh or legacy state/audit volumes and clear its own capability bounding set, then launches Node as uid/gid 1000 with every bounding, inheritable, permitted, effective, and ambient capability at zero. A bounded non-executable `/tmp` and the two data volumes are its only writable paths. Open `http://127.0.0.1:59610/dashboard`; the demo dashboard auto-loads `docker-demo-token`, or set `NADO_DOCKER_PORT=<port>` before `docker compose up` to expose a different host port. When onboarding workers from another machine to a Docker-hosted control server, set `NADO_PUBLIC_CONTROL_URL=http://<host-lan-or-ipv6>:<published-port>` before `docker compose up`; otherwise the container can only see container-internal bridge addresses such as `172.x.x.x`, which the Dashboard marks as not suitable for remote workers. `GET /api/network` and Demo Health include a structured `nextAction` hint with copy-ready `nextAction.commands` so the Dashboard, CLI, MCP clients, and control-side agents can either build a worker bundle with the preferred remote URL or tell the operator exactly how to configure `NADO_PUBLIC_CONTROL_URL`. Set `NADO_HOST=::` when the control container should listen on IPv6/dual-stack inside the container, set `NADO_DOCKER_HOST_IP=::` when Docker should publish the demo port on the host's IPv6 listener, and keep IPv6 literal public URLs bracketed, for example `NADO_PUBLIC_CONTROL_URL=http://[2001:db8::10]:59610`.
The control container sets `NADO_INTERNAL_CONTROL_URL=http://127.0.0.1:8765` so server-side doctor/verify checks call the in-container listener while generated dashboard/context URLs still use the browser-facing host URL. It also sets `NADO_DASHBOARD_AUTO_TOKEN=true` for demo usability; normal `control start` does not inject the admin token into dashboard HTML unless started with `--dashboard-auto-token`. If a reverse proxy terminates HTTPS or exposes the control server under a different host, either set `NADO_PUBLIC_CONTROL_URL` explicitly or enable `--trust-proxy` / `NADO_TRUST_PROXY=true`, configure `NADO_TRUST_PROXY_SECRET`, and have the proxy overwrite `X-Nado-Proxy-Secret` on upstream requests. Forwarded host, protocol, and source headers are otherwise ignored.

Start the control server:

```bash
NADO_TOKEN=dev-token node ./src/cli.js control start --host 0.0.0.0 --port 8765
```

For a production-shaped single-node control server, use the SQLite store:

```bash
NADO_STORE=sqlite NADO_TOKEN=<admin-token> node ./src/cli.js control start --host 0.0.0.0 --port 8765 --data-dir .nado
```

Configured administrator tokens are always redacted from `control start` and `quickstart` stdout/stderr, so Docker, systemd, and VM console logs do not become credential stores. A remote-facing start (non-loopback bind, advertised public URL, or trusted-proxy mode) refuses to auto-generate and print a token. Prefer `NADO_TOKEN` from the host secret environment; when a new token must be generated, pass `--generate-token-file /private/path/admin-token`. The destination is exclusively created, must be outside the Control data directory, and is mode `0600` on POSIX. Quickstart MCP configuration is also written mode `0600`; on Windows, protect both files with a user-only inherited ACL. The implicit token display remains only for a loopback development start.

The normal `control start` path owns a heartbeat lease inside the data directory. A second Control pointed at the same JSON/SQLite volume fails before loading state, even when it uses a different TCP port. Every state commit rechecks that lease, so an old process that resumes after a stale-lease takeover cannot overwrite the new owner's snapshot. `SIGINT`/`SIGTERM` releases the lease cleanly; a hard crash becomes reclaimable after 60 seconds by default. Tune only when required with `NADO_CONTROL_DATA_LEASE_TIMEOUT_MS`, `NADO_CONTROL_DATA_LEASE_HEARTBEAT_MS`, or `--control-data-lease-timeout-ms`. Status, capabilities, CLI, and the Dashboard topology expose ownership and write-fencing state. This protects a single embedded-store writer; it does not provide active/active Control replication.

During admin token rotation, set `NADO_ADMIN_TOKENS` to a comma-separated list containing the old and new admin tokens, update clients, then remove the old token from the list.

When the URL that remote workers should use is different from the local bind URL, advertise it explicitly:

```bash
NADO_TOKEN=dev-token node ./src/cli.js control start \
  --host 0.0.0.0 \
  --port 8765 \
  --public-control-url http://<control-host>:8765
```

Behind a trusted HTTPS reverse proxy, keep server-side self-checks on the local listener while advertising the proxy URL:

```bash
NADO_TRUST_PROXY=true NADO_TRUST_PROXY_SECRET=<random-proxy-secret> NADO_INTERNAL_CONTROL_URL=http://127.0.0.1:8765 \
  NADO_TOKEN=dev-token node ./src/cli.js control start --host 127.0.0.1 --port 8765
```

Open `http://<control-host>:8765/` or `/dashboard` in a browser for the built-in control dashboard. Enter the same admin `NADO_TOKEN` in the page to load workers, preview the Control Console route before creating a task, follow the prepare/route/execute/result progress indicator, search task history, run agent-style work from the Control Console with automatic pre-submit route preview, task detail, artifact preview, and event streaming, create or clear a long-lived Control Console session without copying session IDs between pages, inspect worker detail/inventory/metrics/runtime events, tasks, batches, sessions, use the dedicated Onboarding tab to download self-service worker bootstrap bundles, issue worker tokens, download fixed-ID worker invite scripts and portable worker bundle zips, immediately self-test invited workers, list/revoke worker tokens, preview/download the current control-agent `AGENTS.md` context, preview/download a machine-readable gateway manifest, preview/download MCP client config, run doctor checks and self-test probes, submit shell or terminal-agent tasks with env/input files/artifact policy/workspace controls, create and inspect sessions, submit into sessions, download the latest session artifact snapshot as a zip, plan batch JSON from short subtask lines, submit batch JSON, inspect batch child tasks, reports, and event timelines, stream task and batch events live, list and download task artifacts or batch artifacts as ZIP files, retry or cancel batches, cancel/requeue/reschedule tasks, inspect scheduler decisions, reset demo clutter from the Workbench while preserving sessions/batches that contain work, clear old standalone completed task history while preserving batch/session records, clear completed verify/doctor system history, recover tasks stranded on offline workers, manage worker state, inspect task stdout/stderr/events, and download individual task artifacts.
The Operations page also has a Demo Health action that runs the same operator summary as `nado demo health`, including network hints, worker inventory, automatic GPU/docs/PPT route checks, optional readiness verification, and diagnostic history cleanup.

Generate a self-service worker bootstrap zip for another Ubuntu/WSL host. This is the preferred remote onboarding path when you do not care about choosing the worker ID yourself:

```bash
NADO_TOKEN=dev-token node ./src/cli.js worker bootstrap-bundle \
  --control http://<control-host>:8765 \
  --capability code \
  --strict-local-readiness \
  --label zone=lab \
  --out ./nado-worker-bootstrap.zip
```

Copy the zip to the worker host, unzip it, then run `bash ./start-worker.sh` from inside the extracted folder. On first start the worker generates a local Ed25519 keypair, sends the public key to the control server with the embedded enrollment token, receives a worker-scoped token, stores its assigned worker ID in `.nado/worker-identity.json`, runs the normal preflight with the signed worker token, and then starts the normal worker runtime. Later starts reuse that local identity, run the same signed preflight, and do not need the enrollment token again. If the stored worker token was revoked or expired and the start script still has a fresh enrollment token, bootstrap automatically re-enrolls the same worker ID and overwrites the stale identity before starting. Worker tokens created through this self-service path require Ed25519-signed worker requests after enrollment, so the registered public key is part of the live control/worker communication path. Signed requests include method, path, body hash, timestamp, nonce, and worker ID; the control server records recent nonces and rejects replayed signed requests inside the timestamp window.
With `--strict-local-readiness`, bootstrap inspects the host before spending the enrollment credential, requiring a real vendor GPU probe when `gpu` is declared and the matching CLI when `codex` or `claude` is selected. After signed online preflight (including any credential recovery), it validates the stored Worker ID/token and matching Ed25519 keypair before starting the long-running Worker. A corrupt or mismatched stored keypair is never reused; supply a fresh enrollment token/bundle so bootstrap can generate a replacement pair. The Dashboard enables this safer mode by default for self-service bundles, while the CLI flag remains opt-in for compatibility.
Self-service bootstrap bundles issue one-use enrollment tokens by default and set a seven-day expiry unless `--max-uses` or `--expires-at` is provided.
Self-service Workers can rotate their scoped credential without stopping work or exposing the signing key to the VM. The Worker generates the replacement token locally, sends a signed prepare request while the old token remains valid, atomically updates `worker-identity.json`, then confirms with the replacement token. Confirm revokes the old token in the same durable store update. Repeated prepare/confirm calls are idempotent, and a pending identity automatically retries confirm after restart. Pending replacements expire after ten minutes by default; an unconfirmed replacement is revoked while the old token stays usable.

For an always-on home Worker, portable bundles include service wrappers around the same start script. On Ubuntu run `bash ./install-systemd.sh`; it installs `nado-worker.service` for the invoking non-root login, waits for `network-online.target`, preserves that user's `HOME` and `PATH` for Codex/Claude credentials, and restarts process failures. Inspect it with `systemctl status nado-worker` and `journalctl -u nado-worker -f`; use `NADO_SERVICE_NAME` when installing multiple Workers. On native Windows run `.\install-scheduled-task.ps1`; it creates a current-user logon task with failure retry so the Agent uses the correct user profile; override its name with `NADO_TASK_NAME`. On macOS run `bash ./install-launchd.sh`; it installs a current-user `com.nado.worker` LaunchAgent, validates the generated plist, retains the user's Agent/Node environment, and restarts only failed exits. Inspect it with `launchctl print gui/$(id -u)/com.nado.worker`, use `NADO_LAUNCHD_LABEL` for multiple Workers, and keep that user logged in. Nado deliberately avoids a privileged LaunchDaemon. Matching uninstall scripts stop and remove only the service/task/agent and retain the bundle's `.nado` identity, workspaces, logs, and diagnostics. An intentional remote Worker shutdown exits cleanly and is not immediately undone by the systemd or launchd failure-only restart policy.
For upgradeable production installs, generate the initial and every later bundle with the same absolute `--data-dir` outside the extracted runtime directory. Drain the Worker, extract the new bundle beside the old one, run its offline `worker inspect --require-identity`, then rerun the same platform installer and service name. Linux and Windows installers now restart an existing installation after replacing its runtime path; launchd already boots out and replaces the current-user job. Bundle manifests carry the configured data directory, source/build identity, and upgrade/rollback invariants, while start scripts export the non-secret build ID so Control and Worker display the same release. Keep the previous runtime until `nado workers` and a target-pinned Doctor pass; rollback by reinstalling that previous bundle against the unchanged data directory. Never run both runtimes against one data directory, and revoke/prune any new self-service enrollment token left unused because the existing signed identity was reused.

Every successful Worker registration and heartbeat records how that specific Worker authenticated: administrator credential, unsigned worker-scoped token, or verified Ed25519-signed worker-scoped token. It also records the control-side observed source address and HTTP/HTTPS transport; forwarded evidence is used only when trusted-proxy mode is enabled and the proxy's shared-secret header is valid. `workers`, Dashboard Worker detail, capabilities, and cross-site reports expose only this non-secret identity/connection metadata. Final cross-site acceptance fails closed unless the selected home Worker itself most recently authenticated with a signed scoped token from a non-loopback source over observed HTTPS or an operator-verified encrypted overlay. Gateway-wide support flags, a public-looking Control URL, unauthenticated forwarded headers, and an advertised HTTPS URL alone are not accepted as proof.
Control and Worker processes also publish runtime build provenance. Nado hashes `package.json` plus every `src/**/*.js` file with normalized line endings, reports a protocol version and source fingerprint, and accepts an optional immutable `NADO_BUILD_ID` (or `NADO_GIT_COMMIT`) supplied by the deployment pipeline. `nado status`, `nado workers`, `/api/status`, `/api/capabilities`, the topology view, and Worker detail classify each Worker as `compatible`, `build_mismatch`, `protocol_mismatch`, or `unknown`. A build mismatch means the protocol still matches but deployed code differs and should be reconciled. A known protocol mismatch is a hard scheduling, dispatch-preview, and claim-time rejection with an upgrade action, so even work queued before a Worker restart cannot run on an incompatible process. Legacy Workers without evidence remain temporarily eligible for compatibility but remain `unknown` instead of being misreported as current; strict WAN acceptance keeps them pending. After an upgrade, restart both processes and confirm the same fingerprint or release build ID before collecting WAN acceptance evidence.
When worker invites or bundles are generated through the Dashboard, HTTP API, or CLI without an explicit bundle Control URL, the control server prefers `NADO_PUBLIC_CONTROL_URL` or the best non-loopback LAN/IPv6 candidate from `GET /api/network` instead of embedding the browser/API `127.0.0.1` URL. If no reachable candidate exists, configure `NADO_PUBLIC_CONTROL_URL` or pass CLI `--bundle-control-url http://<lan-or-[ipv6]>:<port>` before generating a remote invite or bundle.

Generate a copy-paste worker start script for another Ubuntu/WSL host when you need to choose a fixed worker ID up front:

```bash
NADO_TOKEN=dev-token node ./src/cli.js worker invite \
  --control http://<control-host>:8765 \
  --id worker-a \
  --issue-token \
  --capability code \
  --label zone=lab \
  --capability docs \
  --max-concurrency 2 \
  --cleanup-workspaces
```

For real remote hosts, prefer `--issue-token`. The control server creates a worker-specific token bound to that worker ID and the generated script uses it instead of the shared admin token. That worker token can register, heartbeat, claim work, stream events, and report results only for its own worker. Control-plane APIs such as task submission, worker management, token issuance, and artifact download still require the shared admin token.
Generated invite scripts run `worker preflight` before `worker start`. The preflight checks Node.js, the repository entrypoint, data-directory access, control-server health, VM/Worker clock skew, and whether the bearer token is accepted for that worker ID. It estimates clock offset from the health-response midpoint without weakening the five-minute signed-request window, warns beyond 60 seconds, and fails with NTP/Windows Time guidance before the signature boundary becomes unsafe.

Build a portable fixed-ID worker zip when the remote host does not already have this repository:

```bash
NADO_TOKEN=dev-token node ./src/cli.js worker bundle \
  --control http://<control-host>:8765 \
  --id worker-a \
  --issue-token \
  --capability code \
  --label zone=lab \
  --out ./nado-worker-a.zip
```

Copy the zip to the Ubuntu/WSL host, unzip it, then run `bash ./start-worker.sh` from inside the extracted folder. The bundle embeds the same worker runtime, runs the same preflight, and starts the same `src/cli.js worker start` command as the invite script. The Dashboard can download the same bundle through the authenticated control API after issuing an invite.

Start one or more workers from Ubuntu/WSL/another terminal:

```bash
NADO_TOKEN=dev-token node ./src/cli.js worker start \
  --control http://127.0.0.1:8765 \
  --id worker-a \
  --capability code \
  --capability docs \
  --label zone=lab \
  --max-concurrency 2 \
  --cleanup-workspaces
```

Run the same worker preflight manually when diagnosing a remote host before starting the long-running worker:

```bash
NADO_TOKEN=<worker-or-admin-token> node ./src/cli.js worker preflight \
  --control http://<control-host>:8765 \
  --id worker-a \
  --data-dir .nado
```

Run the offline host inspection before depending on a home machine for Agent or accelerator work. Unlike `worker preflight`, this command does not contact the control server: it checks Node.js, the writable data directory, discovered tools, CPU/RAM, vendor-reported GPU/VRAM, the configured Codex/Claude preset, and any locally enrolled Ed25519 identity. Strict requirements fail with exit code `2`; `--out` writes a new private JSON report without tokens or private keys.

```bash
node ./src/cli.js worker inspect \
  --data-dir .nado \
  --agent codex \
  --require-agent \
  --require-gpu \
  --require-capability code \
  --tool amd-smi \
  --platform linux \
  --arch x64 \
  --cpu 8 \
  --memory 32GiB \
  --gpu-count 1 \
  --vram 16GiB \
  --gpu-model MI300 \
  --out ./worker-inspect.json
```

Before the first self-service enrollment, omit `--require-identity`. After one successful bootstrap start, rerun with `--require-identity` to prove that `.nado/worker-identity.json` contains a matching Ed25519 keypair and a scoped Worker credential. Local inspection proves host readiness only; run the online signed `worker preflight` and terminal-Agent self-test afterward to prove control reachability, credential binding, and Agent authentication.

For a real multi-machine smoke test:

1. Start control on the machine you talk to: `node ./src/cli.js control start --host 0.0.0.0 --port 8765`, or use `--host ::` for IPv6/dual-stack hosts.
2. Make sure worker machines can reach `http://<control-host>:8765`; use `--public-control-url` or `NADO_PUBLIC_CONTROL_URL` when the advertised URL differs from the local listener, and use bracketed IPv6 URL syntax such as `http://[2001:db8::10]:8765` when the control host is an IPv6 literal. If the reachable URL is supplied by a trusted reverse proxy, use `--trust-proxy` or `NADO_TRUST_PROXY=true` so Dashboard/context/bundle URLs can follow `X-Forwarded-Host` and `X-Forwarded-Proto`. The Dashboard worker onboarding panel can call `GET /api/network` to show clickable LAN/IPv6 Control URL candidates, warn when the current browser URL is loopback-only, and mark likely Docker bridge addresses as unsuitable for remote workers. Set `NADO_PUBLIC_CONTROL_URL` when the control server runs inside a container and the published host address cannot be discovered from inside that container.

For a public VM deployment, capture the HTTPS boundary receipt before onboarding Workers:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js deployment check \
  --control https://nado.example.com \
  --backend http://127.0.0.1:8765 \
  --require-https --require-proxy-auth --require-container-hardening \
  --out ./deployment-check.json --json
```

This produces a v2 receipt and fails closed on certificate, proxy-authentication, forwarded-protocol, advertised-URL, backend-separation, or live Control-container hardening errors. It inspects PID 1 and Docker runtime state without including host mount sources. An external firewall/NSG check is still required to prove that the native backend port is not Internet reachable.

For a private Tailscale/WireGuard deployment, use the restrictive examples in [`deploy/overlay`](./deploy/overlay) and run the same command on the VM with `--overlay tailscale --overlay-interface tailscale0 --require-container-hardening` or `--overlay wireguard --overlay-interface wg0 --require-container-hardening`. The check proves the configured Control address is assigned to that local overlay interface, rejects a live Compose publication on wildcard/public addresses, and binds the receipt to the hardened Control process; keep the Tailnet ACL/WireGuard peer export and an Internet-side port-denial probe as separate evidence.

Before the real VM/home-host drill, generate the shared resumable checklist with `nado acceptance runbook --control <url> --worker <home-worker> --deployment-mode public_https|tailscale|wireguard --out ./acceptance-runbook.sh`. CLI, Dashboard, HTTP, and MCP use the same ordered definition, including deployment evidence, manual topology facts, disruptive exercises, credential revocation, and the final strict gate.
3. Generate one `worker invite` per host if the repo already exists there, or one `worker bundle` zip if the remote host needs a portable copy of the worker runtime.
4. Confirm inventory from the control host with `node ./src/cli.js workers --control http://<control-host>:8765`.
5. Submit a routed test, for example `--capability gpu` or `--required-label zone=lab`, then use `wait`, `batch report`, and `batch download` from the control host.

Workers automatically report host/tool inventory during registration and heartbeat, including Node.js, Git, GitHub CLI, Codex CLI, Claude CLI, and NVIDIA, modern AMD SMI, or legacy ROCm GPU presence when available. The gateway also infers capabilities such as `shell`, `git`, `agent`, `github`, and `gpu`. GPU diagnostics distinguish `probe` workers, where NVIDIA/AMD SMI tooling was discovered, from `advertised` workers, where `gpu` was manually declared but no accelerator probe was reported; Demo Health, the Dashboard, and the capabilities manifest surface a warning for advertised-only GPU workers so real accelerator workloads are not confused with a simulated or manually labeled demo host. Agent readiness diagnostics distinguish real Codex/Claude terminal-agent workers from custom commands, demo echo agents, missing CLI tools, failed self-tests, and shell-only workers, so control-side agents can choose the right worker without scraping Dashboard text. The scheduler can infer GPU/docs/PPT requirements from high-confidence task wording such as CUDA, NVIDIA, AMD SMI, ROCm, VRAM/显存, Stable Diffusion, README/documentation/文档, or PPT/PowerPoint/幻灯片/演示文稿 terms, while explicit `--capability` remains available when the user already knows the target requirement. When GPU is required and several GPU-capable workers are eligible, probe-detected GPU workers receive a routing bonus and advertised-only GPU workers receive a small penalty but remain usable as a fallback for demos or manually managed hosts. Agent tasks require a configured worker-side agent command; when several workers can run the task, the scheduler prefers real Codex/Claude terminal-agent workers over demo echo agents, rejects Codex/Claude presets whose CLI is missing from inventory, and still records recent/stale/failed `doctor --agent-self-test` signals in the candidate reasons. Non-GPU tasks receive a GPU-preservation penalty on GPU-capable workers, so generic work does not consume scarce accelerator capacity unless that is the best or only route. Recorded scheduler decisions include `inferenceReasons` so the CLI, Dashboard, MCP, or another control-side agent can explain which rule caused automatic routing. Use worker labels such as `zone=lab`, `role=builder`, or `owner=team-a` for routing constraints that are not capabilities.

Worker inventory also includes operating system, CPU architecture, CPU cores, total memory, and structured NVIDIA or AMD GPU model/count/total and free VRAM/temperature/utilization when available. NVIDIA uses `nvidia-smi`; current AMD environments use merged `amd-smi static/metric --json` output, with `rocm-smi --json` retained as a compatibility fallback. When both AMD tools exist, a successful `amd-smi` probe wins so devices are not duplicated. Heartbeats report the Worker data-volume capacity/available space and the previous successful control heartbeat request/response RTT. Workers also run a bounded outbound upload/download bandwidth sample: 64 KiB every five minutes by default, with integrity verification, Worker-scoped authorization, a 1 MiB hard ceiling, and control-side per-direction rate limiting. Configure it with `NADO_NETWORK_PROBE_BYTES` and `NADO_NETWORK_PROBE_INTERVAL_MS` (set the interval to `0` to disable it); `NADO_NETWORK_PROBE_MIN_INTERVAL_MS` controls the server-side abuse guard. The result is an operational estimate to the control endpoint, not a sustained-throughput benchmark. Host temperature readings are best effort through Linux sysfs, existing Windows LibreHardwareMonitor/OpenHardwareMonitor WMI providers with ACPI fallback, or an already-installed unprivileged `osx-cpu-temp` command on macOS. Nado does not install, start, or elevate optional monitor tools; missing providers, firmware, virtualized sensors, and unsupported Mac hardware are reported as unavailable instead of preventing work. The `workers` CLI table, generated agent context, capabilities manifest, and Dashboard Worker detail expose this operational telemetry. For hardware-aware admission, submit `--platform linux --arch x64 --cpu 8 --memory 32GiB --gpu-count 1 --vram 16GiB --gpu-model 4090`. Platform aliases such as `windows`/`macos` and architecture aliases such as `amd64`/`aarch64` normalize to Node's `win32`/`darwin` and `x64`/`arm64` identifiers. These become `requiredResources`; scheduling and claim reject missing or mismatched OS/architecture evidence and subtract running/reserved CPU, RAM, GPU count, and aggregate VRAM. A GPU model/VRAM requirement is rejected when inventory cannot prove it. GPU-count reservations are conservative/exclusive; use only VRAM when workloads intentionally share one device.

Workers default to one running task slot at a time. Use `--max-concurrency <n>` when a host can safely run multiple independent tasks in parallel. Each task defaults to `slots: 1`; use CLI `--slots 2` or batch/MCP `slots` when a GPU/model/build task should reserve more of the worker. The control server tracks running plus reserved slots and the scheduler avoids workers without enough remaining capacity. Tasks in the same session still run serially to protect the shared session workspace.
Each worker claim gets a task attempt ID and an execution lease (60 seconds by default). Heartbeats renew only the current worker/attempt lease. Expired leases cannot be resurrected, and late output/results are ignored. Configure the control-wide duration with `NADO_TASK_LEASE_MS` or `--task-lease-ms`.
Workers use exponential reconnect backoff with jitter after repeated control-plane errors, capped at 30 seconds by default. Override the initial and maximum delays with `NADO_WORKER_RECONNECT_BASE_MS` and `NADO_WORKER_RECONNECT_MAX_MS`.
When a task finishes but its result cannot reach the control plane, the Worker keeps the task slot and current-attempt lease active while retrying transient network, `408`, `425`, `429`, and `5xx` failures. Permanent HTTP errors stop immediately. The default delivery budget is 16 attempts with delays from 250 ms up to 5 seconds; tune it with `NADO_WORKER_COMPLETION_RETRIES`, `NADO_WORKER_COMPLETION_RETRY_BASE_MS`, and `NADO_WORKER_COMPLETION_RETRY_MAX_MS`. Replaying an already committed result is recognized as accepted, while expired or superseded attempts remain rejected.
Live stdout/stderr events use stable IDs and a per-attempt ordered queue, so a lost success response is replayed without duplicating or reordering the persisted chunk. Transient delivery defaults to eight attempts from 250 ms up to 5 seconds. The queue is capped at 256 pending events; after one event exhausts its budget, later queued events are short-circuited and one `output_delivery_gap` summary is attempted before final result delivery. The terminal task result still carries bounded stdout/stderr, but operators can distinguish it from a complete real-time transcript. Configure `NADO_TASK_EVENT_RETRIES`, `NADO_TASK_EVENT_RETRY_BASE_MS`, `NADO_TASK_EVENT_RETRY_MAX_MS`, and `NADO_TASK_EVENT_MAX_PENDING`.
Critical Worker evidence emitted after the local process has actually closed uses a stable event ID and retries transient delivery failures. The control plane deduplicates replayed IDs and atomically copies task-bound evidence into durable task history before acknowledging the event. The default budget is eight attempts from 250 ms up to 5 seconds; tune it with `NADO_WORKER_EVENT_RETRIES`, `NADO_WORKER_EVENT_RETRY_BASE_MS`, and `NADO_WORKER_EVENT_RETRY_MAX_MS`.
Cancellation and graceful Worker shutdown terminate the complete task process tree, not only its shell wrapper. Windows recursively enumerates descendants and stops them leaf-first before the parent PowerShell process; Linux and macOS run each task in an isolated process group, send `SIGTERM`, then escalate the group to `SIGKILL` after two seconds. Worker shutdown does not resolve until the child tree has closed, final result handling has settled, and `task_released` evidence has completed its delivery budget. Use the generated systemd, Scheduled Task, or launchd wrapper in production so an external hard crash is also contained by the operating-system service supervisor.
Idle workers use a bounded 20-second long-poll claim request, so cross-site operation does not generate a request every polling interval. Task creation wakes compatible waiters immediately. Set `--long-poll-ms 0` or `NADO_WORKER_LONG_POLL_MS=0` for fixed-polling compatibility mode; active workers retain the short heartbeat/claim loop.

Automatic recovery of tasks stranded on offline workers or expired leases is opt-in. Set `NADO_AUTO_RECOVER_OFFLINE_MS=120000` (minimum accepted offline grace period: 60 seconds) or pass `--auto-recover-offline-ms 120000` to `control start`/`quickstart`. Tasks default to three attempts with bounded exponential retry delay; CLI submissions can set `--max-attempts`, `--retry-backoff-ms`, `--max-retry-backoff-ms`, and `--idempotency-key`. Non-session tasks return to normal scheduling. Session tasks are automatically requeued only to their existing session-affine Worker, preserving the durable affinity and worker-local workspace path until that machine reconnects; they are never automatically migrated to another host. Recovery has **at-least-once** execution semantics: a worker may have produced external side effects before becoming unreachable, so external mutations must remain idempotent. The status API, Dashboard readiness strip, and capabilities manifest expose the effective policy.

Control data ownership is independent from task execution leases. The data-directory heartbeat protects the VM's embedded state from concurrent Control writers; task leases protect Worker attempts from stale completion. Production service managers should allow the normal `SIGTERM` shutdown path to finish so audit writes flush and the data lease is released before restart.

Task list/detail responses also include control-derived `runtimeDiagnostics`: current attempt and lease health, Worker heartbeat/gateway state, retry backoff, same-Worker session recovery state, and a structured `nextAction`. The CLI `tasks` table shows the derived runtime state, while Dashboard Tasks and Needs Attention distinguish route failures from live-lease, stale-heartbeat, expired-attempt, and session-Worker recovery issues. Operators do not need to compare ISO timestamps by hand.
Use `--cleanup-workspaces` on worker start when non-session task workspaces should be deleted after artifacts are uploaded to the control side. Individual tasks can override this with `--keep-workspace` or `--cleanup-workspace`.
Use `--sandbox` or `--sandbox-profile isolated` for tasks that should run with a minimal inherited host environment. The isolated profile keeps only basic OS process variables such as `PATH`, temp, and home, plus explicit task `--env` values and gateway-managed `NADO_*` variables. It is a lightweight execution boundary, not a container or VM; pair it with worker-level isolation for untrusted code.

Manage issued worker tokens:

```bash
NADO_TOKEN=dev-token node ./src/cli.js worker token create --control http://127.0.0.1:8765 --id worker-a --label "lab box"
NADO_TOKEN=dev-token node ./src/cli.js worker tokens --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js worker token revoke <token-id> --control http://127.0.0.1:8765
```

The raw worker token is printed only when it is created or embedded in an invite; stored token listings show only redacted metadata and a short preview.

For a running Worker, queue rotation from the control plane and wait for the Worker to become idle, rotate locally, confirm, and verify that the predecessor now returns `401`:

```bash
NADO_TOKEN=dev-token node ./src/cli.js worker manage \
  --control https://control.example.com --id home-worker \
  --action rotate_token --wait \
  --evidence ./acceptance-evidence.json
```

The control command never receives the raw replacement token or signing private key; it asks the live Worker to perform the signed two-phase flow on the Worker host. Its evidence record contains only Worker/command/token record IDs plus the replacement-accepted and predecessor-HTTP-401 result. The strict cross-site report cross-checks that receipt against the selected Worker's current token and, for control-triggered rotation, the durable completed `rotate_token` command. A handwritten `credentialRevocation` note cannot satisfy that automatic gate. Use `worker token rotate --data-dir .nado --verify` directly only when the Worker process is stopped, during startup recovery, or when you have otherwise guaranteed that no concurrent Worker process still holds the old token in memory; restart/reconnect the Worker with the replacement before generating the strict report.

Set `NADO_WORKER_TOKEN_ROTATION_INTERVAL_MS` for opt-in periodic rotation by `worker bootstrap-start`; `0` disables it. Runtime rotation waits until the Worker has no running task, switches the shared client to the locally persisted replacement before confirmation, and retries a pending confirmation after transport failure. The Dashboard shows `rotate token` only for Workers that reported live rotation support, queues the command, and displays pending/confirmed/expired rotation state plus predecessor token IDs.

Manage self-service worker enrollment tokens created for bootstrap bundles:

```bash
NADO_TOKEN=dev-token node ./src/cli.js worker enrollments --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js worker enrollments prune --dry-run --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js worker enrollments prune --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js worker enrollment revoke <enrollment-token-id> --control http://127.0.0.1:8765
```

Enrollment token listings show label, preview, status, use count, expiry, and revocation metadata. Pruning revokes only unused, non-revoked enrollment tokens; used enrollment tokens and already revoked records are preserved for recovery context and audit history. Revoke a specific stale bootstrap enrollment token after distributing a worker package if you do not want any further first-time registrations from that package.

List known workers:

```bash
NADO_TOKEN=dev-token node ./src/cli.js workers --control http://127.0.0.1:8765
```

Inspect one worker's durable runtime timeline without logging into that machine:

```bash
NADO_TOKEN=dev-token node ./src/cli.js worker logs --control http://127.0.0.1:8765 --id worker-a --tail 50
NADO_TOKEN=dev-token node ./src/cli.js worker logs --control http://127.0.0.1:8765 --id worker-a --watch
```

The same worker event log is available through `GET /api/workers/<worker-id>/events`, the HTTP client, and MCP `nado_list_worker_events`. Worker events include registration, worker-side runtime messages, task claims/completions, worker errors, and management command acknowledgements.

Get one gateway snapshot with worker, session, task, batch, and routing-attention counts:

```bash
NADO_TOKEN=dev-token node ./src/cli.js status --control http://127.0.0.1:8765
```

Inspect the Control URL that remote workers should use before generating worker bundles, including IPv6/public URL hints, copy-ready setup commands, and the next operator action:

```bash
NADO_TOKEN=dev-token node ./src/cli.js network --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js network --control http://127.0.0.1:8765 --json
```

Get a machine-readable gateway capability manifest for custom control clients:

```bash
NADO_TOKEN=dev-token node ./src/cli.js capabilities --control http://127.0.0.1:8765
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:8765/api/capabilities
```

The manifest includes supported HTTP surfaces, MCP tool names, feature flags, endpoint templates, worker summaries, worker resource diagnostics, worker readiness diagnostics, session summaries, IPv6 URL conventions, trusted proxy header support, and `network.nextAction` diagnostics under `networking`, and a machine-readable `routingPolicy` section. Control-side agents can inspect that policy to understand explicit worker targeting, session affinity, required capabilities/labels/tools/slots, agent readiness scoring, GPU capacity preservation, and the same automatic GPU/docs/PPT inference rules used by the scheduler without scraping the Dashboard. Task scheduler records also include `warnings` when the selected worker is usable but deserves operator attention, such as advertised-only GPU capability or a demo/custom agent without a successful self-test.

MCP worker bundle tools follow the same remote URL rules as the CLI. Pass `bundleControlUrl` or `publicControlUrl` to `nado_create_worker_invite`, `nado_create_worker_bundle`, or `nado_create_worker_bootstrap_bundle` when the MCP client talks to control through `127.0.0.1` but the worker must connect through a LAN, public, or bracketed IPv6 URL.

Run an end-to-end readiness verification against the real gateway APIs:

```bash
NADO_TOKEN=dev-token node ./src/cli.js verify --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js verify --control http://127.0.0.1:8765 --worker worker-a --all-workers
```

For the final cross-site gate, generate an operator evidence template, perform each real VM/home-host scenario, then combine it with live gateway checks and a target-Worker verify run:

```bash
node ./src/cli.js acceptance template --out ./acceptance-evidence.json
NADO_TOKEN=dev-token node ./src/cli.js acceptance exercise remote-cancellation \
  --control https://nado.example.com \
  --worker home-gpu \
  --evidence ./acceptance-evidence.json
NADO_TOKEN=dev-token node ./src/cli.js acceptance exercise short-disconnect \
  --control https://nado.example.com \
  --worker home-gpu \
  --evidence ./acceptance-evidence.json
NADO_TOKEN=dev-token node ./src/cli.js acceptance exercise long-disconnect-recovery \
  --control https://nado.example.com \
  --worker home-gpu \
  --evidence ./acceptance-evidence.json \
  --timeout 300000
NADO_TOKEN=dev-token node ./src/cli.js acceptance exercise vm-restart-recovery \
  --control https://nado.example.com \
  --worker home-gpu \
  --evidence ./acceptance-evidence.json \
  --timeout 300000
NADO_TOKEN=dev-token node ./src/cli.js acceptance exercise worker-restart-recovery \
  --control https://nado.example.com \
  --worker home-gpu \
  --evidence ./acceptance-evidence.json \
  --timeout 300000
NADO_TOKEN=dev-token node ./src/cli.js acceptance exercise large-artifact-resume \
  --control https://nado.example.com \
  --worker home-gpu \
  --evidence ./acceptance-evidence.json \
  --timeout 300000
NADO_TOKEN=dev-token node ./src/cli.js acceptance exercise large-input-resume \
  --control https://nado.example.com \
  --worker home-gpu \
  --evidence ./acceptance-evidence.json \
  --timeout 300000
NADO_TOKEN=dev-token node ./src/cli.js acceptance exercise backup-restore \
  --control https://nado.example.com \
  --worker home-gpu \
  --source-data-dir /var/lib/nado \
  --backup-dir /var/backups/nado-acceptance \
  --restored-data-dir /var/lib/nado-restored \
  --evidence ./acceptance-evidence.json \
  --timeout 600000
NADO_TOKEN=dev-token node ./src/cli.js acceptance exercise agent-collaboration \
  --control https://nado.example.com \
  --worker home-gpu \
  --evidence ./acceptance-evidence.json \
  --timeout 180000
NADO_TOKEN=dev-token node ./src/cli.js acceptance \
  --control https://nado.example.com \
  --worker home-gpu \
  --require-gpu \
  --run-verify \
  --deployment-evidence ./deployment-check.json \
  --evidence ./acceptance-evidence.json \
  --out ./acceptance-report.json \
  --require-complete
```

The remote-cancellation exercise creates a target-pinned long-running task, cancels it from the control side, and waits for both the Worker's `cancel_current` acknowledgement and its post-process `task_released` event. The supervised short-disconnect exercise asks the VM control plane to compute the live heartbeat gap, persist attempt-bound `short_disconnect_gap_observed` and `short_disconnect_recovered` events, then requires the same attempt to renew before lease expiry and execute once. The supervised long-disconnect exercise keeps the original Worker disconnected until the VM records `lease_recovered`, then requires a distinct second attempt to succeed and the original attempt's late result to be rejected; this intentionally demonstrates at-least-once rather than exactly-once execution. The supervised VM-restart exercise requires an observed outage and new control instance ID, then proves SQLite preserved the same task/attempt, the home Worker reconnected, and the task executed once. The supervised Worker-restart exercise waits until the VM marks the installed home Worker service offline, then requires a control-only runtime transition, the unchanged signed Worker token, and a target-pinned artifact containing the new runtime ID. The supervised large-artifact exercise observes a committed upload offset, requires both the Worker heartbeat and offset to stall during a real link interruption, then verifies the same upload/attempt resumes and matches the deterministic source SHA-256. The supervised large-input exercise records the attempt-bound initial Range request, requires a Worker heartbeat gap, then verifies a post-reconnect positive Range offset and the Worker-computed input SHA-256. The supervised backup/restore exercise proves a new control instance carries a fresh restore receipt for a verified manifest, preserves a pre-backup task/artifact, reconnects the Worker, and accepts new durable work. The Agent-collaboration exercise requires a verified real Codex/Claude terminal Agent and proves two-turn workspace/transcript handoff. The commands write structured references into the evidence file. `--require-complete` always enables the deployment-boundary gate and exits non-zero when its receipt is missing, invalid, failed, older than 24 hours, too far in the future, or bound to another Control URL, as well as for any other failed or pending gate. Physical separation and the no-inbound-firewall claim still require operator-observed evidence. Report and template files are created with restrictive permissions and never overwrite an existing file.

The Dashboard Operations view exposes the same current-state checks through **Run Live Gate** and `POST /api/acceptance/report`. Load the runbook-produced deployment receipt and acceptance evidence JSON first: the Dashboard requires the deployment receipt on every live gate, sends both documents without persisting them in the browser, and shows pass/fail/pending status for every shared-runbook step. The default run is non-mutating; select **Run end-to-end verify tasks** only when the target Worker is ready for diagnostic task/artifact/batch probes. Automatic failures and mandatory operator evidence are shown separately with next actions, and the report can be downloaded as JSON. This preview deliberately fails local/loopback, administrator-token, unsigned, transport-bypass, recovery-disabled, and handwritten remote-cancellation, short-disconnect, long-disconnect, VM-restart, Worker-restart, transfer-resume, backup-restore, or Agent-collaboration claims rather than treating a successful local verify as cross-site acceptance. A remote-cancellation pass must match the durable target task, attempt, cancelled event, and the signed Worker's `cancel_current`/process-release acknowledgements copied into that task's persistent history. A short-disconnect pass must match the VM-computed gap and recovery events, unchanged attempt, renewed unexpired lease, single execution, and final artifact. A long-disconnect pass must match the expired first lease, recovery event, stale-result rejection, distinct successful retry, and final artifact. A VM-restart pass must match the server-stamped task creation instance, a different current control runtime after an observed outage, the same SQLite attempt, post-restart Worker heartbeat, and one-execution artifact. A Worker-restart pass must match an observed offline interval, a reserved control-side runtime event, unchanged signed token identity, and a task artifact executed under the new runtime. Large-output resume must match persisted committed offsets, a stalled interval, same upload finalization, and artifact digest; large-input resume must match the staged input digest plus initial and positive Range events on one attempt. Backup/restore must match the live verified receipt, old/new runtime-stamped tasks, preserved marker artifact, post-restore write artifact, and Worker reconnection. An Agent-collaboration pass must match the closed Worker-affine session, both successful Agent attempts, and all plan/final/transcript artifact metadata retained by the control plane.

Control-side integrations can keep the evidence document outside the VM filesystem: `GET /api/acceptance/template` returns the complete versioned template, `POST /api/acceptance/evidence/record` validates and updates exactly one scenario, and `POST /api/acceptance/report` consumes the resulting document. The HTTP client and MCP tools `nado_acceptance_template`, `nado_record_acceptance_evidence`, and `nado_acceptance_report` expose the same flow. Passed or failed claims still require a note, unknown scenarios fail with HTTP 400, and these APIs do not silently persist operator claims on the control server.

`verify` checks control health, gateway status, the capabilities manifest, generated agent context, MCP config, doctor self-test, a real task with raw artifact download, task events, and a real batch with server ZIP download. It exits non-zero if any required path fails.

For demo operation, use one command that prints the Dashboard URL, worker inventory, network hints, automatic GPU/docs/PPT dispatch checks, an optional end-to-end verify run, and then clears completed verify/doctor diagnostic history:

```bash
NADO_TOKEN=dev-token node ./src/cli.js demo health --control http://127.0.0.1:8765
curl -X POST -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
  -d '{"skipVerify":true,"noPrune":true}' \
  http://127.0.0.1:8765/api/demo/health
```

Repeated verify/doctor runs intentionally leave diagnostic task records so failures are inspectable. Clean completed diagnostic history without touching user work:

```bash
NADO_TOKEN=dev-token node ./src/cli.js history prune-system --dry-run --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js history prune-system --control http://127.0.0.1:8765
```

For a live demo reset, preview and then clear completed standalone task history while preserving batch records and sessions that contain work. Empty sessions with no tasks or workspace are removed so the Dashboard and generated agent context return to a clean first-run state; pass `--keep-empty-sessions` to keep them.

```bash
NADO_TOKEN=dev-token node ./src/cli.js demo reset --dry-run --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js demo reset --yes --control http://127.0.0.1:8765
```

The same readiness check is available to custom clients and control-side agents:

```bash
curl -X POST -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
  -d '{"workerId":"worker-a","timeoutMs":30000}' \
  http://127.0.0.1:8765/api/verify
```

Submit a shell task to a specific worker:

```bash
NADO_TOKEN=dev-token node ./src/cli.js submit \
  --control http://127.0.0.1:8765 \
  --worker worker-a \
  --title "hello" \
  --command "echo hello from $(hostname)" \
  --wait
```

Route by capability and worker labels:

```bash
NADO_TOKEN=dev-token node ./src/cli.js submit \
  --control http://127.0.0.1:8765 \
  --capability code \
  --tool node \
  --required-label zone=lab \
  --env BUILD_MODE=ci \
  --sandbox \
  --artifact "dist/**" \
  --exclude-artifact "dist/tmp/**" \
  --slots 1 \
  --priority 10 \
  --cleanup-workspace \
  --title "lab worker task" \
  --command "echo $NADO_WORKER_ID"
```

Opt in to bounded retries only for commands whose external effects are idempotent. Policies can match explicit failure classes (`timeout`, `process_error`, `worker_error`, `nonzero_exit`) or exact positive exit codes; cancellation and configuration errors are never retried automatically:

```bash
NADO_TOKEN=dev-token node ./src/cli.js submit \
  --control http://127.0.0.1:8765 \
  --worker worker-a \
  --command "run-transient-network-job" \
  --max-attempts 3 \
  --retry-on timeout,worker_error \
  --retry-exit-code 75,124 \
  --retry-backoff-ms 1000 \
  --max-retry-backoff-ms 60000 \
  --wait
```

The gateway records `failureKind`, closes the failed attempt as `retryable_failure`, releases its Worker capacity, schedules a new attempt after bounded exponential backoff, and emits `retry_scheduled`. A matching final attempt remains failed and emits `retry_exhausted`. With no `retryPolicy`, process failures remain terminal as before.

Create a long-lived session for a multi-step subproject:

```bash
NADO_TOKEN=dev-token node ./src/cli.js session create \
  --control http://127.0.0.1:8765 \
  --title "docs package" \
  --capability docs
```

Submit multiple tasks into the same session. They will stay on the same worker and reuse the same workspace:

```bash
NADO_TOKEN=dev-token node ./src/cli.js submit \
  --control http://127.0.0.1:8765 \
  --session <session-id> \
  --title "draft outline" \
  --command "printf '# Outline\n' > outline.md"

NADO_TOKEN=dev-token node ./src/cli.js submit \
  --control http://127.0.0.1:8765 \
  --session <session-id> \
  --title "extend outline" \
  --command "printf '\nNext step\n' >> outline.md && cat outline.md"
```

Download the latest workspace snapshot for a session:

```bash
NADO_TOKEN=dev-token node ./src/cli.js session download <session-id> --out ./session-output --control http://127.0.0.1:8765
```

Submit a task by capability:

```bash
NADO_TOKEN=dev-token node ./src/cli.js submit \
  --control http://127.0.0.1:8765 \
  --capability docs \
  --title "write a note" \
  --command "printf '# Demo\n\nGenerated by worker.\n' > demo.md && pwd && ls" \
  --wait \
  --download \
  --out ./task-output
```

Use `submit --wait --download --out ./task-output` when a control-side agent or operator should hand off one task and return only after terminal status and local artifact recovery. `--watch` can be added to print task events while waiting.

Send a local file into the worker workspace:

```bash
NADO_TOKEN=dev-token node ./src/cli.js submit \
  --control http://127.0.0.1:8765 \
  --worker worker-a \
  --title "process brief" \
  --file ./brief.md \
  --command "cat brief.md && cp brief.md processed-brief.md"
```

Send a directory into the worker workspace. The gateway preserves relative paths and skips `.git`, `node_modules`, and `.nado`:

```bash
NADO_TOKEN=dev-token node ./src/cli.js submit \
  --control http://127.0.0.1:8765 \
  --session <session-id> \
  --title "work on project" \
  --dir ./small-project \
  --command "npm test || true"
```

Plan one large request into a distributed subagent-style batch. `map_reduce` fans out shard tasks and adds a final synthesis task that consumes shard artifacts; `review` does the same for independent reviews; `pipeline` creates dependent stages; `parallel` creates independent shards only:

```bash
NADO_TOKEN=dev-token node ./src/cli.js planner plan \
  --control http://127.0.0.1:8765 \
  --title "azure deployment research" \
  --prompt "Research and prepare a production Azure VM deployment plan for this project." \
  --mode map_reduce \
  --subtask "infra: Azure VM/network/security design" \
  --subtask "ops: deployment commands and rollback" \
  --subtask "docs: final operator-facing guide" \
  --out ./planned-batch.json
```

```bash
NADO_TOKEN=dev-token node ./src/cli.js planner run \
  --control http://127.0.0.1:8765 \
  --prompt "Research and prepare a production Azure VM deployment plan for this project." \
  --mode map_reduce \
  --require-routable \
  --wait \
  --report
```

The planner returns ordinary batch JSON, so the scheduler, worker routing, dependency blocking, artifact upload, batch report, retry, cancel, and download flows remain exactly the same as hand-written batches. Use MCP `nado_plan_distributed_task` or `nado_run_distributed_task`, HTTP `POST /api/planner/plan` or `POST /api/planner/run`, or the Dashboard Distributed Planner for the same capability from a control-side agent.

Submit a batch of subtasks from one JSON file. Add `key` and `dependsOn` when one task must wait for another:

```bash
node ./src/cli.js batch plan \
  --title "implementation shards" \
  --type agent \
  --capability code \
  --task "docs: Draft usage docs" \
  --task "tests: Add smoke tests" \
  --out ./batch.json
```

```json
{
  "title": "implementation shards",
  "defaults": {
    "capabilities": ["code"],
    "tools": ["node"],
    "labels": { "zone": "lab" },
    "priority": 5,
    "slots": 1,
    "keepWorkspace": false,
    "artifactPolicy": {
      "include": ["docs.md", "summary.txt", "dist/**"],
      "exclude": ["dist/tmp/**"]
    }
  },
  "tasks": [
    {
      "key": "docs",
      "title": "write docs",
      "type": "shell",
      "capabilities": ["docs"],
      "file": "./brief.md",
      "command": "cat brief.md > docs.md"
    },
    {
      "key": "checks",
      "title": "run code checks",
      "type": "shell",
      "capabilities": ["code"],
      "command": "npm test"
    },
    {
      "key": "summary",
      "dependsOn": ["docs", "checks"],
      "title": "summarize results",
      "type": "shell",
      "capabilities": ["docs"],
      "dependencyArtifacts": true,
      "command": "printf 'done\n' > summary.txt"
    }
  ]
}
```

```bash
NADO_TOKEN=dev-token node ./src/cli.js batch submit --file ./batch.json --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js batches --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js batch events <batch-id> --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js batch events <batch-id> --watch --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js batch wait <batch-id> --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js batch report <batch-id> --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js batch download <batch-id> --out ./batch-output --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js batch submit --file ./batch.json --control http://127.0.0.1:8765 --require-routable --wait --report --download --out ./batch-output
NADO_TOKEN=dev-token node ./src/cli.js batch manage <batch-id> --action retry_failed --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js batch manage <batch-id> --action cancel --control http://127.0.0.1:8765
```

Batch tasks are normal tasks with a shared `batchId`, so scheduling, worker capacity, priority, artifacts, task events, recovery, dependency blocking, and MCP inspection all use the same underlying model.
Use `batch plan`, MCP `nado_plan_batch`, `POST /api/batches/plan`, or the Dashboard Plan Batch form for a submit-ready starter JSON when the control-side user or agent has a list of natural-language subtasks. The generated file is ordinary batch JSON and can be edited before `batch submit` or Dashboard submission.
Use `dispatch plan`, MCP `nado_plan_dispatch`, `POST /api/dispatch/plan`, or the Dashboard Preview Dispatch button to preview how a task list or batch JSON would be assigned before creating tasks:

```bash
NADO_TOKEN=dev-token node ./src/cli.js dispatch plan --control http://127.0.0.1:8765 --file ./batch.json
curl -X POST -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" --data-binary @batch.json http://127.0.0.1:8765/api/dispatch/plan
```

Dispatch planning uses the same scheduler, worker inventory, labels, required tools, and slot capacity model as real task creation. It treats earlier previewed tasks as reserved capacity so a multi-task preview shows realistic spread or unassigned work without mutating gateway state. Unassigned preview items include the same structured `nextAction` hints used by queued task diagnostics, such as adding capacity, fixing an explicit target, or relaxing constraints. When Dashboard task or batch submission is blocked by `requireRoutable`, the returned dispatch plan is rendered in the Dispatch Plan panel with routability, inferred capabilities, effective capabilities, candidate workers, and next actions instead of leaving only a generic error message.
Use `--require-routable` on `submit` or `batch submit`, or set `requireRoutable: true` in HTTP/MCP/Dashboard submissions, when the gateway should reject work that has no online worker matching static routing constraints. This catches missing capabilities, tools, labels, invalid explicit workers, and oversize slot requests before creating tasks while still allowing ordinary queued work when a worker is only temporarily busy. Rejection errors include `nextAction=<code>` and HTTP clients can inspect the attached dispatch plan for per-task action hints.
Use top-level `defaults` in batch JSON or MCP `nado_submit_batch` to avoid repeating common `workerId`, `capabilities`, `tools`, `labels`, `slots`, `priority`, `timeoutMs`, `keepWorkspace`, `sandboxProfile`, artifact policy, and input files on every child task. Child values override defaults; labels merge with child labels taking precedence.
Use `--tool node`, `--tool gh`, `--tool codex`, `--tool claude`, `--tool nvidia-smi`, or `--tool amd-smi` when a task must run on a worker with a specific discovered executable. Tool names are matched against worker inventory, and aliases such as `github` map to `gh`.
Tasks can carry `env` values, and `defaults.env` is merged into child task env with child keys taking precedence. Custom env is injected before reserved `NADO_*` variables, so gateway-provided values such as `NADO_WORKER_ID` cannot be spoofed by a task.
Tasks can carry `artifactPolicy: { "include": ["dist/**"], "exclude": ["dist/tmp/**"] }`, or CLI `--artifact` / `--exclude-artifact`, so workers upload only the output files the control side needs. Batch defaults merge artifact include/exclude lists with child task policies.
Small artifacts keep the existing inline result format. Larger artifacts automatically use attempt-bound, offset-based chunks with persisted resume state and SHA-256 verification, so a lost WAN response or control restart does not force the whole file to be retransmitted. Defaults are 5 MiB per inline file, 20 MiB total inline content, and 4 MiB chunks; tune them with `NADO_ARTIFACT_INLINE_MAX_BYTES`, `NADO_ARTIFACT_INLINE_TOTAL_BYTES`, and `NADO_ARTIFACT_CHUNK_BYTES`.
CLI and Dashboard inputs use the matching reverse path. A task with large local files is created as `uploading_inputs`, cannot be claimed until every input is finalized, and then becomes queued automatically. Workers download finalized inputs with authenticated byte ranges into resumable partial files and verify SHA-256 before execution. Tune this path with `NADO_INPUT_INLINE_MAX_BYTES`, `NADO_INPUT_INLINE_TOTAL_BYTES`, and `NADO_INPUT_CHUNK_BYTES`.
Agent prompt/runtime files under `.nado/` and `.nado-session/prompts/` are hidden from default artifacts so operators see the actual deliverables first; the session transcript remains downloadable for auditability. Explicitly include `.nado/**` or `.nado-session/prompts/**` when debugging an agent prompt.
In CLI batch JSON, child tasks can use `file`/`files` and `dir`/`dirs` paths relative to the batch JSON file; the CLI expands them into the same `inputFiles` payload used by normal task submission.
`batch events` shows a merged timeline of batch lifecycle events and child task events; `--watch` streams new events until the batch is terminal. The same timeline is available through `GET /api/batches/<batch-id>/events`, the HTTP client, MCP, and the Dashboard Event Timeline view.
`batch report` summarizes child status, failed/cancelled tasks, dependency blockers, output excerpts, and artifact paths so a control-side operator or agent can decide the next action without opening every child task.
`batch download` writes each child task's artifacts under `--out/<batch-key-or-task-id>/`, so parallel shards can produce same-named files without overwriting each other. HTTP clients and the Dashboard can also download the same grouped artifact tree as a server-generated ZIP from `GET /api/batches/<batch-id>/artifacts/download`.
Use `batch submit --wait --report --download --out ./batch-output` when a control-side agent or operator should hand off a batch and return only after terminal status, a consolidated report, and local artifacts are ready.
Use `retry_failed` after a batch finishes with errors to requeue only failed or cancelled child tasks; succeeded tasks are left untouched.
Use `cancel` to cancel all non-terminal child tasks in a batch; running children receive the same worker cancellation command used by task-level cancellation.

Every task process receives immutable `NADO_ATTEMPT_ID` and `NADO_ATTEMPT_SEQ` in addition to task, worker, session, workspace, transcript, and hostname variables. Batch children also receive `NADO_BATCH_ID`, `NADO_BATCH_KEY`, and `NADO_BATCH_DEPENDS_ON`.
Set `dependencyArtifacts: true` on a dependent batch child when it should receive direct parent artifacts under `.nado/dependencies/<parent-key>/...`; object form supports `prefix`, `include`, and `exclude`.
The same batch report, event timeline, and grouped artifact content are available through the HTTP client/API, so MCP, CLI, and the Dashboard do not need separate aggregation logic.

Watch tasks:

```bash
NADO_TOKEN=dev-token node ./src/cli.js status --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js sessions --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js tasks --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js task <task-id> --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js schedule <task-id> --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js wait <task-id> --watch --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js events <task-id> --control http://127.0.0.1:8765
```

The same task event stream is available through `GET /api/tasks/<task-id>/events`, the HTTP client, and MCP `nado_list_task_events`.
For low-latency supervision, HTTP clients can open `GET /api/tasks/<task-id>/events/stream` or `GET /api/batches/<batch-id>/events/stream` with the normal bearer token. These endpoints return Server-Sent Events, replay known events, emit new events as they arrive, and close with a `done` event when the task or batch reaches a terminal status. The Dashboard task and batch detail panes include stream buttons that use the same endpoints.

If `submit --wait` or `wait` times out while a task is still queued, the CLI prints the stored scheduler decision, effective capabilities, candidate rejection reasons, the latest event, and a suggested next action so an operator or control-side agent can distinguish missing capabilities from worker communication or capacity problems.

When a task is submitted without `--worker`, the control server schedules it at creation time. The scheduler filters out offline, paused, draining, capability-incompatible, label-incompatible, and full workers, then scores the eligible workers by idle/running state, explicit or inferred capabilities, matching labels, available tools, configured terminal-agent command, and recent failures. The selected worker is recorded on the task as `requestedWorkerId`, and the explanation is stored in `task.scheduler` and exposed through `GET /api/tasks/<task-id>/schedule`, including capability inference rule names and evidence snippets when automatic routing was applied.
When multiple queued tasks are available to a worker, higher `priority` values are claimed first; equal-priority tasks keep FIFO order.

Cancel or requeue a task:

```bash
NADO_TOKEN=dev-token node ./src/cli.js task manage <task-id> --action cancel --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js task manage <task-id> --action requeue --worker worker-b --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js task manage <task-id> --action reschedule --control http://127.0.0.1:8765
```

Use `reschedule` for a queued task when the originally selected worker is no longer the right target. It recomputes the same control-side scheduler decision and updates `requestedWorkerId` plus `task.scheduler`.

Recover tasks from an offline worker:

```bash
NADO_TOKEN=dev-token node ./src/cli.js recover --action list --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js recover --action requeue --worker worker-a --target-worker worker-b --control http://127.0.0.1:8765
```

Recovery scans tasks still marked `running` on workers whose heartbeat has gone stale or whose execution lease expired. Automatic recovery requeues ordinary tasks through normal scheduling and pins session tasks back to the original session Worker, where the deterministic session workspace remains available after reconnection. Manual `requeue` can send ordinary tasks to `--target-worker`. Session tasks remain skipped by the manual recovery command unless `--include-sessions` is explicit; use that flag with another target only when rerunning on a fresh workspace and losing worker-local session state is acceptable.

Download generated artifacts from a remote worker:

```bash
NADO_TOKEN=dev-token node ./src/cli.js artifacts <task-id> --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js artifact download <task-id> <artifact-id> --out ./downloads --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js artifacts download <task-id> --out ./downloads --control http://127.0.0.1:8765
```

Custom HTTP clients can download raw task artifact bytes with the same admin bearer token:

```bash
curl -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:8765/api/tasks/<task-id>/artifacts/<artifact-id>/download \
  --output artifact.bin
```

They can also retrieve all stored task artifact content as JSON for control-side agents, or download the same artifacts as a ZIP:

```bash
curl -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:8765/api/tasks/<task-id>/artifacts/content

curl -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:8765/api/tasks/<task-id>/artifacts/download \
  --output task-artifacts.zip
```

Batch and session artifact snapshots also have direct ZIP downloads:

```bash
curl -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:8765/api/batches/<batch-id>/artifacts/download \
  --output batch-artifacts.zip

curl -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:8765/api/sessions/<session-id>/artifacts/download \
  --output session-artifacts.zip
```

Manage a worker:

```bash
NADO_TOKEN=dev-token node ./src/cli.js worker manage --control http://127.0.0.1:8765 --id worker-a --action pause
NADO_TOKEN=dev-token node ./src/cli.js worker manage --control http://127.0.0.1:8765 --id worker-a --action resume
NADO_TOKEN=dev-token node ./src/cli.js worker manage --control http://127.0.0.1:8765 --id worker-a --action drain
NADO_TOKEN=dev-token node ./src/cli.js worker manage --control http://127.0.0.1:8765 --id worker-a --action shutdown
NADO_TOKEN=dev-token node ./src/cli.js worker manage --control http://127.0.0.1:8765 --id worker-a --action cancel_current
NADO_TOKEN=dev-token node ./src/cli.js worker manage --control http://127.0.0.1:8765 --id worker-a --action rotate_token --wait --evidence ./acceptance-evidence.json
NADO_TOKEN=dev-token node ./src/cli.js worker manage --control http://127.0.0.1:8765 --id worker-a --action forget
```

Use `forget` only after a worker is offline, drained, or has acknowledged shutdown. It removes the retired worker from the gateway list and revokes worker tokens bound to that worker ID while refusing to run if the worker still has non-terminal tasks.

Run health checks:

```bash
NADO_TOKEN=dev-token node ./src/cli.js doctor --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js doctor --control http://127.0.0.1:8765 --self-test --worker worker-a
NADO_TOKEN=dev-token node ./src/cli.js doctor --control http://127.0.0.1:8765 --agent-self-test --worker worker-a
NADO_TOKEN=dev-token node ./src/cli.js doctor --control http://127.0.0.1:8765 --self-test --all-workers
```

Use `--self-test` to submit a real probe task that verifies worker claim, shell execution, and artifact return. Add `--all-workers` to probe every active worker matching the optional worker/capability/tool/label filters.
Use `--agent-self-test` when you need to verify that a worker's configured Codex, Claude Code, or custom terminal-agent command can actually run an `agent` task. It is explicit rather than part of the default doctor path because real terminal agents may require credentials, may use paid model calls, or may take longer than shell probes.

## Using Terminal LLM Agents on Workers

Workers can run an agent command template for `agent` tasks. Use `--agent codex` or `--agent claude` for built-in terminal-agent presets, or `--agent-command` for a custom template. The template receives `{prompt}` and `{promptFile}` placeholders. When an agent task runs inside a Nado session, the worker maintains `.nado-session/transcript.md` and includes prior agent turns in later prompt files, so stateless terminal agents still receive session continuity.

Example:

```bash
NADO_TOKEN=dev-token node ./src/cli.js worker start \
  --control http://127.0.0.1:8765 \
  --id coder-1 \
  --capability code \
  --agent codex
```

List available presets:

```bash
node ./src/cli.js agents
```

Then submit:

```bash
NADO_TOKEN=dev-token node ./src/cli.js submit \
  --control http://127.0.0.1:8765 \
  --worker coder-1 \
  --type agent \
  --title "implement feature" \
  --prompt "Create a small README in the current task workspace."
```

The exact agent command still depends on the CLI installed on that worker. Presets are normal command templates kept in one place; `--agent-command` remains available when your local Codex, Claude Code, Copilot, or other terminal agent needs a different launch command.

## Agent Awareness

For agent tools, run the MCP server from the control side:

```bash
NADO_TOKEN=dev-token node ./src/cli.js mcp --control http://127.0.0.1:8765
```

Generate a reusable stdio MCP client config:

```bash
NADO_TOKEN=dev-token node ./src/cli.js mcp config --control http://127.0.0.1:8765 --format json
```

The generated JSON has an `mcpServers.nado` entry with the Node command, CLI path, control URL, and `NADO_TOKEN` environment variable. Use `--format command` when you only need the raw stdio launch command.

The same MCP client config is available from the authenticated HTTP API and Dashboard:

```bash
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:8765/api/mcp-config
curl -H "Authorization: Bearer dev-token" "http://127.0.0.1:8765/api/mcp-config?format=command"
```

The MCP server exposes these tools:

- `nado_list_workers`
- `nado_worker_preflight`
- `nado_list_worker_events`
- `nado_status`
- `nado_network`
- `nado_capabilities`
- `nado_doctor`
- `nado_verify`
- `nado_acceptance_template`
- `nado_record_acceptance_evidence`
- `nado_acceptance_report`
- `nado_demo_health`
- `nado_list_agent_presets`
- `nado_create_worker_invite`
- `nado_create_worker_bundle`
- `nado_create_worker_bootstrap_bundle`
- `nado_list_worker_tokens`
- `nado_revoke_worker_token`
- `nado_list_worker_enrollment_tokens`
- `nado_revoke_worker_enrollment_token`
- `nado_prune_worker_enrollment_tokens`
- `nado_list_tasks`
- `nado_prune_system_history`
- `nado_submit_batch`
- `nado_run_batch`
- `nado_plan_batch`
- `nado_plan_dispatch`
- `nado_list_batches`
- `nado_get_batch`
- `nado_wait_batch`
- `nado_list_batch_artifacts`
- `nado_get_batch_artifacts`
- `nado_batch_report`
- `nado_list_batch_events`
- `nado_manage_batch`
- `nado_create_session`
- `nado_list_sessions`
- `nado_get_session`
- `nado_close_session`
- `nado_list_session_artifacts`
- `nado_get_session_artifacts`
- `nado_get_task`
- `nado_list_task_events`
- `nado_explain_schedule`
- `nado_manage_task`
- `nado_recover_offline_tasks`
- `nado_list_artifacts`
- `nado_get_task_artifacts`
- `nado_get_artifact`
- `nado_submit_task`
- `nado_run_task`
- `nado_manage_worker`
- `nado_wait_task`

Use `nado_run_task` when a control-side agent should submit one task and receive the terminal task detail plus stored artifact content in a single MCP call. It uses the same task creation, wait, and base64 artifact APIs as `nado_submit_task`, `nado_wait_task`, and `nado_get_task_artifacts`. `nado_submit_task` and `nado_run_task` also return a top-level `routing` summary with `selectedWorkerId`, `targetWorkerId`, `targetEligible`, `routeStatus`, `nextAction`, scheduler reason, inferred capabilities such as `gpu`, inference evidence, and rejected candidate reasons so an agent can tell the difference between a runnable selected worker and an explicit target that is not currently eligible.
When a MCP tool fails because gateway task creation was rejected, the tool returns `isError: true` with JSON content containing `status`, `nextActions`, and `dispatchPlan` instead of losing that structure in a plain JSON-RPC error.
Use `nado_get_task_artifacts` when the agent already has a `taskId` and wants all stored task outputs in one JSON response; use `nado_get_artifact` for one specific file.
Use `nado_run_batch` when a control-side agent should submit multiple subtasks and receive the terminal batch detail, consolidated report, and grouped artifact content in a single MCP call. It uses the same durable batch, wait, report, and grouped artifact APIs as the separate batch tools. `nado_submit_batch` and `nado_run_batch` return `routing[]` summaries for each child task, and `nado_run_batch` also returns `finalRouting[]` after completion.

You can also generate a context file that a control-side agent can read:

```bash
NADO_TOKEN=dev-token node ./src/cli.js context --control http://127.0.0.1:8765 --out ./.nado/AGENTS.md
NADO_TOKEN=dev-token node ./src/cli.js context install --control http://127.0.0.1:8765 --out ./AGENTS.md
```

Use `context install` when the current project's control-side agent should automatically see the latest Nado workers and dispatch commands from its normal `AGENTS.md` discovery path. The command preserves existing project instructions and updates only the marked Nado block.

The same generated context is available from the authenticated HTTP API and Dashboard:

```bash
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:8765/api/context
```

This file lists current workers, gateway state, capabilities, management commands, MCP launch command, and useful dispatch commands.

## Control Security Operations

Production control planes should terminate TLS at Caddy, another trusted reverse proxy, or a private encrypted overlay. The API applies fixed-window limits by source IP and authenticated identity, caps ordinary JSON requests, and returns `429 Retry-After` or `413` when a guard is exceeded. Configure the defaults with `NADO_RATE_LIMIT_*` and `NADO_JSON_BODY_MAX_BYTES`; keep the worker chunk-transfer limits separate because artifact/input chunks use streaming endpoints.

Failed API requests, successful administrator mutations, and Worker registration/enrollment are written to the durable control store without request bodies or raw bearer tokens. Inspect or export them with:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js audit --control http://127.0.0.1:8765 --tail 100
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js audit --control http://127.0.0.1:8765 --out ./nado-audit.ndjson
```

For continuous external collection, set `NADO_AUDIT_NDJSON_FILE=/var/log/nado/audit.ndjson` or pass `control start --audit-ndjson-file <path>`. Every sanitized durable event is then serialized through a non-blocking ordered append queue; a file failure does not fail the API request or discard the database copy. The queue is bounded to 1,024 pending events by default (`NADO_AUDIT_NDJSON_MAX_PENDING`), so a stalled mount cannot grow control memory without limit. `/api/status` and `/api/capabilities` separately expose current sink health and delivery integrity: any write failure or queue drop leaves integrity `incomplete` for the process lifetime so operators know to backfill from the durable audit API. The summaries contain counters/error codes but no host path. The file is mode `0600` on Unix and reopened for every event, so Filebeat/Fluent Bit/Vector and rename-based log rotation can collect it without restarting control. Keep it outside the control data directory; the bundled Compose files mount `/data/audit` as a separate volume.

The Dashboard uses a per-response CSP nonce, denies framing, disables MIME sniffing/referrer disclosure, and does not persist the administrator token in browser storage. The token remains available to page JavaScript while the page is open, so operate the Dashboard only on a trusted, TLS-protected origin and close the tab on shared machines. See the [threat model](./docs/threat-model.md) and [cross-site deployment guide](./docs/cross-site-deployment.md).

For an application-consistent control backup, stop the control process first. The backup command migrates old state, snapshots the complete control data directory, writes a per-file SHA-256 manifest, and refuses to overwrite an existing destination. Restore verifies the entire backup and writes only to a new path, so an existing control volume is never silently replaced:

```bash
node ./src/cli.js store backup --data-dir .nado --store sqlite --out ./nado-backup --offline-confirmed
node ./src/cli.js store verify --from ./nado-backup
node ./src/cli.js store restore --from ./nado-backup --data-dir ./restored-control --offline-confirmed
```

After restore, point the control service at `./restored-control`, start it, and run `verify --all-workers`. State format and SQLite schema versions are explicit; older supported state migrates on load, while newer incompatible state is rejected instead of being downgraded.

## Design and Acceptance

- [Project design](./docs/design.md)
- [MVP acceptance checklist](./docs/acceptance.md)
- [Cross-site deployment](./docs/cross-site-deployment.md)
- [Threat model](./docs/threat-model.md)
- [Progress and open-source benchmark](./docs/progress-and-benchmark.md)
