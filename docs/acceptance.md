# MVP Acceptance Checklist

Each item has an observable check that should pass before the MVP is considered usable.

## A1: Project Design Exists

Acceptance:

- `docs/design.md` explains architecture, components, task types, security model, and future path.
- `docs/acceptance.md` breaks the MVP into testable work items.

## A2: Control Server Starts

Acceptance:

- `NADO_TOKEN=dev-token node ./src/cli.js control start --port 8765` starts an HTTP server.
- `GET /health` returns JSON with `ok: true`.

## A3: Worker Registers and Heartbeats

Acceptance:

- `node ./src/cli.js worker start --control http://127.0.0.1:8765 --id worker-a --capability code` registers the worker.
- `node ./src/cli.js workers --control http://127.0.0.1:8765` shows `worker-a`, its capabilities, and recent last-seen time.

## A4: Explicit Worker Dispatch Works

Acceptance:

- Submitting a shell task with `--worker worker-a` causes only `worker-a` to claim it.
- The task reaches `succeeded` when the shell command exits with code 0.
- The task detail shows stdout/stderr and event history.

## A5: Capability Routing Works

Acceptance:

- Starting two workers with different capabilities lets a task with `--capability gpu` be claimed by a GPU-capable worker.
- Submitting a task whose title, command, or prompt contains high-confidence capability wording such as CUDA/NVIDIA/VRAM/显存, README/documentation/文档, or PPT/PowerPoint/幻灯片/演示文稿 is routed to a matching GPU/docs/PPT-capable worker even when `--capability` is not provided.
- The recorded scheduler decision includes `inferenceReasons` with the inferred capability, matching rule, and evidence snippet so the Dashboard, CLI, and agents can explain why automatic routing was selected.
- If no compatible worker exists, the task remains queued.

## A6: Worker Task Workspace Exists

Acceptance:

- Each task runs under `.nado/workers/<worker-id>/tasks/<task-id>`.
- Files created by the command are visible there after task completion.

## A7: Agent Task Hook Exists

Acceptance:

- `node ./src/cli.js agents` lists reusable worker agent presets.
- A worker started with `--agent-command` can run a task with `--type agent --prompt`.
- A worker started with `--agent codex`, `--agent claude`, or another built-in preset resolves to the corresponding normal agent command template.
- `{promptFile}`, `{prompt}`, and `{workspace}` placeholders are substituted.
- A worker without `--agent` or `--agent-command` fails agent tasks with a clear error.

## A8: Control-Side Agent Awareness Exists

Acceptance:

- `node ./src/cli.js context --control http://127.0.0.1:8765 --out ./.nado/AGENTS.md` writes a context file.
- `node ./src/cli.js context install --control http://127.0.0.1:8765 --out ./AGENTS.md` installs the same generated context into a project agent file.
- Re-running `context install` updates only the marked generated block and preserves user-authored `AGENTS.md` content outside that block.
- The context file lists workers, capabilities, and example dispatch commands.
- `GET /api/context` returns the same authenticated generated context as Markdown for Dashboard and HTTP clients.
- `GET /api/capabilities` returns an authenticated machine-readable manifest of supported surfaces, MCP tools, endpoints, features, workers, and sessions.
- The capabilities manifest includes `networking` details for bracketed IPv6 control URLs and `NADO_PUBLIC_CONTROL_URL`, plus a `routingPolicy` section with explicit-worker, session-affinity, constraints, and automatic GPU/docs/PPT inference rules.
- The capabilities manifest and demo health output include worker resource diagnostics that distinguish probe-detected GPU workers from workers that only advertise `gpu` manually.
- The capabilities manifest, status snapshots, generated agent context, CLI demo health output, and Dashboard worker detail include agent readiness diagnostics that distinguish real terminal agents, custom commands, demo echo agents, missing tools, failed self-tests, and shell-only workers.
- MCP exposes `nado_capabilities` so control-side agents can inspect the same machine-readable gateway manifest without leaving the MCP surface.
- `GET /api/network` returns authenticated control URL diagnostics, including whether the current browser URL is loopback, candidate LAN/IPv6 URLs for remote worker onboarding, configured `NADO_PUBLIC_CONTROL_URL`, and warnings for likely container-internal Docker bridge addresses.
- `control start --public-control-url URL` advertises a browser/remote-worker reachable URL through capabilities, context, MCP config, network diagnostics, and default worker bundle URLs without changing the internal listener URL used by server-side checks.
- The Docker demo exposes the control port through `NADO_DOCKER_HOST_IP` plus `NADO_DOCKER_PORT`, so IPv6 host publishing can be enabled without changing the stable worker/control HTTP contract.
- `demo health` prints one operator-oriented health summary with Dashboard URL, worker inventory, network diagnostics, automatic route checks for advertised GPU/docs/PPT capabilities, optional end-to-end verification, and completed diagnostic history cleanup.
- MCP exposes `nado_demo_health` so a control-side agent can get the same live demo summary without shelling out or using the Dashboard.
- `node ./src/cli.js capabilities --control http://127.0.0.1:8765` prints the same manifest for custom control-side agents and scripts.
- `node ./src/cli.js mcp config --control http://127.0.0.1:8765 --format json` prints a reusable stdio `mcpServers` client config.
- `node ./src/cli.js mcp config --format command` prints the raw MCP server launch command with `NADO_TOKEN`.
- `GET /api/mcp-config` and `GET /api/mcp-config?format=command` return the same authenticated MCP client config for Dashboard and HTTP clients.

## A9: Automated MVP Verification Exists

Acceptance:

- `npm test` runs an integration test that starts a control server and two local workers.
- The test submits explicit and capability-routed tasks.
- The test verifies completion and generated workspace files.

## A10: MVP Is The Long-Term Foundation

Acceptance:

- `docs/design.md` names the stable runtime, protocol, worker connectivity model, task schema, CLI interface, storage contract, and execution abstraction.
- The local demo uses the same control server, worker client, HTTP API, CLI-compatible task model, and task runner as normal operation.
- Tests cover behavior that must remain stable in later implementations: explicit routing, capability routing, queued tasks without matching workers, agent hooks, missing agent configuration, workspaces, and generated control-agent context.

## A11: Gateway Supervision Exists

Acceptance:

- Workers report `observedState`, `currentTaskId`, and `metrics` in heartbeat.
- Control computes `gatewayState` so a worker can be seen as `idle`, `running`, `paused`, `drained`, `shutdown_requested`, or `offline`.
- A long-running task remains visible as `running` with `currentTaskId` while the worker continues heartbeating.
- `node ./src/cli.js status --control http://127.0.0.1:8765` shows worker gateway state and task counts.

## A12: Gateway Management Exists

Acceptance:

- `worker manage --action pause` prevents the worker from claiming new tasks.
- `worker manage --action resume` lets the worker claim tasks again.
- `worker manage --action drain` prevents new tasks while allowing current work to finish.
- `worker manage --action shutdown` asks the worker to acknowledge the command and stop its polling loop.
- `worker manage --action cancel_current` cancels a running task and records `cancelled`.
- `worker manage --action rotate_token --wait` remains queued while work is running, then makes the live Worker rotate locally, verifies the new token is accepted and its predecessor is rejected, and returns only non-secret token record IDs and evidence.
- `worker manage --action forget` removes an offline, drained, or shutdown-requested retired worker from the gateway list, revokes worker tokens bound to that worker ID, and refuses to run while non-terminal tasks still target that worker.
- Management commands are queued by the control server and acknowledged by the worker through heartbeat.

## A13: MCP Tool Interface Exists

Acceptance:

- `node ./src/cli.js mcp --control http://127.0.0.1:8765` starts a stdio MCP server.
- MCP tools include `nado_list_workers`, `nado_worker_preflight`, `nado_list_worker_events`, `nado_submit_task`, `nado_get_task`, `nado_list_tasks`, `nado_manage_worker`, and `nado_wait_task`.
- Automated tests prove an MCP client can discover a worker, submit a task, wait for completion, and verify the workspace artifact.

## A14: Remote Artifacts Are Available On Control Side

Acceptance:

- Workers scan completed task workspaces and upload bounded-size files to the control server.
- Completed tasks include artifact metadata with path, size, and sha256.
- `node ./src/cli.js artifacts <task-id>` lists uploaded artifacts.
- `node ./src/cli.js artifact download <task-id> <artifact-id> --out ./downloads` downloads the file to the control side.
- `GET /api/tasks/<task-id>/artifacts/content` returns all stored task artifact content as base64 JSON for control-side agents and HTTP clients.
- `GET /api/tasks/<task-id>/artifacts/<artifact-id>/download` returns the stored bytes directly with authenticated `application/octet-stream` response headers.
- MCP tools include `nado_list_artifacts`, `nado_get_task_artifacts`, and `nado_get_artifact`.
- Automated tests verify artifact retrieval through HTTP client, CLI, and MCP.

## A15: Long-Lived Sessions Exist

Acceptance:

- `node ./src/cli.js session create --title <title>` creates an open session.
- `node ./src/cli.js submit --session <session-id>` queues a task into that session.
- The first claimed task assigns the session to a compatible worker.
- Later tasks in the same session run on the same worker.
- Session tasks share `.nado/workers/<worker-id>/sessions/<session-id>`.
- `node ./src/cli.js sessions` and `node ./src/cli.js session <session-id>` inspect session state.
- `node ./src/cli.js session close <session-id>` prevents new tasks from being queued into that session.
- `node ./src/cli.js session download <session-id> --out ./downloads` downloads the latest artifact snapshot for that session.
- `GET /api/sessions/<session-id>/artifacts` lists the latest stored artifact snapshot for a session.
- `GET /api/sessions/<session-id>/artifacts/content` returns that latest session artifact snapshot as grouped base64 content for Dashboard and HTTP clients.
- `GET /api/sessions/<session-id>/artifacts/download` returns that latest session artifact snapshot as an authenticated ZIP.
- MCP tools include `nado_create_session`, `nado_list_sessions`, `nado_get_session`, `nado_close_session`, `nado_list_session_artifacts`, and `nado_get_session_artifacts`.
- Automated tests verify shared workspace continuity and closed-session rejection.

## A16: Live Task Output Events Exist

Acceptance:

- Workers send stdout and stderr chunks to the control server while a task is still `running`.
- Task detail includes `stdout` and `stderr` events before the final task result is recorded.
- Output events carry stable IDs and increasing per-attempt sequence numbers. A lost success response is retried idempotently, and the Worker preserves order across transient failures.
- The live-event queue is bounded. Overflow, stale rejection, or one exhausted delivery budget short-circuits remaining queued chunks and attempts one durable `output_delivery_gap`; final bounded stdout/stderr remains available without falsely claiming a complete live transcript.
- `node ./src/cli.js events <task-id>` lists lifecycle and output events.
- HTTP clients can use `GET /api/tasks/<task-id>/events` to fetch task events without full task detail.
- MCP includes `nado_list_task_events` for control-side agents that need task event supervision without fetching full task detail.
- Automated tests verify stdout/stderr events are observable before task completion, replay after a lost response does not duplicate output, ordering survives a transient failure, queue growth is bounded, and delivery exhaustion creates one gap summary instead of multiplying retry windows by queued chunks.

## A17: Control-Side Inputs Can Be Sent To Workers

Acceptance:

- CLI task submission supports `--file <local-file>`.
- CLI task submission supports `--dir <local-directory>`.
- MCP `nado_submit_task` supports `inputFiles` with `path` and `contentBase64`.
- Worker materializes input files into the task workspace or session workspace before execution, preserving relative paths for directory uploads.
- Directory upload skips `.git`, `node_modules`, and `.nado`.
- The task can read input files and produce derived artifacts.
- Automated tests verify input file delivery through CLI and MCP, plus directory upload through CLI.

## A18: Artifacts Can Be Downloaded In Bulk

Acceptance:

- `node ./src/cli.js artifacts download <task-id> --out ./downloads` downloads all stored artifacts for a task.
- Nested artifact paths are recreated under the output directory.
- `GET /api/tasks/<task-id>/artifacts/download` returns all stored task artifacts as an authenticated ZIP.
- Dashboard task detail includes a single ZIP download action for all non-skipped task artifacts.
- Automated tests verify a generated project directory can be recovered to the control side.

## A19: Tasks Can Be Cancelled And Requeued

Acceptance:

- `node ./src/cli.js task manage <task-id> --action cancel` cancels a queued or running task.
- Cancelling a running task also sends a cancellation command to the active worker.
- `node ./src/cli.js task manage <task-id> --action requeue --worker <worker-id>` resets a failed/cancelled/offline-running task to queued state.
- Requeued tasks can be retargeted to another worker.
- `node ./src/cli.js task manage <task-id> --action reschedule` recomputes the scheduler decision for a queued task.
- MCP includes `nado_manage_task`.
- Automated tests verify running task cancellation and failed task requeue to another worker.

## A20: Agent Tasks Have Session Continuity

Acceptance:

- Session agent tasks write `.nado-session/transcript.md` in the session workspace.
- Later agent tasks in the same session receive prior transcript content in their prompt file.
- Transcript includes task prompt, stdout, stderr, exit code, and error summary.
- Transcript is uploaded as an artifact with completed session agent tasks.
- Automated tests verify a second agent turn can read evidence from the first turn through the augmented prompt.

## A21: Workers Report Inventory

Acceptance:

- Workers probe host/runtime information and common tools during registration/heartbeat.
- Inventory includes Node.js and attempts Git, GitHub CLI, Codex CLI, Claude CLI, NVIDIA GPU probes, and AMD/ROCm GPU probes.
- Worker capabilities merge manual capabilities with inferred capabilities such as `shell`, `git`, `agent`, `github`, and `gpu`.
- GPU diagnostics report whether the `gpu` capability came with an observed NVIDIA/AMD SMI probe or is advertised-only, and advertised-only GPU workers produce an operator warning in Demo Health.
- When a task requires GPU and multiple GPU workers are eligible, the scheduler prefers probe-detected GPU workers over advertised-only GPU workers while keeping advertised-only workers eligible as a fallback.
- Agent readiness diagnostics report whether a worker is a real Codex/Claude terminal agent, a custom command, a demo echo agent, missing its configured CLI tool, failed self-test, or shell-only.
- Agent-task scheduling prefers real Codex/Claude terminal-agent workers over demo echo agents and rejects Codex/Claude preset workers when the matching CLI is missing from inventory.
- Scheduler records include selected-worker warnings for routable but risky assignments such as advertised-only GPU workers or demo/custom agent workers without a successful self-test, and MCP routing summaries expose those warnings.
- `node ./src/cli.js workers` and `node ./src/cli.js status` expose available tools.
- Automated tests verify inventory and inferred capabilities are reported.

## A22: Control-Side Scheduler Exists

Acceptance:

- Tasks submitted without `--worker` are scheduled by the control server at creation time.
- The scheduler filters out offline, paused, draining, capability-incompatible, label-incompatible, and full workers.
- Eligible workers are scored using available capacity, idle/running state, explicit or inferred capabilities, matching labels, tool availability, configured terminal-agent command, and recent task failures.
- The selected worker is recorded as `requestedWorkerId`.
- The full scheduling explanation is recorded as `task.scheduler` and a `scheduled` event.
- HTTP clients can use `GET /api/tasks/<task-id>/schedule` to fetch the recorded scheduler decision.
- `node ./src/cli.js schedule <task-id> --control http://127.0.0.1:8765` prints the recorded scheduler decision.
- MCP includes `nado_explain_schedule`.
- Automated tests verify agent tasks prefer a worker with an agent command and paused workers are avoided.

## A23: CLI Can Wait For Task Completion

Acceptance:

- `node ./src/cli.js wait <task-id> --control http://127.0.0.1:8765` blocks until the task reaches `succeeded`, `failed`, or `cancelled`.
- `--watch` prints newly observed task events while waiting.
- The command prints final task status, assigned worker, and exit code.
- The command exits non-zero for failed or cancelled tasks.
- Automated tests verify the CLI wait command against a real control server and worker.

## A24: Workers Have Bounded Concurrency

Acceptance:

- `node ./src/cli.js worker start ... --max-concurrency <n>` registers a worker with more than one execution slot.
- Worker heartbeat reports `currentTaskIds` and `maxConcurrency`.
- Control state exposes `runningTasks`, `runningSlots`, `reservedSlots`, `availableSlots`, and `maxConcurrency` for each worker.
- A worker can claim and run independent tasks concurrently up to `maxConcurrency`.
- Task submission accepts `slots`; omitted slots default to `1`.
- Scheduler and worker claim use task slot cost rather than task count when deciding capacity.
- Additional tasks for a saturated worker remain queued until a slot opens.
- The scheduler treats running plus already reserved queued work as load and avoids workers at full capacity.
- Tasks in the same session remain serialized even when their worker has spare slots.
- Automated tests verify two tasks running concurrently, a third task waiting for capacity, and the worker returning to idle with all slots available.

## A25: Offline Running Tasks Can Be Recovered

Acceptance:

- Control can list tasks that remain `running` on workers whose heartbeat is stale.
- `node ./src/cli.js recover --action list --control http://127.0.0.1:8765` displays stranded running tasks.
- `node ./src/cli.js recover --action requeue --worker <offline-worker> --target-worker <worker-id>` clears stale runtime state and requeues tasks to another worker.
- Recovered tasks record an `offline_recovered` event and can then be claimed and completed by the target worker.
- Requeueing a recovered task does not refresh the offline worker's `lastSeenAt` or incorrectly make it appear online.
- If the original offline worker later reports stale output or a stale result for its old claim, the gateway ignores it and preserves the recovered task attempt.
- MCP includes `nado_recover_offline_tasks`.
- Session tasks are skipped by default because their shared workspace may be unavailable on another worker.
- `NADO_AUTO_RECOVER_OFFLINE_MS=120000` or `control start --auto-recover-offline-ms 120000` automatically requeues eligible non-session tasks only after the configured grace period.
- Status and capabilities responses expose the effective automatic-recovery policy and its at-least-once delivery semantics.
- Workers increase reconnect delay exponentially with jitter after repeated control-plane failures and reset the delay after a successful heartbeat.
- Workers distinguish local execution failure from completion-delivery failure. A transient completion transport failure retains the Worker slot and current-attempt lease, then retries with bounded exponential backoff; authorization and other permanent HTTP errors are not retried.
- If the control server is stopped after a task starts and restarted on the same SQLite data directory before the attempt lease expires, the task result is delivered without executing the command a second time. Worker events include `task_completion_retry` and `task_completion_recovered`.
- A lost response after a committed completion is idempotent: retrying the same attempt is accepted from the stored attempt history. Expired/stale attempts produce `task_completion_rejected` and cannot overwrite newer work.
- Automated tests verify offline task discovery, requeue to a healthy worker, successful completion, stale result/event rejection, the lost worker staying offline, transient/permanent completion error classification, and SQLite control restart during result delivery.

## A26: Batch Task Dispatch Exists

Acceptance:

- Control supports a durable `Batch` record with `id`, `title`, `taskIds`, events, and derived aggregate status.
- Batch-created tasks are ordinary tasks with `batchId`.
- `node ./src/cli.js batch plan --title TITLE --task "key: subtask" --out ./batch.json` creates submit-ready batch JSON from short subtask lines.
- `POST /api/batches/plan` and HTTP client `planBatch()` expose the same planner for Dashboard and custom control clients.
- Dashboard includes a Plan Batch form that fills the editable Submit Batch JSON textarea before submission.
- `node ./src/cli.js batch submit --file ./batch.json --control http://127.0.0.1:8765` creates multiple child tasks from one JSON file.
- `node ./src/cli.js batches` lists aggregate batch status and completion counts.
- `node ./src/cli.js batch <batch-id>` returns batch details and child tasks.
- `node ./src/cli.js batch wait <batch-id>` waits until every child task is terminal.
- MCP includes `nado_plan_batch`, `nado_submit_batch`, `nado_list_batches`, and `nado_get_batch`.
- Batch tasks use the normal scheduler, capacity model, artifact model, events, and recovery paths.
- Automated tests verify planned and hand-authored batches can be submitted, distributed across workers by capacity, and reach aggregate `succeeded`.

## A27: Batch Failed Tasks Can Be Retried

Acceptance:

- `node ./src/cli.js batch manage <batch-id> --action retry_failed` requeues only failed or cancelled child tasks.
- Succeeded child tasks are skipped and keep their original runtime/result data.
- Retried child tasks remain in the same batch and keep their `batchId`.
- Retried child tasks use the normal scheduler/capacity model unless a target `--worker` is provided.
- Batch aggregate status moves out of `completed_with_errors` while retries are queued/running and can later become `succeeded`.
- MCP includes `nado_manage_batch`.
- Automated tests verify a failed child task is retried, a successful sibling is not rerun, and the batch reaches aggregate `succeeded`.

## A28: Batch Dependencies Gate Child Tasks

Acceptance:

- Batch task specs can include a unique `key` and a `dependsOn` list of other task keys.
- Batch submission rejects unknown dependency keys and dependency cycles.
- Dependent child tasks are created with status `blocked` and are not claimed by workers while parents are unfinished.
- When all dependencies succeed, blocked children automatically become queued and use the normal scheduler/capacity/claim path.
- If a dependency fails or is cancelled, downstream children remain blocked with a visible `blockedReason`, and the batch can aggregate as `completed_with_errors`.
- `retry_failed` can retry a failed parent; downstream children stay blocked while the parent is queued/running and unblock automatically if the retry succeeds.
- MCP `nado_submit_batch` exposes `key` and `dependsOn`.
- Automated tests verify success chains, failed dependency retry, unknown dependency rejection, and cycle rejection.

## A29: Worker Invite Scripts Are Generated

Acceptance:

- `node ./src/cli.js worker invite --control <url> --id <worker-id>` prints a reusable worker start script.
- `node ./src/cli.js worker invite --control <url> --id <worker-id> --issue-token` asks the live control server to create a worker-specific token and embeds that token in the script instead of the shared admin token.
- The invite script carries the control URL, token, worker ID, capabilities, labels, agent preset or custom agent command, poll interval, and concurrency settings.
- The invite script runs `worker preflight` before `worker start` so Node.js, repository path, data directory access, control health, and token binding are checked before the long-running worker process starts.
- When `--issue-token` is used, the invite script carries the issued worker token, not the shared admin token.
- Bash is the default output for Ubuntu/WSL workers; PowerShell output is available with `--format powershell`.
- The generated command still uses the normal `worker start` path, so onboarding does not introduce a separate worker runtime.
- MCP includes `nado_list_agent_presets` and `nado_create_worker_invite` for control-side agents, including worker-token invite issuance and agent preset selection.
- Automated tests verify generated scripts include the expected token, control URL, worker ID, capabilities, labels, agent preset/custom command, capacity settings, and dedicated worker-token invite path.

## A29.1: Worker Preflight Verifies Remote Host Readiness

Acceptance:

- CLI exposes `nado worker preflight --control URL --id WORKER_ID`.
- Worker preflight checks local Node.js version, the local CLI entrypoint, data-directory access, control-server health, and authenticated token validity for the requested worker ID.
- HTTP exposes `GET /api/workers/<worker-id>/preflight`, accepting either the admin token or a worker token bound to that worker ID.
- Worker tokens cannot preflight a different worker ID.
- MCP exposes `nado_worker_preflight` for control-side agents.
- Capabilities manifest advertises worker preflight support and endpoint.
- Automated tests verify admin-token preflight, worker-token preflight before worker registration, invite-script preflight wiring, and manifest discovery.

## A29.1a: Worker Can Prove Local Host Readiness Without Control Reachability

Acceptance:

- CLI exposes `nado worker inspect` and does not require a Control URL or token.
- Inspection verifies Node.js 20+, writable/readable Worker data storage, configured and inferred capabilities, required executables, CPU, RAM, GPU count/model/VRAM, a real vendor GPU probe, configured Codex/Claude CLI readiness, and an optional enrolled identity.
- `--require-gpu`, `--require-agent`, `--require-identity`, `--require-capability`, `--tool`, and resource flags turn deployment expectations into fail-closed gates; unmet requirements return process exit code `2` with actionable remediation.
- Identity inspection validates that the locally stored public and private keys are a matching Ed25519 pair and that a Worker ID plus scoped credential are present. Reports never include the token or private key.
- `--json` produces structured stdout and `--out` writes a new private report suitable for attaching to deployment evidence without overwriting an existing file.
- Offline inspection is explicitly not accepted as proof of WAN transport, control reachability, token validity, Agent authentication, physical separation, or no-inbound-firewall policy; online preflight, Agent self-test, and the real cross-site evidence workflow remain required.
- Automated tests cover a strict AMD MI300/Codex/signed-identity pass, missing GPU/Agent/identity and unwritable-data failure paths, secret omission, CLI JSON output, and exit code `2`.
- `worker bootstrap-start --strict-local-readiness` runs the host gate before enrollment and returns before consuming the enrollment credential on failure. A declared `gpu` capability requires a vendor-probed device with VRAM; Codex/Claude presets require their matching executable.
- After signed online preflight and any credential recovery, strict bootstrap rechecks the persisted Worker ID/scoped token and matching Ed25519 keypair before starting the long-running Worker.

## A29.1.1: Portable Worker Bundles Can Onboard Hosts Without A Preexisting Checkout

Acceptance:

- CLI exposes `nado worker bootstrap-bundle --control URL --out ./nado-worker-bootstrap.zip` as the preferred self-service onboarding path.
- Bootstrap bundles start with `worker bootstrap-start`; the remote worker generates a local keypair, sends its public key to `POST /api/workers/enroll`, receives a worker-scoped token, stores its assigned worker ID locally, and then starts the normal worker runtime with signed worker requests.
- CLI, HTTP, Dashboard, and MCP bootstrap-bundle flows carry `strictLocalReadiness`; Dashboard self-service onboarding enables it by default and the bundle manifest records the policy.
- Fixed-ID and self-service portable bundles include syntax-checked systemd, Windows scheduled-task, and macOS LaunchAgent installers plus matching uninstallers. They wrap the existing start script, preserve the non-root/current-user Agent environment, restart failures, wait for network/user logon as appropriate, and retain `.nado` identity/data when removed. The macOS installer validates its plist, uses a failure-only current-user job, and refuses root instead of installing a privileged LaunchDaemon.
- A corrupt, missing, non-Ed25519, or mismatched stored keypair is not considered reusable. With a fresh enrollment credential, bootstrap generates and registers a new matching pair for the same Worker ID before preflight.
- Signed worker requests include method, path, body hash, timestamp, nonce, and worker ID. The control server rejects replayed nonces within the timestamp window and does not consume a nonce when a tampered body fails hash verification.
- HTTP exposes authenticated `POST /api/workers/bootstrap-bundle`, `POST /api/workers/enroll`, and `GET|POST /api/worker-enrollment-tokens`.
- MCP exposes `nado_create_worker_bootstrap_bundle` so control-side agents can generate onboarding bundles without first asking the user for a worker ID.
- CLI exposes `nado worker bundle --control URL --id WORKER_ID --out ./nado-worker.zip`.
- HTTP exposes authenticated `POST /api/workers/bundle` for custom clients and Dashboard downloads.
- Worker bundles include the real `src/cli.js` worker runtime, `package.json`, docs/context files, a bundle manifest, `start-worker.sh`, and `start-worker.ps1`.
- Bundle start scripts run the same `worker preflight` and `worker start` commands as generated invite scripts.
- `--issue-token` creates and embeds a worker-specific token instead of the shared admin token.
- MCP exposes `nado_create_worker_bundle`, optionally returning base64 zip content for control-side agents.
- Capabilities manifest advertises worker bundle support, self-service enrollment support, signed worker requests, signed-request replay protection, HTTP bundle/enroll endpoints, and CLI examples.
- Dashboard can run an agent-style Control Console task with automatic event streaming, preview the selected worker and scheduler reasons before running a Control Console task, create or clear a long-lived session directly from the Control Console, download a self-service worker bootstrap bundle directly, show loopback warnings plus clickable LAN/IPv6 Control URL candidates for remote workers, auto-fills a generated worker ID for fixed-ID invite flows, and can still download a portable fixed-ID worker bundle for the last issued invite without issuing a duplicate token.
- Automated tests verify CLI bootstrap bundle contents, self-service enrollment, HTTP bundle downloads, Dashboard wiring, and MCP bundle metadata generation.

## A29.2: Worker Runtime Events Are Durable And Remotely Inspectable

Acceptance:

- Workers report durable runtime events to the control gateway after registration, task claims, task completion/failure, worker errors, and management command handling.
- The control store also records gateway-observed worker events such as registration, task claim, task completion, queued management commands, and command acknowledgements.
- HTTP exposes `GET /api/workers/<worker-id>/events?tail=N` for admin tokens and worker tokens bound to that worker ID.
- HTTP exposes `POST /api/workers/<worker-id>/events` for worker-side runtime event reporting.
- CLI exposes `nado worker logs --control URL --id WORKER_ID --tail N` and `--watch`.
- MCP exposes `nado_list_worker_events` for control-side agents.
- Capabilities manifest advertises worker event support and endpoint.
- Automated tests verify HTTP client retrieval, CLI log output, MCP tool discovery, and task-related worker events.

## A30: Worker Labels Can Route Tasks

Acceptance:

- Workers can register operator labels such as `zone=lab` or `role=builder`.
- `node ./src/cli.js workers` and `node ./src/cli.js status` show worker labels.
- Task submission supports `--required-label key=value`, persisted as `requiredLabels`.
- Sessions can also declare label requirements; tasks in that session inherit those requirements unless they provide their own.
- The scheduler filters out workers missing required labels and records `missing required labels` in the scheduler candidates.
- Worker claim checks label requirements again before accepting a queued task.
- MCP `nado_submit_task`, `nado_submit_batch`, `nado_create_session`, `nado_manage_task`, `nado_manage_batch`, and `nado_recover_offline_tasks` support label requirements.
- Automated tests verify API scheduling, CLI submission, and MCP submission with label routing.

## A31: Queued Tasks Support Priority

Acceptance:

- Task submission supports a numeric `priority`; omitted priority defaults to `0`.
- `node ./src/cli.js submit ... --priority 10` persists the task priority and prints it.
- MCP `nado_submit_task` and `nado_submit_batch` accept `priority`.
- Workers claim the highest-priority compatible queued task first.
- Tasks with equal priority keep FIFO ordering.
- Batch tasks remain ordinary tasks and can carry priority without a separate execution path.
- Automated tests verify a later high-priority task is claimed before an older low-priority task.

## A32: Batches Can Be Cancelled

Acceptance:

- `node ./src/cli.js batch manage <batch-id> --action cancel` cancels every non-terminal child task in the batch.
- Queued and blocked child tasks become `cancelled` immediately.
- Running child tasks become `cancelled` and receive the same worker `cancel_current` command path used by task-level cancellation.
- Terminal child tasks are skipped and reported with their status.
- Batch aggregate status becomes `completed_with_errors` when cancellation leaves cancelled child tasks.
- MCP `nado_manage_batch` supports `action: cancel`.
- Automated tests verify cancelling running, queued, and blocked child tasks in one batch.

## A33: Batch Artifacts Can Be Downloaded In Bulk

Acceptance:

- `node ./src/cli.js batch download <batch-id> --out ./downloads` downloads artifacts for every child task in the batch.
- Each child task's artifacts are written below `--out/<batch-key-or-task-id>/`.
- Same-named artifacts from different child tasks do not overwrite each other.
- Skipped artifacts are ignored; a clear error is returned if no child has downloadable artifacts.
- The command uses the existing task artifact API and does not introduce a separate artifact storage path.
- Automated tests verify a two-child batch can be downloaded into per-child directories.

## A34: MCP Can Supervise Batch Completion And Outputs

Acceptance:

- MCP includes `nado_wait_batch` to wait until a batch reaches `succeeded` or `completed_with_errors`.
- `nado_wait_batch` returns the same batch and child task shape as `nado_get_batch`.
- MCP includes `nado_list_batch_artifacts` to list collected artifact metadata grouped by child task.
- MCP includes `nado_get_batch_artifacts` to fetch all stored batch artifacts as grouped base64 content.
- HTTP clients can use `GET /api/batches/<batch-id>/artifacts` and `GET /api/batches/<batch-id>/artifacts/content` for the same grouped metadata and content.
- HTTP clients can use `GET /api/batches/<batch-id>/artifacts/download` to download all stored child artifacts as an authenticated ZIP.
- Batch artifact APIs use the existing per-task artifact storage path and do not introduce duplicate artifact storage.
- Skipped artifacts are omitted by default and can be included with `includeSkipped`.
- Automated tests verify an MCP client can submit a batch, wait for completion, list artifacts from all child tasks, and fetch artifact content.

## A35: Batch Events Can Be Inspected As One Timeline

Acceptance:

- `node ./src/cli.js batch events <batch-id>` prints a merged timeline of batch events and child task events.
- The timeline identifies whether each event came from the batch record or a child task.
- Child task events include the task's `batchKey` when present, falling back to the task ID.
- `node ./src/cli.js batch events <batch-id> --watch` streams newly observed events until the batch is terminal.
- HTTP clients can use `GET /api/batches/<batch-id>/events` for the same merged timeline shape.
- MCP includes `nado_list_batch_events` with the same merged timeline shape.
- Automated tests verify completed batch event output includes child task keys and success events.

## A36: Batch Child Tasks Can Attach Control-Side Inputs

Acceptance:

- CLI batch JSON child tasks can declare `file`, `files`, `dir`, or `dirs`.
- Paths are resolved relative to the batch JSON file.
- The CLI expands those paths into the same `inputFiles` payload used by normal task submission.
- Existing explicit `inputFiles` on the child task are preserved and merged with locally collected files.
- Directory inputs skip `.git`, `node_modules`, and `.nado` using the existing input collection rules.
- Automated tests verify batch child file and directory inputs are materialized on workers and reflected in downloaded artifacts.

## A37: Batch Reports Summarize Results For Operators And Agents

Acceptance:

- `node ./src/cli.js batch report <batch-id>` prints aggregate status, counts, artifact paths, problem tasks, blocked tasks, and output excerpts.
- `node ./src/cli.js batch report <batch-id> --json` returns the same report as structured JSON.
- HTTP clients can use `GET /api/batches/<batch-id>/report`.
- MCP includes `nado_batch_report` with the same report shape for control-side agents.
- Reports include suggested next actions for successful, running, blocked, and failed batches.
- Automated tests verify CLI and MCP reports include child task status, stdout excerpts, and artifact paths.

## A38: Batch Child Tasks Know Their Batch Context

Acceptance:

- Worker task processes receive `NADO_BATCH_ID` for batch children and an empty string for non-batch tasks.
- Worker task processes receive `NADO_BATCH_KEY` for keyed batch children.
- Worker task processes receive `NADO_BATCH_DEPENDS_ON` as a comma-separated dependency key list.
- Existing task environment variables remain available, including `NADO_TASK_ID`, immutable `NADO_ATTEMPT_ID`/`NADO_ATTEMPT_SEQ`, `NADO_SESSION_ID`, `NADO_WORKER_ID`, `NADO_WORKSPACE`, `NADO_AGENT_TRANSCRIPT`, and `NADO_HOSTNAME`.
- Automated tests verify batch child commands can read the batch key and batch ID environment variables.

## A39: Control Surfaces Expose One Gateway Status Snapshot

Acceptance:

- HTTP clients can use `GET /api/status` to retrieve worker, session, task, and batch aggregate counts plus current items, including a machine-readable `tasks.attention` summary for queued routing issues.
- The status snapshot omits bulky worker event arrays and instead includes worker `eventCount` and `lastEventAt`; clients use `GET /api/workers/<worker-id>/events` when they need the detailed timeline.
- `node ./src/cli.js status` uses the same status snapshot and prints worker, session, task, batch, and attention counts.
- MCP includes `nado_status` with the same snapshot shape for control-side agents, including `tasks.attention`.
- Automated tests verify the CLI, MCP tool, and HTTP client can retrieve the status snapshot.

## A40: Non-Session Workspaces Can Be Cleaned After Artifact Upload

Acceptance:

- `node ./src/cli.js worker start ... --cleanup-workspaces` makes the worker delete completed non-session task workspaces after artifacts are uploaded.
- `node ./src/cli.js submit ... --cleanup-workspace` requests cleanup for that task even if the worker does not default to cleanup.
- `node ./src/cli.js submit ... --keep-workspace` preserves that task workspace even on a cleanup-default worker.
- Session workspaces are not automatically cleaned by this policy because they carry multi-step state.
- Task results include `workspaceCleaned` so the control side knows whether the worker-local workspace remains.
- Stored artifacts remain downloadable after workspace cleanup.
- MCP `nado_submit_task` and `nado_submit_batch` accept `keepWorkspace`.
- Automated tests verify default cleanup, task-level keep override, task-level cleanup request, and artifact download after cleanup.

## A41: Batch Defaults Reduce Repeated Child Task Policy

Acceptance:

- Batch submission accepts a top-level `defaults` object.
- Defaults can provide shared `type`, `workerId`, `sessionId`, `capabilities`, `tools`, `labels`, `slots`, `priority`, `timeoutMs`, `maxOutputChars`, `keepWorkspace`, `artifactPolicy`, and `inputFiles`.
- Child tasks inherit defaults when they omit those fields.
- Child task values override default values; labels merge with child labels taking precedence on matching keys.
- CLI batch JSON, HTTP API, and MCP `nado_submit_batch` all use the same defaulting behavior.
- Automated tests verify inherited defaults, selected child overrides, label merging, CLI batch JSON defaults, and MCP batch defaults.

## A42: Tasks Can Receive Custom Environment Variables

Acceptance:

- Task submission accepts an `env` object through the HTTP API.
- `node ./src/cli.js submit ... --env KEY=value` sends custom task environment variables.
- MCP `nado_submit_task` accepts `env`.
- MCP `nado_submit_batch` accepts task-level `env` and `defaults.env`.
- Batch defaults merge `env` with child task values taking precedence.
- Worker processes receive custom env values in addition to reserved `NADO_*` values.
- Reserved `NADO_*` values are injected after custom env so custom env cannot spoof gateway task, batch, worker, session, workspace, transcript, or hostname variables.
- Automated tests verify task env injection, reserved env override protection, batch default env inheritance, child env override, CLI env submission, and MCP env schema/dispatch.

## A43: Tasks Can Control Artifact Collection

Acceptance:

- Task submission accepts `artifactPolicy.include` and `artifactPolicy.exclude` through the HTTP API.
- `node ./src/cli.js submit ... --artifact dist/** --exclude-artifact dist/tmp/**` sends the same artifact policy.
- MCP `nado_submit_task` accepts `artifactPolicy`.
- MCP `nado_submit_batch` accepts task-level `artifactPolicy` and `defaults.artifactPolicy`.
- Batch defaults merge artifact include and exclude lists with child task artifact policies.
- Workers collect only included artifacts and omit excluded paths while retaining built-in `.git` and `node_modules` skips.
- Automated tests verify single-task include/exclude behavior, batch default policy merging, CLI artifact policy submission, and MCP artifact policy schema/defaults.

## A44: Doctor Can Run End-to-End Worker Self-Test

Acceptance:

- `node ./src/cli.js doctor --control URL` reports control health and worker health.
- `node ./src/cli.js doctor --control URL --self-test` submits a real shell probe task through the gateway.
- `node ./src/cli.js doctor --control URL --self-test --all-workers` submits one probe task for every eligible active worker.
- The self-test verifies that an eligible worker can claim the task, execute it, and return `doctor.txt` as an artifact.
- Self-test routing supports `--worker`, `--capability`, `--tool`, and `--required-label` filters.
- MCP includes `nado_doctor` with the same optional self-test behavior.
- Doctor returns a non-zero CLI exit code when health checks fail, no eligible self-test worker exists, the probe task fails/times out, or the probe artifact is missing.
- Automated tests verify CLI self-test output and MCP self-test dispatch.

