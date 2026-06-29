<!-- nado-agent-context:start -->
# Nado Agent Control Context

Generated: 2026-06-28T16:40:43.878Z
Control URL: http://127.0.0.1:59610

## Available Workers

- docker-code: idle; admin: enabled; slots: 0/2; current task: none; capabilities: agent, code, docs, git, ppt, shell; labels: zone=docker, role=builder; tools: node (v20.20.2), git (git version 2.39.5), claude (2.1.96 (Claude Code)); gpu: none; agent: verified/real-terminal-agent (real terminal agent); agent self-test: succeeded at 2026-06-28T16:06:36.098Z; last seen: 2026-06-28T16:40:43.399Z
- docker-gpu: idle; admin: enabled; slots: 0/1; current task: none; capabilities: agent, code, git, gpu, shell; labels: zone=docker, role=accelerator; tools: node (v20.20.2), git (git version 2.39.5), claude (2.1.96 (Claude Code)); gpu: advertised (gpu capability is advertised but no NVIDIA/ROCm probe was reported; verify the worker GPU runtime before scheduling real accelerator workloads); agent: demo/demo-echo; agent warning: demo echo agent is configured; it validates scheduling and artifacts but does not perform real LLM reasoning; agent self-test: succeeded at 2026-06-28T16:06:36.111Z; last seen: 2026-06-28T16:40:43.384Z

## Sessions

- No sessions yet.

## MCP Tools

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
- `nado_plan_batch`
- `nado_submit_batch`
- `nado_run_batch`
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

## Routing Policy

- Workers make outbound HTTP requests to the control URL. IPv6 literals must use bracketed URL syntax such as `http://[2001:db8::10]:8765`; use `NADO_PUBLIC_CONTROL_URL` when the URL workers should use differs from the local listener. If the control server is behind a trusted reverse proxy, start it with `--trust-proxy` or `NADO_TRUST_PROXY=true` so generated URLs can use `X-Forwarded-Host` and `X-Forwarded-Proto`. `GET /api/network` returns `nextAction` plus `nextAction.commands` so agents can tell whether to use a detected non-loopback URL, build a worker bundle, or configure a public IPv6/LAN URL first.
- Explicit worker targets are honored only when the target is eligible; otherwise the scheduler records why the target could not claim the task.
- Sessions keep worker affinity so follow-up tasks stay on the same worker/workspace.
- Automatic capability inference:
- gpu: inferred from title, prompt, description, command using rules: CUDA keyword; cuDNN keyword; NVIDIA GPU probe; VRAM keyword; ROCm keyword; TensorRT keyword; Stable Diffusion workload; ComfyUI workload; Diffusers workload; ML framework with accelerator wording; Accelerator wording with ML framework; Chinese VRAM keyword; GPU execution verb; GPU keyword with execution verb; Chinese GPU execution wording; Chinese GPU keyword with execution wording; Chinese model workload with GPU wording; Chinese GPU wording with model workload
- ppt: inferred from title, prompt, description using rules: PPT keyword; PowerPoint keyword; Slide deck keyword; Presentation deck keyword; Slides creation wording; Slides artifact wording; Chinese PPT keyword; Chinese slide keyword; Chinese presentation document keyword; Chinese deck creation wording; Chinese deck artifact wording
- docs: inferred from title, prompt, description using rules: Documentation keyword; Docs keyword; README keyword; User guide keyword; Manual keyword; Word document artifact; Documentation writing wording; Documentation artifact wording; Chinese docs keyword; Chinese manual keyword; Chinese documentation writing wording; Chinese documentation artifact wording
- agent readiness: agent tasks require a configured agent command; recent successful agent self-tests receive a +25 routing score bonus for 24 hours; stale successes receive +10; failed agent self-tests receive -25.
- agent preference: agent tasks add 20 points for real Codex/Claude terminal agents, subtract 20 points from demo echo agents, and reject Codex/Claude preset workers when the matching CLI is missing from inventory.
- resource preference: non-GPU tasks subtract 30 points from GPU-capable workers to keep accelerators free unless GPU is required.
- GPU preference: GPU-required tasks add 15 points for workers with NVIDIA/ROCm probe evidence and subtract 5 points from advertised-only GPU workers; advertised-only workers remain eligible as a fallback.
- Worker summaries include GPU resource diagnostics. `gpu: probe` means NVIDIA/ROCm tooling was detected in inventory; `gpu: advertised` means the worker claims GPU capability but no probe has been reported yet, so verify the runtime before assigning real accelerator workloads.
- Worker summaries include agent readiness diagnostics. `real-terminal-agent` means a Codex or Claude preset has matching tool inventory; `demo-echo` validates the gateway flow but does not perform real LLM reasoning; `missing-tool` means the preset is configured but its CLI was not reported by inventory.

