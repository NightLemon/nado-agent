# Nado Agent

Nado Agent is a gateway MVP for coordinating multiple Ubuntu/WSL-style worker machines from one control-side agent.

The control node exposes an HTTP API, CLI, and MCP tool server. Worker nodes register themselves, advertise capabilities, keep heartbeats alive while work is running, execute tasks in per-task workspaces, and report observed state, metrics, current task, runtime events, resource diagnostics, agent readiness diagnostics, and results back to the gateway. A control-side LLM agent such as Codex, Claude Code, or another terminal agent can use MCP tools to discover workers, dispatch work, inspect status/logs, and manage worker state.

For the shortest hands-on verification path, see [DEMO.md](./DEMO.md). For pre-push safety and Azure VM deployment, see [docs/github-readiness.md](./docs/github-readiness.md) and [docs/azure-vm-deployment.md](./docs/azure-vm-deployment.md).

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

This compose file is for local demo use. Use `docker-compose.azure.yml` plus a real `.env` file for an Azure VM control node.

The compose stack starts one control container and two worker containers (`docker-code` and `docker-gpu`) on the Docker network. Open `http://127.0.0.1:59610/dashboard`; the demo dashboard auto-loads `docker-demo-token`, or set `NADO_DOCKER_PORT=<port>` before `docker compose up` to expose a different host port. When onboarding workers from another machine to a Docker-hosted control server, set `NADO_PUBLIC_CONTROL_URL=http://<host-lan-or-ipv6>:<published-port>` before `docker compose up`; otherwise the container can only see container-internal bridge addresses such as `172.x.x.x`, which the Dashboard marks as not suitable for remote workers. `GET /api/network` and Demo Health include a structured `nextAction` hint with copy-ready `nextAction.commands` so the Dashboard, CLI, MCP clients, and control-side agents can either build a worker bundle with the preferred remote URL or tell the operator exactly how to configure `NADO_PUBLIC_CONTROL_URL`. Set `NADO_HOST=::` when the control container should listen on IPv6/dual-stack inside the container, set `NADO_DOCKER_HOST_IP=::` when Docker should publish the demo port on the host's IPv6 listener, and keep IPv6 literal public URLs bracketed, for example `NADO_PUBLIC_CONTROL_URL=http://[2001:db8::10]:59610`.
The control container sets `NADO_INTERNAL_CONTROL_URL=http://127.0.0.1:8765` so server-side doctor/verify checks call the in-container listener while generated dashboard/context URLs still use the browser-facing host URL. It also sets `NADO_DASHBOARD_AUTO_TOKEN=true` for demo usability; normal `control start` does not inject the admin token into dashboard HTML unless started with `--dashboard-auto-token`. If a reverse proxy terminates HTTPS or exposes the control server under a different host, either set `NADO_PUBLIC_CONTROL_URL` explicitly or start the server with `--trust-proxy` / `NADO_TRUST_PROXY=true` so authenticated control APIs can derive external URLs from `X-Forwarded-Host` and `X-Forwarded-Proto`.

Start the control server:

```bash
NADO_TOKEN=dev-token node ./src/cli.js control start --host 0.0.0.0 --port 8765
```

For a production-shaped single-node control server, use the SQLite store:

```bash
NADO_STORE=sqlite NADO_TOKEN=<admin-token> node ./src/cli.js control start --host 0.0.0.0 --port 8765 --data-dir .nado
```

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
NADO_TRUST_PROXY=true NADO_INTERNAL_CONTROL_URL=http://127.0.0.1:8765 \
  NADO_TOKEN=dev-token node ./src/cli.js control start --host 127.0.0.1 --port 8765
```

Open `http://<control-host>:8765/` or `/dashboard` in a browser for the built-in control dashboard. Enter the same admin `NADO_TOKEN` in the page to load workers, preview the Control Console route before creating a task, run agent-style work from the Control Console with automatic pre-submit route preview, task detail, artifact preview, and event streaming, create or clear a long-lived Control Console session without copying session IDs between pages, inspect worker detail/inventory/metrics/runtime events, tasks, batches, sessions, use the dedicated Onboarding tab to download self-service worker bootstrap bundles, issue worker tokens, download fixed-ID worker invite scripts and portable worker bundle zips, immediately self-test invited workers, list/revoke worker tokens, preview/download the current control-agent `AGENTS.md` context, preview/download a machine-readable gateway manifest, preview/download MCP client config, run doctor checks and self-test probes, submit shell or terminal-agent tasks with env/input files/artifact policy/workspace controls, create and inspect sessions, submit into sessions, download the latest session artifact snapshot as a zip, plan batch JSON from short subtask lines, submit batch JSON, inspect batch child tasks, reports, and event timelines, stream task and batch events live, list and download task artifacts or batch artifacts as ZIP files, retry or cancel batches, cancel/requeue/reschedule tasks, inspect scheduler decisions, reset demo clutter from the Workbench while preserving sessions/batches that contain work, clear old standalone completed task history while preserving batch/session records, clear completed verify/doctor system history, recover tasks stranded on offline workers, manage worker state, inspect task stdout/stderr/events, and download individual task artifacts.
The Operations page also has a Demo Health action that runs the same operator summary as `nado demo health`, including network hints, worker inventory, automatic GPU/docs/PPT route checks, optional readiness verification, and diagnostic history cleanup.