## A45: Tasks Can Require Specific Worker Tools

Acceptance:

- Task submission accepts `requiredTools` through the HTTP API.
- `tools` is accepted as an alias for `requiredTools` in batch JSON and MCP task inputs.
- Tool names are normalized, including `github`/`github-cli` to `gh`, `nvidia-smi` to `nvidiaSmi`, and `amd-smi`/`amdsmi` to `amdSmi`.
- The scheduler filters out workers whose inventory does not report every required tool as available.
- Explicit worker tasks still honor required tools when a worker attempts to claim them.
- Sessions can carry required tools, and child tasks inherit them when the child omits tools.
- Batch defaults merge required tools with child task tools.
- CLI supports `--tool`/`--required-tool` on submit, session create, task manage, batch retry, recover, and doctor self-test commands.
- MCP supports `tools` on task submit, session create, batch submit/defaults, task management, batch management, recovery, and doctor.
- Automated tests verify scheduler filtering, alias normalization, explicit-worker claim blocking, batch default merging, CLI submission, and MCP schema/dispatch.

## A46: Batch Children Can Consume Dependency Artifacts

Acceptance:

- Batch child task specs accept `dependencyArtifacts`.
- `dependencyArtifacts: true` injects stored artifacts from direct successful dependencies into the child workspace under `.nado/dependencies/<dependency-key>/`.
- Object form supports `prefix`, `include`, and `exclude`.
- Injected dependency artifacts are materialized through the same worker input file path as control-side files.
- Injected dependency artifacts are not re-uploaded as new output artifacts from the child task.
- MCP batch task/default schemas expose `dependencyArtifacts`.
- Automated tests verify a dependent child reads a parent artifact after unblocking and produces a derived output.

## A47: Tasks Can Reserve Multiple Worker Slots

Acceptance:

- Task submission accepts `slots` through HTTP, CLI, batch JSON, and MCP.
- Omitted `slots` defaults to `1`; fractional and invalid values are normalized upward to a positive integer.
- Batch defaults can provide shared `slots`.
- Scheduler rejects workers whose remaining capacity is less than the task's slot cost.
- Worker claim rejects queued tasks whose slot cost no longer fits current running load.
- Worker detail exposes `runningSlots`, `reservedSlots`, `availableSlots`, and `maxConcurrency`.
- Automated tests verify a two-slot task on a two-slot worker prevents a second task from running until it finishes, while existing one-slot concurrency still works.

## A48: Worker Tokens Are Scoped And Revocable

Acceptance:

- The control server can create a durable worker-specific token bound to one `workerId`.
- Worker token records are stored as hashes; listing tokens returns redacted metadata and a preview, not the raw token.
- `node ./src/cli.js worker token create --control <url> --id <worker-id>` prints the raw token once for manual onboarding.
- `node ./src/cli.js worker tokens --control <url>` lists issued token metadata.
- `node ./src/cli.js worker token revoke <token-id> --control <url>` revokes a token.
- A worker token can register and heartbeat only as its bound worker ID.
- A worker token can claim tasks only for its bound worker and can report events/results only for tasks assigned to that worker.
- A self-service worker token with a registered public key must sign worker-path requests, cannot replay the same signed request nonce, and can retry the original signed request after a tampered-body attempt is rejected before nonce consumption.
- A worker token cannot call admin/control APIs such as listing workers, submitting tasks, managing workers, downloading artifacts, or creating/revoking tokens.
- Revoked worker tokens are rejected on subsequent worker API calls.
- MCP includes `nado_list_worker_tokens` and `nado_revoke_worker_token`; `nado_create_worker_invite` can issue a worker-token invite.
- Automated tests verify scoped worker registration, successful task execution through a worker token, forbidden admin API access, forbidden cross-worker registration, invite-issued tokens, redacted listing, and revocation.

## A49: Control Server Serves A Browser Dashboard

Acceptance:

- `GET /` and `GET /dashboard` return a browser dashboard from the control server without requiring a separate frontend server or build step.
- The dashboard accepts an admin `NADO_TOKEN` in the browser and sends it as a bearer token to the existing HTTP API.
- The dashboard shows one refreshed gateway status snapshot with workers, tasks, batches, sessions, slot usage, capabilities, labels, and tools.
- The dashboard can inspect worker detail through the existing worker detail API, including inventory, metrics, slots, current tasks, and recent tasks, and can reuse a worker ID in routing forms.
- The dashboard can preview and download the current generated control-agent `AGENTS.md` context through the authenticated context API.
- The dashboard can preview and download JSON or command-form MCP client config through the authenticated MCP config API.
- The dashboard can issue a worker-specific token and generate a bash or PowerShell invite script that uses the normal `worker start` path.
- The dashboard can download the generated invite script and can prefill/run a worker-specific doctor self-test for the invited worker.
- The dashboard can list and revoke worker-specific tokens through the existing worker-token APIs.
- The dashboard can run doctor checks and optional self-test probes through the existing doctor logic exposed by the authenticated HTTP API.
- The dashboard can run readiness verification through the existing authenticated verify API and link to generated probe task and batch detail.
- The dashboard can submit shell or terminal-agent tasks through the existing `POST /api/tasks` API.
- The dashboard control console previews small text artifacts from completed tasks inline through the existing task artifact content API, while retaining ZIP download for full output.
- The dashboard can require task and batch submissions to be statically routable before they are created.
- Dashboard task submission can send custom env values, browser-selected input files, artifact include/exclude policy, timeout, and keep/cleanup workspace settings through the same task API fields used by CLI and MCP.
- The dashboard can inspect a task's recorded scheduler decision and scored candidates from task detail.
- The dashboard can cancel, requeue, and reschedule tasks through the existing `POST /api/tasks/<task-id>/manage` API.
- The dashboard surfaces queued routing problems and offers a one-click automatic reroute action that reschedules the task through the normal scheduler.
- The dashboard can clear old standalone terminal task history through `POST /api/tasks/prune` while preserving task records that belong to batches or sessions.
- The dashboard can clear completed verify/doctor system history through `GET|POST /api/system-history/prune`; the cleanup removes matching terminal diagnostic tasks, diagnostic batches, and their task artifacts while preserving user tasks, user batches, and session work.
- CLI exposes `nado history prune-system --dry-run` and `nado history prune-system` for the same diagnostic cleanup path, and MCP exposes `nado_prune_system_history` so control-side agents can keep the gateway history readable without browser access.
- The dashboard can list and requeue tasks stranded on offline workers through the existing offline recovery APIs.
- The dashboard can create sessions through the existing `POST /api/sessions` API.
- The dashboard can inspect and close sessions through the existing session detail and close APIs.
- The dashboard can submit a task into an existing session by sending `sessionId` through the same task API.
- The dashboard can list and download the latest stored session artifact snapshot as a standard zip through the session artifact APIs.
- The dashboard can plan batch JSON through `POST /api/batches/plan`, place the result into an editable JSON textarea, and submit it through the existing `POST /api/batches` API.
- The dashboard can preview dispatch for editable batch JSON through `POST /api/dispatch/plan` before submitting tasks.
- The dashboard can inspect batch detail through the existing `GET /api/batches/<batch-id>` API.
- The dashboard can inspect aggregate batch reports through the existing `GET /api/batches/<batch-id>/report` API.
- The dashboard can inspect merged batch event timelines through the existing `GET /api/batches/<batch-id>/events` API.
- The dashboard can stream merged batch event timelines through the existing authenticated batch SSE API.
- The dashboard can list batch artifacts and download stored child artifacts as a standard zip through the existing batch artifact APIs.
- The dashboard can retry failed/cancelled batch children and cancel remaining batch work through the existing `POST /api/batches/<batch-id>/manage` API.
- The dashboard can open task detail through the existing task APIs and show stdout, stderr, recent events, full task events, live task event streams, and artifact metadata.
- The dashboard task detail previews small text artifacts inline through the task artifact content API.
- The dashboard can download stored task artifacts through the existing artifact content API.
- The dashboard can send worker management actions, including shutdown and capability-gated live credential rotation, through the existing worker management API and clearly reports that the command was queued.
- API routes remain authenticated; loading the dashboard shell does not make `GET /api/status` public.
- Automated tests verify the dashboard HTML is served, references the existing authenticated status/context/MCP-config/task/artifact/doctor/verify/dispatch/worker-token/recovery/session/batch API paths, exposes invite download/self-test, worker detail/use, agent context, MCP config, doctor, readiness verify, worker-token management, offline recovery, advanced task submission, agent-task, task management, session management, session-task, session artifact, batch planning, dispatch preview, batch, batch event, batch artifact, and batch management hooks, and protected APIs still reject unauthenticated requests.

## A50: Task Attempts Guard Against Stale Worker Writes

Acceptance:

- Every successful task claim creates a new `currentAttemptId` on the task.
- Worker-started, stdout, stderr, and final result writes include the attempt ID returned by claim.
- While a task is running, events whose attempt ID does not match the current attempt are ignored.
- While a task is running, results whose attempt ID does not match the current attempt are ignored and recorded as `stale_result_ignored`.
- Results for tasks that are no longer running are ignored and recorded as `late_result_ignored`.
- Requeue, retry, cancel, and offline recovery clear the active attempt before any later claim creates a new one.
- Stale attempt results cannot overwrite stdout, stderr, status, workspace, or artifacts produced by the current recovered/retried attempt.
- Automated tests verify a recovered task ignores stale output and stale artifacts from the original offline worker, then accepts the fresh recovery worker result.

## A51: Quickstart Boots A Directly Usable Local Gateway

Acceptance:

- `node ./src/cli.js quickstart --port 8765` starts the normal control server and a normal local worker in one process.
- Quickstart runs the existing doctor self-test path, submitting a real shell task through the gateway and verifying `doctor.txt`.
- Quickstart writes an `AGENTS.md` control-agent context file and an MCP client config JSON file.
- Quickstart prints the control URL, Dashboard URL, token, worker ID, data directory, context path, MCP config path, and a task submission example.
- Quickstart prints a `context install` command so the generated worker inventory can be installed into the active project's `AGENTS.md` without overwriting user-authored instructions.
- Without `--once`, quickstart keeps the gateway alive until interrupted so the Dashboard can be opened immediately.
- With `--once`, quickstart stops the worker and control server after the self-test for CI and scripted acceptance.
- Automated tests verify quickstart output, self-test success, context file content, and MCP config content.

## A52: Tasks Can Request An Isolated Sandbox Profile

Acceptance:

- Task submission accepts `sandboxProfile: "isolated"` through HTTP, CLI `--sandbox`/`--sandbox-profile isolated`, Dashboard task submission, batch JSON/defaults, and MCP task/batch inputs.
- Isolated tasks run in the normal worker workspace/task-runner path but receive only a minimal inherited host environment, explicit task env values, and gateway-managed `NADO_*` variables.
- Isolated tasks receive `NADO_SANDBOX_PROFILE=isolated`.
- The isolated profile does not inherit unrelated worker process environment variables by default.
- The default profile preserves existing process environment inheritance for compatibility.
- Automated tests verify isolated env behavior, CLI submission, MCP schema/submission, Dashboard wiring, and batch default inheritance/override.

## A53: HTTP Event Streams Support Live Supervision

Acceptance:

- `GET /api/tasks/<task-id>/events/stream` returns authenticated `text/event-stream` output for task lifecycle and stdout/stderr events.
- `GET /api/batches/<batch-id>/events/stream` returns authenticated `text/event-stream` output for the same merged batch timeline shape as `GET /api/batches/<batch-id>/events`.
- Stream endpoints use the same bearer token authentication as the rest of the HTTP API.
- Streams replay known events, emit new events as workers report them, and send a `done` event before closing when the task or batch reaches a terminal status.
- HTTP client exposes `streamTaskEvents()` and `streamBatchEvents()` async iterators.
- Dashboard task detail can stream task events, and Dashboard batch event detail can stream merged batch timelines, without a separate frontend service.
- Automated tests verify task SSE emits live stdout/stderr through terminal status, batch SSE emits merged child task success events through terminal status, and Dashboard exposes the stream hooks.

## A54: Task Artifacts Have Direct Download URLs

Acceptance:

- The existing JSON artifact content API remains available for MCP and compatibility.
- HTTP clients can download a task artifact without base64 wrapping through `GET /api/tasks/<task-id>/artifacts/<artifact-id>/download`.
- Direct artifact downloads require the same admin bearer token as artifact metadata and JSON content APIs.
- Direct download responses include `content-disposition`, artifact id/path/sha headers, and raw bytes.
- HTTP client exposes `downloadArtifact()` for direct byte retrieval.
- CLI `artifact download` and `artifacts download` use the direct byte API while preserving output path safety.
- Dashboard task artifact download uses the direct byte API through authenticated `fetch`.
- Automated tests verify direct HTTP download bytes, unauthenticated rejection, HTTP client metadata, CLI compatibility, and Dashboard wiring.

## A54b: Large Worker Artifacts Resume Safely

Acceptance:

- Small artifacts retain the existing inline base64 result contract.
- Large files are represented locally by path/size/SHA-256 descriptors and are never loaded into Worker memory as one buffer.
- `POST /api/tasks/<task-id>/artifact-uploads` creates or resumes an upload for the assigned Worker and current live attempt.
- `PATCH /api/tasks/<task-id>/artifact-uploads/<upload-id>/chunks?offset=<n>` streams a bounded raw chunk to disk and advances the persisted offset only after its SHA-256 is verified.
- Interrupted chunks are truncated back to the last committed offset; offset conflicts return the authoritative committed offset.
- Upload status survives a control-process restart, and the Worker continues from that offset.
- Finalization requires the declared size and whole-file SHA-256, then atomically promotes the partial file.
- Wrong Workers, stale attempts, and expired leases cannot append, finalize, or attach an upload.
- Optional non-session workspace cleanup occurs only after all chunked artifacts are finalized.
- Automated tests cover interruption rollback, duplicate/conflicting offsets, restart resume, checksum reset, Worker/attempt ownership, legacy inline compatibility, raw download, and cleanup.

## A54c: Large Task Inputs Are Gated And Resumable

Acceptance:

- Small task inputs preserve the existing `contentBase64` contract.
- CLI and Dashboard select chunked transfer when a file exceeds the inline per-file or total budget.
- A task with unfinished large inputs has status `uploading_inputs` and cannot be claimed or reserve Worker capacity.
- Input upload offsets and partial files survive control-process/SQLite restart; conflicting offsets return the committed position.
- Finalization validates declared size and whole-file SHA-256 before atomically promoting the input and queuing the task.
- Workers download finalized task and dependency inputs with authenticated open-ended byte ranges, retain partial data after a transport break, and verify SHA-256 before execution.
- Only the assigned Worker and current live attempt can download a task input; a recovered attempt loses access.
- Dependency artifacts are stored references and are not re-encoded into task-state base64.
- Dashboard reports per-file upload progress and requires HTTPS/localhost browser crypto for large-file chunk hashes.
- Automated tests cover scheduling gate, control restart, range resume, CLI automatic switching, wrong Worker/stale attempt denial, checksum verification, and legacy inline inputs.

## A54d: Cross-Site Workers Report Operational Telemetry

Acceptance:

- Every heartbeat reports total, free, available, and used bytes for the filesystem containing the Worker data directory without relying on platform-specific shell parsing.
- Every Worker process samples operating-system CPU time counters across heartbeats to report a bounded 0–100% utilization value on Linux and Windows, plus logical cores and 1/5/15-minute load where the platform provides it. The first sample is explicitly unavailable instead of fabricated.
- Memory telemetry reports total, free, used, and used-percent values while preserving the legacy `totalmem`/`freemem` heartbeat fields for compatibility.
- A successful heartbeat updates an end-to-end control request/response RTT that is included in the next heartbeat; the field is explicitly described as a previous-heartbeat measurement.
- A Worker periodically initiates separate upload and download probes to the same control endpoint, verifies SHA-256/byte counts, and reports measured bytes per second in the next heartbeat.
- Probe payloads are restricted to the bound Worker identity, limited to 4 KiB–1 MiB, rate-limited per Worker and direction, and disabled with an interval of `0`; failures remain non-fatal to registration, task claim, leases, and execution.
- Linux sysfs, Windows hardware-monitor/ACPI, and optional macOS `osx-cpu-temp` host temperature probes are best effort and bounded; unavailable, unsupported, or virtualized sensors never prevent registration, heartbeat, claim, or execution.
- Structured NVIDIA and AMD/ROCm device temperatures remain visible alongside host sensors without being mistaken for CPU temperature.
- CLI Worker listing, generated control-agent context, capabilities, and Dashboard Worker detail expose CPU utilization, memory pressure, disk, control RTT, and temperature evidence.
- Automated tests cover CPU counter deltas, first-sample handling, memory normalization, statfs normalization, live heartbeat persistence, Linux/Windows/macOS temperature parsing and non-fatal probe failure, bandwidth calculation, Worker identity separation, size/rate limits, capabilities advertisement, and Dashboard hooks.

## A55: Grouped Artifacts Have Direct ZIP Downloads

Acceptance:

- `GET /api/batches/<batch-id>/artifacts/download` returns a server-generated ZIP containing stored child artifacts under `<batch-key-or-task-id>/<artifact-path>`.
- `GET /api/sessions/<session-id>/artifacts/download` returns a server-generated ZIP containing the latest session task's stored artifacts.
- ZIP downloads use the same admin bearer token as other artifact APIs and return `application/zip` with a downloadable filename.
- The existing JSON/base64 grouped artifact APIs remain available for MCP and compatibility.
- HTTP client exposes `downloadBatchArtifactsZip()` and `downloadSessionArtifactsZip()`.
- Dashboard batch and session artifact download buttons use the direct ZIP APIs.
- Automated tests verify batch ZIP content, session ZIP content, file names, content type, and Dashboard wiring.

## A56: Gateway Capabilities Manifest Is Discoverable

Acceptance:

- `GET /api/capabilities` returns authenticated JSON describing gateway version, auth model, control surfaces, MCP tools, feature flags, stable endpoint templates, CLI examples, worker summaries, and session summaries.
- Unauthenticated `GET /api/capabilities` is rejected when an admin token is configured.
- HTTP client exposes `capabilities()`.
- CLI exposes `nado capabilities --control URL`.
- MCP exposes `nado_capabilities`.
- Dashboard can preview and download the manifest through the same authenticated HTTP endpoint.
- Generated control-agent context points non-MCP clients to the manifest.
- Automated tests verify the manifest includes current workers, task/batch/session/artifact/SSE endpoint templates, feature flags, CLI output, Dashboard wiring, and protected API behavior.

## A57: Gateway Readiness Is Verifiable End To End

Acceptance:

- CLI exposes `nado verify --control URL` as a permanent operator readiness command.
- HTTP exposes authenticated `POST /api/verify` for custom clients and Dashboard.
- MCP exposes `nado_verify` for control-side agents.
- Verify checks control health, gateway status, capabilities manifest, generated agent context, MCP client config, doctor self-test, a real task with raw artifact download, task events, and a real batch with server ZIP download.
- Verify supports worker, capability, tool, label, all-worker doctor, timeout, skip-doctor, and JSON output options using the existing routing model.
- Dashboard exposes a Readiness Verify panel with the same routing and timeout options.
- Verify exits non-zero and reports failed checks when any required readiness path fails.
- Automated tests verify CLI, HTTP client, MCP, protected API behavior, and Dashboard wiring for readiness verification against a live local control server and worker.

## A58: Dispatch Planning Previews Worker Assignment

Acceptance:

- `POST /api/dispatch/plan` returns an authenticated dry-run scheduler plan for a task list or batch JSON without creating tasks.
- Dispatch planning uses the same worker eligibility, label, capability, required-tool, score, and weighted slot capacity rules as normal task scheduling.
- Earlier dry-run items reserve preview capacity, so later items show realistic worker spread or unassigned status.
- HTTP client exposes `planDispatch()`.
- CLI exposes `nado dispatch plan --control URL --file ./batch.json` and inline `--task` planning.
- MCP exposes `nado_plan_dispatch` for control-side agents.
- Dashboard can preview dispatch from the editable batch JSON before submitting it.
- Capabilities manifest advertises dispatch planning and the `POST /api/dispatch/plan` endpoint.
- Automated tests verify dispatch planning through HTTP client, CLI, MCP, Dashboard wiring, capability manifest, protected API behavior, and no task mutation during dry-run.

## A59: Submissions Can Require Static Routability

Acceptance:

- Task and batch submissions accept `requireRoutable: true`.
- CLI exposes `--require-routable` on `submit` and `batch submit`.
- MCP exposes `requireRoutable` on `nado_submit_task` and `nado_submit_batch`.
- Dashboard task and batch forms expose a require-routable option.
- When enabled, the gateway rejects submissions with no online/admin-enabled worker matching static worker, capability, label, tool, and maximum slot constraints.
- Temporary current slot saturation does not by itself reject a routable submission.
- Rejected submissions do not create tasks or batches and return a dispatch plan in the error response.
- Capabilities manifest advertises routability-guarded submission support.
- Automated tests verify rejected unroutable task and batch submissions leave gateway state unchanged, and routable guarded CLI/MCP submissions still execute.

## A60: CLI Batch Submit Can Wait, Report, And Download In One Flow

Acceptance:

- `nado batch submit --wait` submits ordinary batch JSON and waits for the created batch to reach a terminal status through the existing batch inspection API.
- `nado batch submit --report` waits before printing the same consolidated report shape as `nado batch report`.
- `nado batch submit --download --out <dir>` waits before downloading child artifacts into the same `<batch-key-or-task-id>/<artifact-path>` tree as `nado batch download`.
- The combined flow supports `--require-routable` and uses the same task creation, scheduler, report, and artifact APIs as separate CLI commands.
- The command exits non-zero when the waited batch reaches `completed_with_errors`.
- Automated tests verify the combined submit/wait/report/download flow against a live control server and worker.

## A61: CLI Task Submit Can Wait And Download In One Flow

Acceptance:

- `nado submit --wait` creates a normal task and waits for that task to reach `succeeded`, `failed`, or `cancelled` through the existing task detail API.
- `nado submit --watch` waits and prints task events using the same event formatting as `nado wait --watch`.
- `nado submit --download --out <dir>` waits before downloading stored task artifacts through the same direct artifact APIs as `nado artifacts download`.
- The combined flow supports existing routing, sandbox, input, env, artifact policy, and `--require-routable` options.
- The command exits non-zero when the waited task does not reach `succeeded`.
- Automated tests verify the combined submit/wait/download flow against a live control server and worker.

## A62: MCP Can Run A Task To Completion In One Tool Call

Acceptance:

- MCP exposes `nado_run_task` for control-side agents that want one task handoff call instead of manually chaining submit, wait, and artifact tools.
- `nado_run_task` accepts the same routing, session, input file, env, sandbox, artifact policy, slots, priority, timeout, and `requireRoutable` fields as `nado_submit_task`.
- `nado_run_task` creates a normal durable gateway task, waits for terminal status through the existing task detail API, and returns both the submitted task snapshot and final task detail.
- MCP `nado_submit_task` and `nado_run_task` return a top-level `routing` summary with selected worker, scheduler reason, inferred capabilities, inference evidence, scored candidates, and rejected candidate reasons.
- By default, `nado_run_task` returns stored task artifacts with base64 content through the same JSON artifact API as `nado_get_task_artifacts`; callers can disable artifact listing/content.
- MCP `nado_submit_task` schema explicitly exposes `requireRoutable`.
- Automated tests verify tool discovery, schema fields, successful run-to-completion, and returned artifact content against a live control server and worker.

## A63: MCP Can Run A Batch To Completion In One Tool Call

Acceptance:

- MCP exposes `nado_run_batch` for control-side agents that want one multi-task handoff call instead of manually chaining submit, wait, report, and artifact tools.
- `nado_run_batch` accepts the same title, defaults, tasks, dependency, routing, input file, env, sandbox, artifact policy, slots, priority, timeout, and `requireRoutable` fields as `nado_submit_batch`.
- `nado_run_batch` creates a normal durable gateway batch, waits for `succeeded` or `completed_with_errors` through the existing batch detail API, and returns both submitted and final batch/task snapshots.
- MCP `nado_submit_batch` and `nado_run_batch` return `routing[]` summaries for each child task, including selected worker, scheduler reason, inferred capabilities, inference evidence, candidates, and rejected candidate reasons; `nado_run_batch` also returns `finalRouting[]`.
- By default, `nado_run_batch` returns the same consolidated report shape as `nado_batch_report` and grouped base64 artifact content through the same API as `nado_get_batch_artifacts`; callers can disable report/artifact content.
- Automated tests verify tool discovery, schema fields, successful run-to-completion, report content, and grouped artifact content against a live control server and worker.

## A64: Distributed Planner Turns One Large Task Into A Batch DAG

Acceptance:

- `POST /api/planner/plan` accepts one large `prompt`, optional `subtasks`, and mode `auto`, `parallel`, `pipeline`, `map_reduce`, or `review`.
- The planner returns a normal submit-ready batch JSON object plus a dispatch preview using the same scheduler as `POST /api/dispatch/plan`.
- `map_reduce` creates shard tasks plus a final synthesis task with `dependsOn` all shards and `dependencyArtifacts: true`.
- `review` creates independent review tasks plus a final adjudication task with `dependsOn` all reviews and `dependencyArtifacts: true`.
- `pipeline` creates a dependency chain where each later stage depends on the previous stage and receives dependency artifacts.
- `POST /api/planner/run` creates the planned work as a normal durable batch through the existing batch creation path.
- CLI exposes `nado planner plan` and `nado planner run`.
- MCP exposes `nado_plan_distributed_task` and `nado_run_distributed_task`.
- Dashboard exposes Distributed Planner controls that can plan into editable batch JSON or submit the generated batch directly.
- Capabilities manifest advertises distributed task planning and planner endpoints.
- Automated tests verify planner topology, HTTP plan/run behavior, dispatch preview, and normal batch creation semantics.

## A65: Task Attempts Have Renewable Leases And Bounded Recovery

Acceptance:

- Every claimed task records a unique attempt ID plus lease acquisition, renewal, expiry, duration, and worker identity.
- Worker heartbeats identify current task attempts and renew only a live lease owned by that worker/current attempt.
- A heartbeat cannot resurrect an expired lease; events and results after lease expiry are ignored.
- Manual recovery lists both offline-worker tasks and expired-lease tasks.
- Opt-in automatic recovery considers lease expiry as well as the configured worker-offline grace period.
- Ordinary-task recovery creates a new attempt after a bounded exponential delay and stops permanently at task `maxAttempts` with a `retry_exhausted` event.
- Session-task automatic recovery is same-Worker only: it closes the expired/lost attempt, preserves the session's assigned/requested Worker and workspace metadata, and queues a new attempt that no other Worker can claim. Cross-Worker session migration remains an explicit manual operation because the workspace is worker-local.
- Task list/detail and status responses derive `runtimeDiagnostics` from the current lease, Worker heartbeat/gateway state, retry deadline, session affinity, and durable recovery event. States include healthy running, stale heartbeat with live lease, expired lease, retry backoff, and waiting for the original session Worker.
- Every runtime state that needs intervention includes a structured `nextAction`; Dashboard separates operational issues from routing issues, and CLI task listings expose the same state without requiring timestamp arithmetic.
- Repeated task submissions with the same explicit `idempotencyKey` return the existing task instead of creating duplicate work.
- Capabilities/status expose task-lease, bounded-retry, idempotency, and at-least-once semantics.
- Automated tests verify lease renewal, non-resurrection, stale output rejection, new-attempt recovery, retry exhaustion, submission deduplication, runtime state/next-action derivation, same-Worker session affinity/workspace preservation, SQLite persistence compatibility, and existing offline-recovery behavior.
- `docs/cross-site-deployment.md` defines private-overlay and public-HTTPS deployment paths plus the real VM/home-worker acceptance matrix.

## A66: Hardware Resources Gate Scheduling And Idle Claims Use Long Polling

Acceptance:

- Worker inventory reports CPU core count, total memory, and structured NVIDIA or AMD GPU devices with model, total/free VRAM, temperature, and utilization when the probe is available.
- Tasks and sessions can declare operating system, CPU architecture, CPU cores, RAM, GPU count, aggregate VRAM, and GPU model through `requiredResources`.
- CLI task/session commands expose `--platform`, `--arch`, `--cpu`, `--memory`, `--gpu-count`, `--vram`, and `--gpu-model`; HTTP, MCP, Dashboard, batch defaults/tasks, and dispatch preview preserve the same resource object.
- Common platform aliases (`windows`, `macos`) and architecture aliases (`amd64`, `aarch64`) normalize to Worker inventory identifiers (`win32`, `darwin`, `x64`, `arm64`). Missing or mismatched platform/architecture inventory fails closed with an explicit candidate reason at scheduling and claim time.
- Scheduler scoring subtracts running and queued reservations, rejects insufficient/unknown hardware, and records exact candidate reasons and capacity snapshots.
- After hard capability/resource admission, automatic routing applies bounded soft penalties for live CPU utilization and memory pressure so an otherwise equivalent busy host is less preferred. Missing first-sample telemetry adds no penalty; explicit Worker targets and session affinity remain authoritative.
- Worker claim repeats resource admission so a stale or explicitly targeted route cannot bypass hardware limits.
- Decorated worker/status/capabilities responses show total, used, and available hardware reservations.
- Idle workers default to a bounded 20-second claim long poll; a compatible task wakes the request promptly, and `longPollMs=0` retains fixed polling.
- Worker shutdown aborts an outstanding long-poll request, while active-task workers keep the short heartbeat loop needed for lease renewal and management.
- Automated tests cover platform/architecture aliasing and mismatch/missing-evidence rejection, byte/GPU parsing, multi-resource route selection, dynamic host-pressure preference, reservation exhaustion, claim-time rejection, session inheritance, CLI/MCP/Dashboard propagation, long-poll wakeup/timeout, worker-token compatibility, and existing concurrency behavior.
- Modern `amd-smi` support merges per-GPU static identity with metric VRAM/temperature/utilization JSON, tolerates diagnostic text before the payload, prefers edge temperature, and avoids duplicate devices when legacy `rocm-smi` is also installed. Legacy ROCm parsing remains the fallback and both paths feed the same vendor-neutral resource admission model as NVIDIA.

## A67: Control Security Guards And Audit Trail Are Operational

Acceptance:

- `control start` and `quickstart` never echo a configured administrator token. Remote-facing startup without an explicit credential fails before binding; `--generate-token-file` exclusively creates a private file outside Control data, while implicit terminal display is limited to loopback development.
- Quickstart prints environment-variable placeholders rather than credentials in follow-up commands, writes its credential-bearing MCP configuration with mode `0600` on POSIX, and disables Dashboard token injection whenever the Control is remotely advertised.
- API requests are limited independently by source IP and authenticated administrator, Worker, or enrollment identity; rejected requests return `429` with `Retry-After` and rate metadata.
- Ordinary JSON bodies are rejected with `413` when the declared or streamed size exceeds `NADO_JSON_BODY_MAX_BYTES`; malformed JSON returns `400`.
- Failed API calls, administrator mutations, and Worker registration/enrollment generate bounded durable audit events containing actor class, redacted/fingerprinted identity, path, status, outcome, source, request ID, duration, and sanitized error only.
- Worker-scoped credentials cannot read or export audit events, and neither JSON nor NDJSON output contains raw administrator/Worker tokens.
- Audit events survive a SQLite-backed control restart and shutdown waits for pending audit writes before reporting completion.
- `NADO_AUDIT_NDJSON_FILE` optionally mirrors sanitized events through an ordered append queue with Unix mode `0600`; `NADO_AUDIT_NDJSON_MAX_PENDING` bounds memory under a stalled sink. Sink failures/drops never fail API/database writes, later events remain retryable, and current health plus process-lifetime delivery integrity surface as path-free status/capability diagnostics.
- CLI and Dashboard can filter recent events and export NDJSON with restrictive local file permissions from the CLI.
- Dashboard responses use a per-request nonce CSP and no-sniff, no-referrer, no-frame, restricted-permissions, and no-store headers; administrator credentials are removed from legacy local/session storage and are not persisted by the page.
- Automated tests cover configured-token log redaction, fail-closed remote generation, private token-file delivery, successful/denied audit records, redaction, authorization, persistence, NDJSON export/mirroring, sink ordering/failure isolation/recovery, bounded-queue drops and integrity reporting, body limits, rate limits, retry guidance, CSP nonce wiring, secure headers, and Dashboard storage behavior.

## A67.1: Worker Credentials Rotate Without Stranding A Remote Host

Acceptance:

- Only the matching Ed25519-signed Worker identity can call rotation prepare/confirm; unsigned, administrator, wrong-Worker, malformed, expired, and replayed requests are rejected.
- Prepare accepts only a locally generated high-entropy replacement, stores only its hash, inherits the Worker/public-key binding and original final expiry, and leaves the old token active.
- The Worker atomically persists the pending replacement before confirming with it. Confirm activates the replacement and revokes the predecessor in one durable update.
- Repeated prepare and confirm calls are idempotent. A lost confirm response leaves a usable replacement identity whose startup recovery repeats confirm and removes pending local metadata.
- Unconfirmed pending tokens expire and are revoked without revoking the predecessor. Audit, token listings, CLI, Dashboard, and capabilities expose status and record IDs but never raw tokens.
- Optional runtime rotation waits for an idle Worker, updates the shared client credential, and retries transport failures without stopping the Worker loop.
- Control-triggered runtime rotation stays queued while tasks are active, runs on the Worker so private material never leaves the home host, acknowledges non-secret token IDs and verification results, and can atomically update the `credentialRevocation` acceptance evidence scenario.
- Verified rotation evidence records a structured non-secret receipt: mode, Worker ID, optional command ID, predecessor/replacement token record IDs, replacement acceptance, predecessor rejection, HTTP status, and check timestamp.
- Strict cross-site acceptance binds the receipt to the selected Worker's current signed token. Control-triggered evidence must also match its durable completed `rotate_token` command and exact verification result; operator prose or a forged `200` predecessor status fails closed.
- Direct `worker token rotate` is reserved for a stopped Worker, startup recovery, or another operator-guaranteed no-concurrency window because a separately running process can retain the predecessor token in memory.
- Automated tests cover authorization boundaries, prepare/confirm idempotence, pending expiry, old-token rejection, audit redaction, atomic identity persistence, response-loss recovery, direct CLI rotation, control-triggered busy/idle runtime rotation, and evidence recording.

## A68: Control State Is Versioned, Backed Up, Verified, And Restorable

Acceptance:

- JSON logical state and SQLite physical schema publish independent current versions; supported older state migrates on load and persists at the current version.
- A state or SQLite database written by a newer unsupported runtime is rejected before any downgrade write.
- `nado store backup` requires explicit confirmation that the control service is stopped, selects JSON/SQLite deterministically, migrates pending state, and writes to a new destination only.
- Every regular control-state, input, upload, and artifact file is copied with restrictive permissions and recorded in a manifest with byte size and SHA-256; symbolic links and unsupported filesystem entries are rejected.
- `nado store verify` rejects missing, extra, corrupt, malformed, or future-version backup content.
- `nado store restore` requires offline confirmation, verifies before copying, rechecks every restored file, targets only a path that does not exist, and never overwrites the active control directory.
- Restore remaps persisted control-side `storagePath`/`tempPath` fields to the new directory while leaving remote Worker workspace paths untouched.
- Successful restore writes a restrictive, path-free receipt only after verified copying, path remapping, and store persistence. It contains a fresh receipt ID, restore/source timestamps, backend/schema versions, source manifest SHA-256, and file/byte totals; later backups exclude prior receipts so they cannot be replayed as new restore evidence.
- Backup excludes the JSON/SQLite store's recognized atomic-write temporary filenames while preserving resumable transfer `.part` files; abandoned or concurrently disappearing state-write temps cannot break an otherwise offline snapshot.
- Control startup validates any receipt, rejects a backend mismatch, and exposes the non-secret summary under `status.storage.restoreReceipt`.
- Automated tests cover JSON and SQLite migration, backup integrity, tamper rejection, path remapping, newer-version refusal, CLI flows, and loading tasks/artifacts after restore.

## A69: Real Cross-Site Acceptance Produces A Strict Evidence Report

Acceptance:

- HTTP client and MCP expose the complete stateless evidence flow: `nado_acceptance_template`, `nado_record_acceptance_evidence`, and `nado_acceptance_report`. A generated template is accepted unchanged by the report schema; automatic checks remain separate from mandatory operator WAN/physical evidence, and `runVerify` is opt-in because it creates diagnostic work.
- `nado acceptance template` creates a versioned operator-evidence file without overwriting an existing path.
- `nado acceptance --worker <id>` checks a non-loopback remote Control URL, HTTPS or verified private-overlay transport, active target Worker, outbound connection model, scoped/signed/replay-protected identity support, SQLite versions, automatic lease recovery, resumable transfers, CPU/RAM/disk/network telemetry, and optional real GPU/Agent readiness.
- The credential-revocation automatic gate requires tool-generated structured evidence, replacement acceptance, predecessor HTTP `401`, exact selected-Worker/token binding, and—when initiated by control—the matching persisted `rotate_token` command. A generic manual claim cannot satisfy it.
- The remote-cancellation automatic gate requires `automated_exercise` evidence bound to the selected Worker and the exact persisted acceptance task/attempt. Signed Worker `command_applied(cancel_current)` and `task_released` events are copied into the task's durable history as idempotent corroboration records, so the gate survives rotation of the bounded Worker log; operator prose or edited event fields cannot satisfy it.
- When Agent acceptance is required, the Agent-collaboration automatic gate requires `automated_exercise` evidence bound to the selected Worker, a closed two-task Worker-affine session, both successful Agent attempts, and the exact ID/path/size/SHA-256 metadata for `agent-plan.md`, `agent-final.md`, and the session transcript. A handwritten claim or edited artifact digest fails closed.
- The long-disconnect automatic gate requires `supervised_exercise` evidence bound to the selected Worker and exact durable task. It cross-checks a first `lease_expired` attempt, `lease_recovered` event, stale/late/expired result rejection for that attempt, a distinct successful second attempt, the first execution marker, and final artifact metadata. Operator prose or changed attempt/event/artifact fields fail closed.
- Every task created through the control API is stamped by the server with its non-persisted `createdControlInstanceId`; a client-supplied value cannot override it. The VM-restart automatic gate binds this stamp to the original runtime, requires a different current runtime after at least one unreachable observation, SQLite storage, the unchanged successful attempt, a Worker heartbeat after the new runtime started, and the one-execution artifact digest. Edited runtime IDs or a healthy no-outage response fail closed.
- Every accepted artifact chunk now appends a durable `artifact_upload_progress` task event with the signed Worker/attempt/upload identity, previous and committed offsets, chunk size, declared size, and whole-file digest; finalization appends `artifact_upload_finalized`. The large-artifact automatic gate requires a positive partial offset, persisted stalled offset, a durable event-time gap at least as long as the supervised stall, same upload/attempt finalization, and exact artifact size/SHA-256.
- The large-input automatic gate binds the staged input ID/path/size/SHA-256 to the task descriptor and requires the exact attempt's durable offset-0 `input_download_range` followed after the supervised disconnect by a positive Range event. It also requires the successful single attempt and returned hash-artifact metadata. Edited offsets, IDs, digests, or event timestamps fail closed.
- The backup/restore automatic gate compares every non-secret restore receipt field with the live SQLite status, binds the pre-backup marker task's server stamp to the old runtime and the post-restore write task's stamp to the new runtime, requires a recorded outage and current restarted instance, verifies both task attempts and artifact digests, and requires the selected Worker to have heartbeated after restart. A copied old receipt, changed manifest hash, missing marker history, or write probe on the wrong control instance fails closed.
- The Worker identity check uses the selected Worker's latest successful registration/heartbeat authentication evidence and fails when it used an administrator credential, an unsigned token, or has no current evidence; gateway-wide feature flags cannot satisfy this gate by themselves.
- The Worker source check uses the control-side address observed on the latest successful registration/heartbeat and rejects loopback/unknown sources. `X-Forwarded-For` and forwarded HTTPS are accepted only when `--trust-proxy`/`NADO_TRUST_PROXY=true` is paired with a matching `NADO_TRUST_PROXY_SECRET`/`X-Nado-Proxy-Secret`; legacy or unauthenticated proxy evidence fails closed. The manual physical-separation and inbound-firewall scenarios remain required.
- The encrypted-transport check uses the selected Worker's observed connection protocol. An advertised HTTPS URL cannot hide a direct HTTP bypass; observed HTTP is accepted only with passed `encryptedPrivateOverlay` evidence for Tailscale/WireGuard.
- `--run-verify` pins the existing health/task/event/artifact/batch/doctor verification flow to the selected Worker and records resulting task/batch IDs.
- Operator evidence is mandatory only for facts the gateway cannot honestly infer, especially different physical networks and no home inbound ports. Remote cancellation, supervised short/long disconnect, supervised VM restart, supervised home-Worker service restart, supervised large-artifact/input resume, supervised backup/restore, real Agent collaboration, and credential rotation use executable target-Worker workflows that write structured evidence.
- The clock gate binds to the timestamp from the selected Worker's latest verified registration/heartbeat. Final acceptance requires absolute Control-minus-Worker skew within 60 seconds; `worker preflight` estimates offset from the health-response midpoint and fails before the five-minute replay-protection boundary becomes unsafe.
- Passed/failed operator claims require a non-empty note and may carry timestamps plus task/event/log references; unknown scenario names are rejected to catch evidence typos.
- `acceptance evidence record` safely updates one validated scenario. `acceptance exercise remote-cancellation` proves exact Worker cancellation/release; supervised `short-disconnect` proves same-attempt lease renewal and one execution; supervised `long-disconnect-recovery` proves lease-expiry requeue, stale-result rejection, and a distinct successful second attempt; supervised `vm-restart-recovery` proves a real control-instance replacement with SQLite task/attempt durability and Worker reconnection; supervised `worker-restart-recovery` proves an offline interval, same signed identity, a new Worker runtime, and post-restart work; supervised `large-artifact-resume` proves a committed-offset stall and same-upload recovery; supervised `large-input-resume` proves a post-disconnect positive Range offset and complete Worker-side hash; supervised `backup-restore` proves a verified manifest restored into fresh state that preserves old artifacts and accepts new work; `agent-collaboration` proves two-turn terminal-Agent handoff; Worker token rotation records verified credential revocation.
- The report is `passed` only when every required automatic and operator gate passes. Failed checks exit non-zero; `--require-complete` always requires a deployment-boundary receipt and also exits non-zero for pending checks. MCP `nado_acceptance_report` has the same strict default; `requireDeploymentEvidence=false` is reserved for non-final diagnostic previews.
- Evidence/report output uses restrictive permissions and refuses to overwrite an existing file.
- Automated tests cover full/pending/invalid evidence, forged credential-revocation, remote-cancellation, short/long-disconnect-recovery, and Agent-collaboration notes/statuses, authenticated template/record/report HTTP clients, HTTP 400 validation failures, the complete MCP template-to-record-to-report flow, a live SQLite control with real runtime token rotation and cancellation/short-gap event binding, Worker telemetry, target-pinned verify tasks/artifacts/batches, CLI output, and archived report/template files. A local report that did not execute the supervised WAN drills remains pending instead of being promoted by operator text.

## A70: Transient Process Failures Use Explicit Bounded Retry Policies

Acceptance:

- Task results classify configuration, timeout, cancellation, process-spawn, Worker-runtime, and non-zero-exit failures without changing the existing succeeded/failed/cancelled lifecycle.
- `retryPolicy` is disabled by default and can opt into retryable failure kinds or exact positive exit codes; configuration errors and cancellations cannot be selected for automatic retry.
- A matching failure below `maxAttempts` closes the current attempt as `retryable_failure`, releases Worker capacity, applies the existing bounded exponential delay, emits `retry_scheduled`, and creates a distinct later attempt.
- Explicit Worker targets remain pinned, session retries retain Worker/workspace affinity, and automatically routed tasks return to the scheduler so recent Worker failures can influence placement.
- A matching failure on the final allowed attempt remains terminal and emits `retry_exhausted`; a non-matching failure remains terminal immediately.
- CLI, HTTP, MCP, Dashboard task submission, task detail, capabilities, generated context, and persisted JSON/SQLite state preserve and expose the policy and failure classification.
- Windows PowerShell and Linux Bash workers preserve native process exit codes so exit-code matching has the same meaning across hardware and operating systems.
- Automated tests cover normalization/rejection, matched and unmatched outcomes, exhaustion, new attempt identity, Worker event evidence, task-runner classification, CLI submission, and a live Control/Worker transient-failure recovery.

## A71: Remote Cancellation Produces Target-Worker Runtime Evidence

Acceptance:

- `nado acceptance exercise remote-cancellation --worker <id> --evidence <file>` refuses an offline, disabled, or unroutable Worker and always pins the probe task to the requested Worker.
- The exercise starts a bounded long-running process, waits for a live attempt, cancels it through task management, and requires the task to remain durably `cancelled`.
- Passing requires both the exact `cancel_current` Worker command acknowledgement and a Worker-originated `task_released` event emitted only after the child-process execution promise closes.
- HTTP claim responses use an immutable pre-persistence snapshot, so a cancellation racing the claim save cannot erase the attempt ID from the task already handed to the Worker. Release evidence therefore remains attempt-bound even at this boundary.
- Cancellation targets the full process tree rather than only the host shell. Windows verifies descendant-first termination below PowerShell; Linux/macOS use a dedicated process group with bounded TERM-to-KILL escalation. Graceful Worker stop remains pending until release evidence is allowed to complete.
- Structured evidence records Worker/task/attempt IDs, command and release events, timestamps, duration, and stable references without credentials or task output secrets.
- A failed exercise is recorded as failed and performs best-effort cancellation of any non-terminal probe task. Automated tests hold release-event delivery open and prove Worker shutdown does not resolve early; the same Windows integration path catches orphaned descendants because their inherited output pipe prevents the task promise from closing.
- Automated tests run the CLI exercise against a live target Worker, deterministically race claim persistence with cancellation, and feed the generated evidence into the strict cross-site report.

## A72: Agent Collaboration Produces Target-Worker Session Evidence

Acceptance:

- `nado acceptance exercise agent-collaboration --worker <id> --evidence <file>` refuses offline/disabled Workers, demo echo Agents, unverified custom Agents, and real terminal Agents without a successful self-test before creating a session.
- The exercise creates a session pinned to the requested Worker and runs two serial Agent tasks with `maxAttempts: 1` through the normal scheduler, session workspace, transcript, artifact, and result paths.
- The first turn creates `agent-plan.md` with a per-run random marker. The second prompt does not contain that marker and must read the prior workspace/transcript, copy it into `agent-final.md`, and emit `NADO_AGENT_COLLABORATION_OK`.
- Passing requires both tasks to succeed on the exact requested Worker, direct download and content validation of the plan/final artifacts, a downloadable session transcript containing the first turn, and a cleanly closed session.
- Structured evidence records Worker/session/task/attempt/artifact IDs, SHA-256 metadata, duration, and a hash of the random marker without storing credentials.
- Failure records available references and performs best-effort cancellation/session closure. Automated tests prove the two-turn evidence contract and fail-closed readiness gate without invoking a paid external Agent.

## A73: Short WAN Disconnect Produces Same-Attempt Evidence

Acceptance:

- `nado acceptance exercise short-disconnect --worker <id> --evidence <file>` starts a bounded task on the exact requested Worker and prints explicit disconnect/reconnect instructions; Nado never changes the host network interface itself.
- The CLI asks the authenticated VM endpoint to compute the configurable heartbeat gap from the control store's current `lastSeenAt/ageMs` (five seconds by default), rather than trusting a client-supplied age or waiting for the fixed 45-second offline classification. The endpoint rejects an expired lease and persists `short_disconnect_gap_observed` on the exact live attempt.
- The task must remain `running` with the same attempt throughout the gap, reconnect before its lease expires, and renew that exact lease. An attempt change, expiry, premature terminal result, or missing renewal fails the exercise.
- Recovery is accepted only when the VM observes the selected Worker active again, the same attempt lease has advanced beyond the stored gap receipt, and the renewed expiry remains in the future; it persists an attempt-bound `short_disconnect_recovered` event.
- The task workspace artifact contains one `execution` and one `completed` marker. Passing additionally requires terminal `succeeded`, the exact target Worker, one attempt only, and direct artifact download.
- Evidence source is `supervised_exercise` and records Worker/task/attempt/artifact references, observed heartbeat age, lease timestamps, reconnect timestamps, and artifact metadata. Failure performs best-effort cancellation.
- The strict report cross-checks both durable observation events, their Worker/attempt/lease timestamps, one-execution artifact metadata, and the supervised receipt. State-machine tests cover the server-computed observations, same-attempt renewal, one-execution verification, progress phases, and evidence-source preservation; the real WAN action remains part of the VM/home-host acceptance run.

## A74: Long WAN Disconnect Proves Safe At-Least-Once Recovery

Acceptance:

- `nado acceptance exercise long-disconnect-recovery --worker <id> --evidence <file>` fails before task creation unless automatic offline recovery, task leases, and the supervisor scan interval are active.
- Task processes receive Worker-controlled `NADO_ATTEMPT_ID` and `NADO_ATTEMPT_SEQ`; custom task env cannot spoof them. The first attempt emits a durable execution marker before the operator disconnects the original Worker.
- The operator keeps the Worker disconnected until the control supervisor records `lease_recovered`; the first attempt must close as `lease_expired`, and the task is requeued with `maxAttempts: 2` and zero retry delay.
- After reconnect, the original attempt's completion must produce `expired_lease_result_ignored`, `stale_result_ignored`, or `late_result_ignored` for its exact attempt ID. It cannot overwrite the new attempt even if another Worker already completed it.
- Passing requires exactly two durable attempts, a distinct successful second attempt, the original Worker active again, first-attempt execution evidence, stale-result rejection, and a downloaded JSON artifact identifying attempt sequence 2 and its attempt ID.
- The second attempt may run on another eligible Worker because automatic recovery intentionally returns non-session work to the scheduler. Evidence records both Worker IDs and labels the contract `at-least-once`; external mutations must remain idempotent.
- Failure performs best-effort cancellation. State-machine tests cover preconditions, lease recovery, attempt identity, stale rejection, final artifact identity, progress prompts, and result structure; the physical WAN interruption remains a required deployment drill.

## A75: VM Control Restart Preserves The Running Home-Worker Attempt

Acceptance:

- `nado acceptance exercise vm-restart-recovery --worker <id> --evidence <file>` fails before task creation unless the selected Worker is active/enabled, the authenticated status uses SQLite, and `/health` plus `/api/status` agree on a non-empty control runtime instance ID.
- The exercise pins a bounded task with `maxAttempts: 1` to the selected home Worker, waits for its durable execution marker, then instructs the operator to restart only the VM control service while preserving its data volume and leaving the Worker running.
- A passing run must observe the Control URL become unreachable at least once and later return a different, non-persisted `runtime.instanceId`; a healthy response without both facts cannot be used as restart evidence.
- After restart, authenticated status must still report SQLite, the original task ID must exist, its exact attempt ID must remain current or durably recorded, and the same Worker must return active before completion.
- Passing additionally requires terminal success on the target Worker, exactly one attempt, and a downloaded JSON artifact whose immutable attempt/Worker identity, execution count, and completion count match the task. The downloaded SHA-256 must match stored metadata when present.
- Evidence source is `supervised_exercise` and records both control instance IDs, outage observations, SQLite versions, Worker recovery, task/attempt/artifact references, and artifact hash without credentials.
- Keep the service outage shorter than the task lease. This scenario proves same-attempt SQLite restart recovery; the separate long-disconnect scenario proves lease-expiry requeue and stale-result rejection.
- State-machine tests cover the required outage and instance transition. A real integration test closes the SQLite control server, restarts it on the same port and data directory, and verifies the actual Worker completes once on its original attempt. The public-VM/home-host run remains required for final cross-site evidence.

## A75b: Home Worker Service Restart Preserves Signed Identity

Acceptance:

- `nado acceptance exercise worker-restart-recovery --worker <id> --evidence <file>` requires an active Worker with a signed worker-scoped token, a valid per-process runtime identity, and its matching control-observed runtime-start event.
- The operator stops the installed home Worker service and keeps it stopped until the VM reports the Worker offline. Starting it before that observation fails closed instead of treating a quick reconnect as outage evidence.
- Every Worker process generates a new non-secret `wrun_*` identity and reports it during registration and heartbeat. The control store reserves `runtime_started`, so a Worker log call cannot manufacture the transition used by strict acceptance.
- Restart must preserve the Worker ID and current signed token ID while changing the runtime ID and advancing its start time. The control event must link the old and new runtimes after the offline observation.
- The exercise then creates a target-pinned one-attempt task. Worker-controlled `NADO_WORKER_RUNTIME_ID` and `NADO_WORKER_RUNTIME_STARTED_AT` values are injected into the child process and cannot be overridden by task env.
- Passing requires successful execution on the selected Worker and a downloaded `worker-restart-recovery.json` artifact whose attempt, runtime ID, runtime start time, size, and SHA-256 match durable control state.
- Evidence source is `supervised_exercise`; handwritten operator text cannot satisfy the runtime, token, task, or artifact receipt checks. The real VM/home-host stop/offline/start drill remains mandatory for final acceptance.

## A76: Interrupted Large Artifact Upload Resumes From Its Durable Offset

Acceptance:

- `nado acceptance exercise large-artifact-resume --worker <id> --evidence <file>` requires an active/enabled target Worker and a control plane advertising resumable artifact uploads, then pins a one-attempt task that creates a deterministic file larger than the inline limit.
- Administrators can query `GET /api/tasks/<task-id>/artifact-uploads` to supervise upload ID, relative artifact path, attempt, size, SHA-256, status, and committed offset. Temporary and final control filesystem storage paths are never returned; ordinary Worker identities cannot use this list endpoint.
- The exercise waits until at least one chunk is durably committed while bytes remain, then instructs the operator to disconnect only the home Worker network. Completing before this observation fails with guidance to increase `--artifact-bytes` or reduce the Worker's chunk size.
- Passing the interruption phase requires both the target Worker's heartbeat age and the exact upload's unchanged committed offset to exceed `--min-stall-ms` (five seconds by default). An attempt change, terminal task, disappearing upload, or early finalization fails closed.
- After the operator reconnects the Worker, the same upload ID and task attempt must finalize at the declared size, and the Worker must report a heartbeat newer than the observed stall before the task completes.
- Final validation requires target-Worker success, exactly one attempt, attachment of that upload ID, and a direct artifact download whose length and SHA-256 match both upload metadata and the deterministic source content.
- Evidence source is `supervised_exercise` and records the first observed, stalled, and finalized offsets, stall/heartbeat timing, Worker/task/attempt/upload/artifact references, and SHA-256 without credentials or control storage paths.
- A state-machine test covers the evidence contract. A real integration test blocks all Worker control transport immediately after the first committed chunk, observes the heartbeat/offset stall, restores transport, and verifies the real upload resumes. The physical WAN interruption remains required for final cross-site evidence.

## A77: Interrupted Large Input Download Resumes From A Worker-Local Offset

Acceptance:

- Every authorized `GET /api/tasks/<task-id>/inputs/<input-id>/download` records a durable `input_download_range` task event after Worker/attempt ownership validation and before streaming bytes. The event contains input ID, relative path, attempt ID, requested offset, declared size, and whether it is a resume; invalid, wrong-Worker, and stale-attempt requests cannot create valid evidence.
- `nado acceptance exercise large-input-resume --worker <id> --evidence <file>` requires an active/enabled Worker plus resumable input upload, ranged download, and durable Range-event capability flags.
- The command creates a one-attempt target-pinned task in `uploading_inputs`, uploads a deterministic input to the VM in bounded chunks, finalizes it, and verifies the control-stored size and SHA-256 before allowing Worker claim.
- After the task starts, the control side must record the selected Worker/attempt requesting the exact input from offset 0. The operator then disconnects only the home Worker network and waits until the CLI observes the configured heartbeat gap while the task remains on that attempt.
- After reconnect, passing requires a new Range event on the same Worker/task/attempt and input ID, timestamped after the observed gap, whose offset is greater than 0 and less than the input size. This proves the Worker retained partial bytes locally rather than restarting from zero.
- Worker input materialization must verify the complete SHA-256 before renaming the partial file into the task workspace. The task then independently streams and hashes that file and returns a JSON artifact containing the expected size, SHA-256, Worker ID, attempt ID, and attempt sequence.
- Final validation requires target-Worker success and exactly one attempt. Evidence source is `supervised_exercise` and records initial/resumed offsets, gap/reconnect timing, Worker/task/attempt/input/artifact references, and hashes without Worker-local partial paths.
- A state-machine test covers the evidence contract. A real integration test interrupts the actual Worker response body after partial local persistence, blocks its entire control transport until the supervised heartbeat gap, restores it, and verifies a positive Range retry plus final hash. The physical WAN interruption remains required for final cross-site evidence.

## A78: Verified Offline Backup Restores Into Fresh Writable Control State

Acceptance:

- `nado acceptance exercise backup-restore` requires an active target Worker, SQLite, consistent health/status runtime identity, and advertised verified backup/restore plus restore-receipt capabilities. It also requires explicit source, backup, and new restored data-directory paths for operator instructions.
- Before shutdown, the exercise runs a one-attempt marker task on the selected home Worker, directly downloads its randomized JSON artifact, and records its task/attempt/artifact identity and SHA-256.
- When prompted, the operator stops control, runs offline backup and verification against the active directory, restores into a path that did not exist, and starts a new control process on the same URL using only the restored directory. The exercise must observe at least one unreachable control request and a different runtime instance ID.
- `store restore` creates its receipt only after manifest-verified file copies, persisted-path remapping, and a successful restored-store save. The receipt contains no source, backup, restored, or storage file paths. Backup creation excludes old restore receipts.
- Passing requires a receipt ID different from any initial receipt, a `restoredAt` timestamp after the exercise prompt, a valid manifest SHA-256, SQLite backend, preserved marker task, byte-identical downloadable marker artifact, and a selected-Worker heartbeat newer than the restored control runtime.
- The restored control must then accept a new target-Worker write probe, persist its task, and return an artifact that binds the fresh receipt ID, marker, Worker, and attempt. This proves the restored store is writable instead of merely inspectable.
- Evidence source is `supervised_exercise` and records both control instance IDs, outage observations, receipt/manifest IDs, Worker recovery, and pre/post task/artifact references while omitting every supplied filesystem path.
- Unit tests cover receipt validation, restrictive creation, old-receipt exclusion, CLI output, SQLite/JSON restore, and backend matching. A real integration test stops the source SQLite control, backs it up, verifies it, restores into a new directory, starts that directory on the same port, and completes the full marker/reconnect/write-probe exercise. The public-VM/home-host run remains required for final evidence.

## A79: Public HTTPS Deployment Cannot Bypass The Trusted Proxy By Default

Acceptance:

- `docker-compose.azure.yml` publishes native control port `8765` on host loopback by default; public exposure requires an explicit override.
- `docker-compose.azure-https.yml` adds Caddy on public ports 80/443, forces `NADO_TRUST_PROXY=true`, and rejects missing `NADO_DOMAIN` or `NADO_TRUST_PROXY_SECRET` during Compose interpolation.
- The mounted Caddyfile forwards only to the private `control:8765` service and overwrites proxy authentication, forwarded host, protocol, and source address headers.
- Caddy certificate/config volumes are durable, while the control database remains on its independent persistent volume.
- `.env.example`, cloud-init, Azure deployment, cross-site deployment, and threat-model documentation all preserve the loopback-backend/public-edge boundary.
- `deployment check --require-https --require-proxy-auth --require-container-hardening --backend http://127.0.0.1:8765` produces a private v2 JSON deployment receipt and exits `2` if normal certificate validation, authenticated proxy evidence, forwarded HTTPS, advertised URL matching, direct-backend separation, or live non-root/read-only/capability-free Control evidence fails. Host mount source paths are omitted. It deliberately does not claim to replace external NSG/firewall evidence.
- `deployment check --overlay tailscale|wireguard --overlay-interface <name> --require-container-hardening` produces the corresponding private-overlay receipt and fails when the URL address is outside the selected overlay, is absent from the VM interface, the live Compose port is also published on wildcard/non-overlay addresses, is observed through a proxy instead of the direct path, differs from `NADO_PUBLIC_CONTROL_URL`, or the live Control hardening check fails. Tailscale ACL/WireGuard peer and public-firewall denial evidence remain operator-owned.
- `acceptance runbook` is the shared versioned source for CLI, Dashboard, HTTP, and MCP (`nado_acceptance_runbook`). It includes deployment checking, idempotent evidence initialization, both operator-only topology facts, all applicable exercises, credential revocation, and the final `--require-complete` gate exactly once. Placeholder evidence is commented and rejected by validation until edited. The final report consumes `--deployment-evidence` and rejects a wrong URL, unsupported receipt version/mode, failed check, missing required public/overlay boundary check, receipt older than 24 hours, or timestamp more than five minutes in the future.
- Automated source-invariant tests cover the loopback bind, required overlay secrets/domain, edge ports, upstream target, header-overwrite contract, and cloud-init defaults. `docker compose config` validates the base and combined definitions; `caddy validate` validates the mounted Caddyfile.

## A80: Control And Workers Expose Runtime Build Drift

Acceptance:

- Every Control process exposes a normalized runtime build record containing semantic version, positive integer protocol version, optional deployment build ID, build-ID source, and deterministic SHA-256 source fingerprint when source files are available.
- Every Worker sends the same build record during registration and heartbeat; the control store normalizes and persists it without accepting arbitrary nested runtime data.
- The fingerprint covers `package.json` and all JavaScript files below `src`, uses stable path ordering, and normalizes CRLF/LF so equivalent Windows and Linux checkouts compare equal.
- `NADO_BUILD_ID` or `NADO_GIT_COMMIT` can bind a packaged release to an immutable CI/deployment identifier. When source is available, the source fingerprint remains authoritative for detecting code drift even if an operator accidentally reuses the same build ID.
- Status, Workers CLI, capabilities, Dashboard topology, and Worker detail display the Control build and per-Worker compatibility. Equal comparable evidence is `compatible`; differing source/build/version evidence is `build_mismatch`; differing protocol versions are `protocol_mismatch`; absent legacy evidence is `unknown`.
- Scheduler scoring, explicit targets, session affinity, dry-run dispatch planning, and Worker claim all reject a known protocol mismatch. Claim-time revalidation refreshes a previously queued target task with one durable `protocol_incompatible` event and an actionable upgrade hint instead of leaving it silently unclaimable.
- Build drift does not silently reject ordinary HTTP calls, but the strict cross-site report requires exact comparable evidence: `compatible` passes, `build_mismatch`/`protocol_mismatch` fail, and missing legacy evidence remains pending. Operators must deploy Control and the selected Worker from the same build before final WAN acceptance.
- Unit and integration tests cover deterministic/line-ending-neutral fingerprints, source changes, explicit build IDs, all compatibility states, Worker persistence, capabilities, and Dashboard rendering.

## A81: Installed Home Workers Have A Safe Upgrade And Rollback Path

Acceptance:

- Fixed-ID and self-service bundle manifests record the configured Worker data directory, exact runtime build evidence, and machine-readable drain/identity-preservation/restart/rollback invariants.
- Production guidance requires one absolute, user-protected data directory outside replaceable runtime folders. Initial install, upgrade, and rollback reuse that path so the Worker ID, signing key, session workspaces, partial transfers, and diagnostics are not copied into or lost with a runtime bundle.
- Generated start scripts export the bundle's non-secret build ID. After restart, Control can bind the new Worker process to the bundle manifest and detect a stale or wrong runtime through the normal build compatibility checks.
- The operator drains the Worker and waits for zero running slots, extracts rather than overwrites the new runtime, and runs the new runtime's offline `worker inspect --require-identity` before switching. Old and new processes must never use the shared data directory concurrently.
- Re-running the systemd installer replaces the unit path then restarts the service; the Windows installer stops an existing scheduled task before replacement/start; the macOS installer boots out and replaces the current-user LaunchAgent. No generated service definition contains a Worker token or signing private key.
- Upgrade success requires a new runtime/build heartbeat and target-pinned Doctor/Agent self-test before resume. Rollback re-runs the previous bundle installer against the unchanged data directory; the old runtime is retained until verification passes.
- Uninstall output identifies the configured retained data directory on every platform, and macOS logs follow that directory rather than silently returning to the extracted bundle.
- Generated shell and PowerShell scripts pass syntax validation. Tests assert restart ordering, stable data path propagation, build-ID propagation, manifest invariants, credential absence, rollback guidance, and both fixed-ID and self-service bundle behavior.

## A82: One Control Process Owns The Embedded Store

Acceptance:

- `control start` acquires a heartbeat lease inside the configured data directory before loading JSON or SQLite state. A second Control using the same directory fails fast even when it selects another TCP port.
- Every state commit checks the current lease before writing the temporary snapshot and again immediately before atomic replacement. After a stale lease is reclaimed, the old process is fenced from persisting its in-memory state and shuts down its HTTP/recovery loops when ownership loss is observed.
- Graceful `SIGINT`/`SIGTERM` flushes pending audit delivery and releases the lease. Hard-crash recovery waits for the bounded lease timeout; stale/released lease metadata is excluded from verified backups.
- `/api/status`, `/api/capabilities`, `nado status`, and Dashboard topology expose `owned` plus write-fencing state without exposing the lease token or data path. Strict cross-site acceptance requires this state together with SQLite.
- Tests cover concurrent startup rejection, normal release/restart, stale takeover, old-store fencing, and backup exclusion with Windows-compatible filesystem behavior.