## Dispatch Commands

Gateway status:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js status --control http://127.0.0.1:59610
```

Network diagnostics for remote worker onboarding:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js network --control http://127.0.0.1:59610
```

Machine-readable gateway capabilities:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js capabilities --control http://127.0.0.1:59610
```

End-to-end readiness verification:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js verify --control http://127.0.0.1:59610
```

Demo health summary with Dashboard URL, network hints, worker inventory, route checks, readiness verification, and diagnostic cleanup:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js demo health --control http://127.0.0.1:59610
```

Preview or apply a live demo history reset that preserves session and batch records:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js demo reset --control http://127.0.0.1:59610 --dry-run
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js demo reset --control http://127.0.0.1:59610 --yes
```

Browser dashboard:

```text
http://127.0.0.1:59610/dashboard
```

List workers:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js workers --control http://127.0.0.1:59610
```

Inspect worker runtime logs:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker logs --control http://127.0.0.1:59610 --id <worker-id> --tail 50
```

Generate a self-service worker bundle for another Ubuntu/WSL host. Prefer this onboarding path when the user has not already chosen a fixed worker ID; the remote worker generates a keypair, registers its public key, receives a worker-scoped token, saves its assigned worker ID locally, and signs later worker requests with its private key:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker bootstrap-bundle --control http://127.0.0.1:59610 --capability code --agent codex --out ./nado-worker-bootstrap.zip
```

Generate a worker invite script for another Ubuntu/WSL host when a fixed worker ID is required:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker invite --control http://127.0.0.1:59610 --id <worker-id> --capability code --agent codex --issue-token
```

Generate a portable worker bundle zip for a remote host that does not already have this repository and already has a chosen worker ID:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker bundle --control http://127.0.0.1:59610 --id <worker-id> --capability code --agent codex --issue-token --out ./nado-worker.zip
```

List or revoke issued worker tokens:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker tokens --control http://127.0.0.1:59610
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker token revoke <token-id> --control http://127.0.0.1:59610
```

List or revoke self-service worker enrollment tokens:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker enrollments --control http://127.0.0.1:59610
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker enrollments prune --dry-run --control http://127.0.0.1:59610
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker enrollments prune --control http://127.0.0.1:59610
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker enrollment revoke <enrollment-token-id> --control http://127.0.0.1:59610
```

Submit to a specific worker:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js submit --control http://127.0.0.1:59610 --worker <worker-id> --title "short task title" --command "echo hello"
```

Create a long-lived session:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js session create --control http://127.0.0.1:59610 --title "subproject name" --capability code
```

Submit into a session:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js submit --control http://127.0.0.1:59610 --session <session-id> --title "next step" --command "your shell command"
```

Download a session snapshot:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js session download <session-id> --control http://127.0.0.1:59610 --out ./session-output
```

Attach a local input file:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js submit --control http://127.0.0.1:59610 --worker <worker-id> --file ./brief.md --title "process brief" --command "cat brief.md"
```