Generate a self-service worker bootstrap zip for another Ubuntu/WSL host. This is the preferred remote onboarding path when you do not care about choosing the worker ID yourself:

```bash
NADO_TOKEN=dev-token node ./src/cli.js worker bootstrap-bundle \
  --control http://<control-host>:8765 \
  --capability code \
  --label zone=lab \
  --out ./nado-worker-bootstrap.zip
```

Copy the zip to the worker host, unzip it, then run `bash ./start-worker.sh` from inside the extracted folder. On first start the worker generates a local Ed25519 keypair, sends the public key to the control server with the embedded enrollment token, receives a worker-scoped token, stores its assigned worker ID in `.nado/worker-identity.json`, runs the normal preflight with the signed worker token, and then starts the normal worker runtime. Later starts reuse that local identity, run the same signed preflight, and do not need the enrollment token again. If the stored worker token was revoked or expired and the start script still has a fresh enrollment token, bootstrap automatically re-enrolls the same worker ID and overwrites the stale identity before starting. Worker tokens created through this self-service path require Ed25519-signed worker requests after enrollment, so the registered public key is part of the live control/worker communication path. Signed requests include method, path, body hash, timestamp, nonce, and worker ID; the control server records recent nonces and rejects replayed signed requests inside the timestamp window.
Self-service bootstrap bundles issue one-use enrollment tokens by default and set a seven-day expiry unless `--max-uses` or `--expires-at` is provided.
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
Generated invite scripts run `worker preflight` before `worker start`. The preflight checks Node.js, the repository entrypoint, data-directory access, control-server health, and whether the bearer token is accepted for that worker ID.

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

For a real multi-machine smoke test:

1. Start control on the machine you talk to: `node ./src/cli.js control start --host 0.0.0.0 --port 8765`, or use `--host ::` for IPv6/dual-stack hosts.
2. Make sure worker machines can reach `http://<control-host>:8765`; use `--public-control-url` or `NADO_PUBLIC_CONTROL_URL` when the advertised URL differs from the local listener, and use bracketed IPv6 URL syntax such as `http://[2001:db8::10]:8765` when the control host is an IPv6 literal. If the reachable URL is supplied by a trusted reverse proxy, use `--trust-proxy` or `NADO_TRUST_PROXY=true` so Dashboard/context/bundle URLs can follow `X-Forwarded-Host` and `X-Forwarded-Proto`. The Dashboard worker onboarding panel can call `GET /api/network` to show clickable LAN/IPv6 Control URL candidates, warn when the current browser URL is loopback-only, and mark likely Docker bridge addresses as unsuitable for remote workers. Set `NADO_PUBLIC_CONTROL_URL` when the control server runs inside a container and the published host address cannot be discovered from inside that container.
3. Generate one `worker invite` per host if the repo already exists there, or one `worker bundle` zip if the remote host needs a portable copy of the worker runtime.
4. Confirm inventory from the control host with `node ./src/cli.js workers --control http://<control-host>:8765`.
5. Submit a routed test, for example `--capability gpu` or `--required-label zone=lab`, then use `wait`, `batch report`, and `batch download` from the control host.

Workers automatically report host/tool inventory during registration and heartbeat, including Node.js, Git, GitHub CLI, Codex CLI, Claude CLI, and NVIDIA or ROCm GPU presence when available. The gateway also infers capabilities such as `shell`, `git`, `agent`, `github`, and `gpu`. GPU diagnostics distinguish `probe` workers, where NVIDIA/ROCm tooling was discovered, from `advertised` workers, where `gpu` was manually declared but no accelerator probe was reported; Demo Health, the Dashboard, and the capabilities manifest surface a warning for advertised-only GPU workers so real accelerator workloads are not confused with a simulated or manually labeled demo host. Agent readiness diagnostics distinguish real Codex/Claude terminal-agent workers from custom commands, demo echo agents, missing CLI tools, failed self-tests, and shell-only workers, so control-side agents can choose the right worker without scraping Dashboard text. The scheduler can infer GPU/docs/PPT requirements from high-confidence task wording such as CUDA, NVIDIA, ROCm, VRAM/显存, Stable Diffusion, README/documentation/文档, or PPT/PowerPoint/幻灯片/演示文稿 terms, while explicit `--capability` remains available when the user already knows the target requirement. When GPU is required and several GPU-capable workers are eligible, probe-detected GPU workers receive a routing bonus and advertised-only GPU workers receive a small penalty but remain usable as a fallback for demos or manually managed hosts. Agent tasks require a configured worker-side agent command; when several workers can run the task, the scheduler prefers real Codex/Claude terminal-agent workers over demo echo agents, rejects Codex/Claude presets whose CLI is missing from inventory, and still records recent/stale/failed `doctor --agent-self-test` signals in the candidate reasons. Non-GPU tasks receive a GPU-preservation penalty on GPU-capable workers, so generic work does not consume scarce accelerator capacity unless that is the best or only route. Recorded scheduler decisions include `inferenceReasons` so the CLI, Dashboard, MCP, or another control-side agent can explain which rule caused automatic routing. Use worker labels such as `zone=lab`, `role=builder`, or `owner=team-a` for routing constraints that are not capabilities.

Workers default to one running task slot at a time. Use `--max-concurrency <n>` when a host can safely run multiple independent tasks in parallel. Each task defaults to `slots: 1`; use CLI `--slots 2` or batch/MCP `slots` when a GPU/model/build task should reserve more of the worker. The control server tracks running plus reserved slots and the scheduler avoids workers without enough remaining capacity. Tasks in the same session still run serially to protect the shared session workspace.
Each worker claim gets a task attempt ID. If a task is recovered or retried and an older worker later reports stale output or a stale result, the gateway ignores that old attempt so recovered work cannot be overwritten.
Use `--cleanup-workspaces` on worker start when non-session task workspaces should be deleted after artifacts are uploaded to the control side. Individual tasks can override this with `--keep-workspace` or `--cleanup-workspace`.
Use `--sandbox` or `--sandbox-profile isolated` for tasks that should run with a minimal inherited host environment. The isolated profile keeps only basic OS process variables such as `PATH`, temp, and home, plus explicit task `--env` values and gateway-managed `NADO_*` variables. It is a lightweight execution boundary, not a container or VM; pair it with worker-level isolation for untrusted code.

Manage issued worker tokens:

```bash
NADO_TOKEN=dev-token node ./src/cli.js worker token create --control http://127.0.0.1:8765 --id worker-a --label "lab box"
NADO_TOKEN=dev-token node ./src/cli.js worker tokens --control http://127.0.0.1:8765
NADO_TOKEN=dev-token node ./src/cli.js worker token revoke <token-id> --control http://127.0.0.1:8765
```

The raw worker token is printed only when it is created or embedded in an invite; stored token listings show only redacted metadata and a short preview.

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
Use `--tool node`, `--tool gh`, `--tool codex`, `--tool claude`, or `--tool nvidia-smi` when a task must run on a worker with a specific discovered executable. Tool names are matched against worker inventory, and aliases such as `github` map to `gh`.
Tasks can carry `env` values, and `defaults.env` is merged into child task env with child keys taking precedence. Custom env is injected before reserved `NADO_*` variables, so gateway-provided values such as `NADO_WORKER_ID` cannot be spoofed by a task.
Tasks can carry `artifactPolicy: { "include": ["dist/**"], "exclude": ["dist/tmp/**"] }`, or CLI `--artifact` / `--exclude-artifact`, so workers upload only the output files the control side needs. Batch defaults merge artifact include/exclude lists with child task policies.
Agent prompt/runtime files under `.nado/` and `.nado-session/prompts/` are hidden from default artifacts so operators see the actual deliverables first; the session transcript remains downloadable for auditability. Explicitly include `.nado/**` or `.nado-session/prompts/**` when debugging an agent prompt.
In CLI batch JSON, child tasks can use `file`/`files` and `dir`/`dirs` paths relative to the batch JSON file; the CLI expands them into the same `inputFiles` payload used by normal task submission.
`batch events` shows a merged timeline of batch lifecycle events and child task events; `--watch` streams new events until the batch is terminal. The same timeline is available through `GET /api/batches/<batch-id>/events`, the HTTP client, MCP, and the Dashboard Event Timeline view.
`batch report` summarizes child status, failed/cancelled tasks, dependency blockers, output excerpts, and artifact paths so a control-side operator or agent can decide the next action without opening every child task.
`batch download` writes each child task's artifacts under `--out/<batch-key-or-task-id>/`, so parallel shards can produce same-named files without overwriting each other. HTTP clients and the Dashboard can also download the same grouped artifact tree as a server-generated ZIP from `GET /api/batches/<batch-id>/artifacts/download`.
Use `batch submit --wait --report --download --out ./batch-output` when a control-side agent or operator should hand off a batch and return only after terminal status, a consolidated report, and local artifacts are ready.
Use `retry_failed` after a batch finishes with errors to requeue only failed or cancelled child tasks; succeeded tasks are left untouched.
Use `cancel` to cancel all non-terminal child tasks in a batch; running children receive the same worker cancellation command used by task-level cancellation.

Batch child processes receive `NADO_BATCH_ID`, `NADO_BATCH_KEY`, and `NADO_BATCH_DEPENDS_ON` in addition to the task, worker, session, workspace, transcript, and hostname environment variables.
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

Recovery scans tasks still marked `running` on workers whose heartbeat has gone stale. `requeue` clears their stale runtime state and either sends them to `--target-worker` or runs the normal scheduler again. Session tasks are skipped by default because their shared workspace may only exist on the offline worker; use `--include-sessions` only when rerunning that session task on a fresh workspace is acceptable.

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

## Design and Acceptance

- [Project design](./docs/design.md)
- [MVP acceptance checklist](./docs/acceptance.md)