Attach a local directory:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js submit --control http://127.0.0.1:59610 --session <session-id> --dir ./small-project --title "work on project" --command "ls -R"
```

Download all task artifacts:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js artifacts download <task-id> --control http://127.0.0.1:59610 --out ./downloads
```

Recover a task:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js task manage <task-id> --control http://127.0.0.1:59610 --action cancel
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js task manage <task-id> --control http://127.0.0.1:59610 --action requeue --worker <worker-id>
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js task manage <task-id> --control http://127.0.0.1:59610 --action reschedule
```

Recover tasks stranded on offline workers:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js recover --control http://127.0.0.1:59610 --action list
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js recover --control http://127.0.0.1:59610 --action requeue --worker <offline-worker-id> --target-worker <worker-id>
```

Submit by capability:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js submit --control http://127.0.0.1:59610 --capability code --title "implement subtask" --command "your shell command"
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js submit --control http://127.0.0.1:59610 --capability code --title "implement subtask" --command "your shell command" --wait --download --out ./task-output
```

Submit by worker label:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js submit --control http://127.0.0.1:59610 --required-label zone=lab --priority 10 --title "labelled host task" --command "your shell command"
```

Use higher priority for urgent queued work; equal-priority tasks keep FIFO order.
Use `--env KEY=value` when a worker command needs build flags, tool configuration, or model paths; reserved `NADO_*` variables are still controlled by the gateway.
Use `--sandbox` or `--sandbox-profile isolated` when a task should receive only minimal host environment variables plus explicit task env and gateway-managed `NADO_*` values.
Use `--tool node`, `--tool gh`, `--tool codex`, `--tool claude`, or `--tool nvidia-smi` when a task requires a specific executable from worker inventory.
Use `--slots 2` when a task should reserve multiple worker slots, such as GPU/model-heavy or large build work.
Use `--artifact dist/**` and `--exclude-artifact dist/tmp/**` when only selected worker outputs should be uploaded back to the control side.
Use `--cleanup-workspace` for one-off non-session tasks when worker-local files should be removed after artifacts are uploaded; use `--keep-workspace` when you need to inspect the worker-local workspace.

Submit a batch of subtasks. In the JSON file, use task `key` and `dependsOn` when later work must wait for earlier work:

```bash
node ./src/cli.js batch plan --title "implementation shards" --type agent --capability code --task "docs: Draft docs" --task "tests: Add smoke tests" --out ./batch.json
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js batch submit --control http://127.0.0.1:59610 --file ./batch.json
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js dispatch plan --control http://127.0.0.1:59610 --file ./batch.json
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js batch events <batch-id> --control http://127.0.0.1:59610 --watch
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js batch wait <batch-id> --control http://127.0.0.1:59610
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js batch report <batch-id> --control http://127.0.0.1:59610
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js batch download <batch-id> --control http://127.0.0.1:59610 --out ./batch-output
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js batch submit --control http://127.0.0.1:59610 --file ./batch.json --require-routable --wait --report --download --out ./batch-output
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js batch manage <batch-id> --control http://127.0.0.1:59610 --action retry_failed
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js batch manage <batch-id> --control http://127.0.0.1:59610 --action cancel
```

Submit to a worker's terminal LLM agent:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js submit --control http://127.0.0.1:59610 --worker <worker-id> --type agent --title "agent subtask" --prompt "Describe the work here."
```

Inspect a task:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js task <task-id> --control http://127.0.0.1:59610
```

Wait for a task:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js wait <task-id> --watch --control http://127.0.0.1:59610
```

Inspect a scheduler decision:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js schedule <task-id> --control http://127.0.0.1:59610
```

Manage a worker:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker manage --control http://127.0.0.1:59610 --id <worker-id> --action pause
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker manage --control http://127.0.0.1:59610 --id <worker-id> --action resume
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker manage --control http://127.0.0.1:59610 --id <worker-id> --action drain
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker manage --control http://127.0.0.1:59610 --id <worker-id> --action shutdown
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker manage --control http://127.0.0.1:59610 --id <worker-id> --action cancel_current
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js worker manage --control http://127.0.0.1:59610 --id <worker-id> --action forget
```

MCP server for control-side agents:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js mcp --control http://127.0.0.1:59610
```

List worker agent presets:

```bash
node ./src/cli.js agents
```

Generate MCP client config JSON:

```bash
NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js mcp config --control http://127.0.0.1:59610 --format json
```

## Notes For Control-Side Agents

- Prefer explicit `--worker` when the user names a worker or a hardware constraint.
- Use the browser dashboard at `http://127.0.0.1:59610/dashboard` for quick operator inspection, Control Console runs with automatic pre-submit route preview, one-click GPU/docs/PPT route checks that do not create tasks, real Stop Task cancellation for the current console task, Workbench Reset Demo cleanup, worker detail/inventory/metrics review, AGENTS.md context preview/download, MCP client config generation, doctor checks and self-test probes, worker invite generation/download/self-test, portable worker bundle download, worker token and enrollment token listing/revocation, shell or terminal-agent task submission with env/input files/artifact policy/workspace controls, task scheduler inspection, task cancel/requeue/reschedule, old standalone completed task history cleanup, offline task recovery, session creation/inspection, session task submission, latest session artifact zip download, batch planning, batch JSON submission, batch retry/cancel, batch detail/report/event timeline inspection, and batch artifact zip download.
- Use `quickstart` when you need a one-command local gateway: it starts the real control server and worker runtime, runs doctor self-test, and writes AGENTS.md plus MCP config files.
- Prefer `--capability` when the user asks for any matching machine, such as GPU, docs, code, ppt, or long-running. If omitted, Nado still infers high-confidence GPU/docs/PPT needs from task wording and records the inference evidence.
- When no worker is explicit, Nado records the control-side scheduler choice on the task; inspect it with `schedule <task-id>` or MCP `nado_explain_schedule` before explaining dispatch.
- Check worker slots before assigning many tasks; `runningSlots/maxConcurrency` shows weighted current capacity.
- Prefer `worker bootstrap-bundle --out ./nado-worker-bootstrap.zip` for remote hosts. The worker generates its own keypair, registers its public key with an enrollment token, receives a revocable worker token, stores its assigned worker ID locally, runs signed preflight before starting, can re-enroll with a fresh embedded enrollment token if the stored worker token was revoked, and signs later worker requests with its private key.
- Use `worker enrollments`, `worker enrollments prune --dry-run`, Dashboard Worker Tokens, or MCP `nado_list_worker_enrollment_tokens`/`nado_revoke_worker_enrollment_token`/`nado_prune_worker_enrollment_tokens` to inspect, safely prune unused, or revoke self-service bootstrap enrollment tokens after distributing worker packages.
- When creating invites or bundles from the Dashboard, HTTP API, or CLI without an explicit bundle Control URL, Nado prefers `NADO_PUBLIC_CONTROL_URL` or the best non-loopback LAN/IPv6 candidate from `GET /api/network`; inspect `nado network --control http://127.0.0.1:59610`, MCP `nado_network`, or `network.nextAction`, and configure `NADO_PUBLIC_CONTROL_URL` or pass CLI `--bundle-control-url` first when the control server runs in Docker and only container bridge addresses are visible.
- When creating worker packages through MCP, pass `bundleControlUrl` or `publicControlUrl` to `nado_create_worker_invite`, `nado_create_worker_bundle`, or `nado_create_worker_bootstrap_bundle` if the MCP client reaches control through loopback but remote workers must connect through a LAN/public/bracketed IPv6 URL.
- Use `worker invite --issue-token` or `worker bundle --issue-token --out ./nado-worker.zip` only when the user needs to choose a fixed worker ID up front; the zip contains start scripts that still run the normal preflight and `worker start` paths.
- Use `worker preflight --control http://127.0.0.1:59610 --id <worker-id>` on a remote host before `worker start` when you need to verify Node.js, repo path, data directory, control reachability, and token binding.
- Use `worker logs --id <worker-id> --tail 50` or MCP `nado_list_worker_events` when a remote worker fails, disappears, or receives management commands and you need its latest control-side runtime timeline.
- Check `status`, `doctor --self-test`, or MCP `nado_status`/`nado_doctor`/`nado_list_workers` before assigning work so you do not route to paused, draining, offline, or non-executing workers; `status` includes `tasks.attention` for queued routing issues that need operator action.
- Use `doctor --agent-self-test --worker <worker-id>`, Dashboard Doctor's agent self-test checkbox, or MCP `nado_doctor` with `agentSelfTest: true` before trusting that a Codex/Claude/custom terminal-agent worker can actually run agent tasks; this is explicit because real agent calls may require credentials or spend model budget.
- Use `capabilities`, HTTP `GET /api/capabilities`, or MCP `nado_capabilities` when a client needs a machine-readable manifest of supported endpoints, features, workers, and sessions.
- Use `demo health`, HTTP `POST /api/demo/health`, or MCP `nado_demo_health` when you need a compact operator answer for the live demo: Dashboard URL, workers, IPv4/IPv6/network hints, GPU/docs/PPT dry-run routing, end-to-end verification, and cleanup of completed diagnostic tasks.
- In the Dashboard Control Console, use Check Routes when the user asks "can this route?" or wants a no-history demo of automatic GPU/docs/PPT routing; use Stop Task to cancel the current console task instead of merely disconnecting the event stream.
- Use `demo reset --dry-run` before `demo reset --yes` when completed standalone demo tasks or empty console sessions clutter the dashboard; it removes empty sessions with no tasks/workspace, preserves sessions that contain work plus batch records, and `--keep N` retains the latest N standalone terminal tasks.
- In the Dashboard Workbench, use Reset Demo for the same operator cleanup path: it clears completed standalone demo tasks, empty sessions, and completed diagnostic history while preserving sessions and batches that contain work.
- Use `verify`, HTTP `POST /api/verify`, or MCP `nado_verify` when you need one end-to-end readiness answer covering health, manifest, context, MCP config, doctor self-test, task artifact download, task events, and batch ZIP download.
- Use `history prune-system --dry-run` or MCP `nado_prune_system_history` after repeated verify/doctor runs when diagnostic history starts burying user work; it preserves user tasks, user batches, and sessions.
- Use `mcp config --format json` to connect this gateway to any MCP client that accepts a stdio `mcpServers` config.
- Use sessions for multi-step subprojects so one worker keeps the same workspace and context across tasks.
- Use `batch plan`, MCP `nado_plan_batch`, HTTP `POST /api/batches/plan`, or Dashboard Plan Batch to draft ordinary batch JSON from short subtask lines before submitting parallel work.
- Use `dispatch plan`, MCP `nado_plan_dispatch`, HTTP `POST /api/dispatch/plan`, or Dashboard Preview Dispatch to see worker assignment, candidate scores, capacity conflicts, and `nextAction` hints before creating tasks.
- Use `--require-routable` or submission field `requireRoutable: true` when task or batch creation should fail fast if no online worker matches static routing constraints; rejection errors include `nextAction=<code>` and HTTP/MCP callers can inspect the attached dispatch plan.
- In the Dashboard, `requireRoutable` task or batch submission errors render the attached dispatch plan so the operator can see routability, inferred/effective capabilities, candidate workers, and next actions without creating stuck tasks.
- Use `submit --wait --download --out <dir>` when you want a single CLI handoff for one task that returns only after terminal status and artifact recovery; add `--watch` to stream task events while waiting.
- If `submit --wait` or `wait` times out, read the printed scheduler diagnostics before retrying; queued timeouts include effective capabilities, candidate rejection reasons, the latest event, and a suggested next action.
- Use MCP `nado_run_task` when a control-side agent wants one task handoff call that waits for terminal status and returns artifact content. `nado_submit_task` and `nado_run_task` include a top-level `routing` summary with `selectedWorkerId`, `targetWorkerId`, `targetEligible`, `routeStatus`, `nextAction`, scheduler reason, inferred capabilities, inference evidence, selected-worker warnings, and rejected candidates. Treat `selectedWorkerId=null` plus `targetEligible=false` as a routing issue even when `requestedWorkerId` is set.
- If a MCP tool returns `isError: true`, parse its JSON text content; gateway rejections include `status`, `nextActions`, and `dispatchPlan` so you can recover without scraping the error string.
- Use MCP `nado_get_task_artifacts` when you already have a task ID and need all stored outputs as base64 content in one response.
- Use batches for independent subtasks that can run in parallel, or dependency-ordered subtasks that should unblock after parents succeed.
- In batch JSON, set `dependencyArtifacts: true` on a dependent child when it should read parent artifacts from `.nado/dependencies/<parent-key>/`.
- In CLI batch JSON, use child task `file`/`files` or `dir`/`dirs` when each shard needs different control-side material.
- Use `batch manage --action retry_failed` after a batch finishes with errors so successful child tasks are not rerun.
- Use `batch manage --action cancel` to stop all remaining queued, blocked, and running work in a batch.
- Use `batch events --watch` to monitor multi-worker batch progress as one timeline.
- Use HTTP `GET /api/tasks/<task-id>/events/stream` and `GET /api/batches/<batch-id>/events/stream` when a custom client or Dashboard view needs live Server-Sent Event supervision without polling.
- Use `batch report` after waiting to see child statuses, blockers, output excerpts, and artifact paths in one place.
- Use `batch download` to recover all child task artifacts into one output tree.
- Use `batch submit --wait --report --download --out <dir>` when you want a single CLI handoff that returns only after terminal status, consolidated reporting, and artifact recovery.
- Use HTTP `GET /api/batches/<batch-id>/artifacts/download` or `GET /api/sessions/<session-id>/artifacts/download` for direct ZIP snapshots of grouped remote outputs.
- Use MCP `nado_run_batch` when a control-side agent wants one multi-task handoff call that waits for terminal aggregate status and returns the report plus grouped artifact content. `nado_submit_batch` and `nado_run_batch` include `routing[]` summaries for every child task; `nado_run_batch` also includes `finalRouting[]`.
- Use MCP `nado_wait_batch`, `nado_batch_report`, `nado_get_batch_artifacts`, `nado_list_batch_events`, and `nado_list_batch_artifacts` when supervising batch work from a control-side agent.
- Use MCP `nado_list_session_artifacts` and `nado_get_session_artifacts` to retrieve the latest outputs from a multi-step session.
- Use `wait <task-id> --watch` or MCP `nado_list_task_events` when you need to supervise a remote task until it finishes.
- Use `--file`, `--dir`, or MCP `inputFiles` when the worker needs control-side source material.
- Use HTTP `GET /api/tasks/<task-id>/artifacts/<artifact-id>/download` for direct raw artifact bytes when a custom client does not want base64 JSON.
- Use task management to cancel stuck work or requeue failed work to a healthier worker.
- Use `task manage --action reschedule` when a queued task was bound to a worker that later became paused, draining, or offline.
- Use `recover --action list|requeue` or MCP `nado_recover_offline_tasks` when tasks are stranded as running on offline workers.
- Shell tasks run in per-task workspaces on workers.
- For cleanup-oriented workers, non-session task workspaces may be deleted after artifact upload; check `workspaceCleaned` on the task detail.
- Agent tasks require the target worker to have been started with `--agent <preset>` or `--agent-command <template>`; use `agents` or MCP `nado_list_agent_presets` to inspect available presets.
- Use `worker manage --action pause|resume|drain|shutdown|cancel_current|forget` for supervision, intervention, and removing retired worker records after shutdown/offline/drain.
<!-- nado-agent-context:end -->
