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
- `node ./src/cli.js events <task-id>` lists lifecycle and output events.
- HTTP clients can use `GET /api/tasks/<task-id>/events` to fetch task events without full task detail.
- MCP includes `nado_list_task_events` for control-side agents that need task event supervision without fetching full task detail.
- Automated tests verify stdout/stderr events are observable before task completion.

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
- Inventory includes Node.js and attempts Git, GitHub CLI, Codex CLI, Claude CLI, and NVIDIA GPU probes.
- Worker capabilities merge manual capabilities with inferred capabilities such as `shell`, `git`, `agent`, `github`, and `gpu`.
- GPU diagnostics report whether the `gpu` capability came with an observed NVIDIA/ROCm probe or is advertised-only, and advertised-only GPU workers produce an operator warning in Demo Health.
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
- Automated tests verify offline task discovery, requeue to a healthy worker, successful completion, stale result/event rejection, and the lost worker staying offline.

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

## A29.1.1: Portable Worker Bundles Can Onboard Hosts Without A Preexisting Checkout

Acceptance:

- CLI exposes `nado worker bootstrap-bundle --control URL --out ./nado-worker-bootstrap.zip` as the preferred self-service onboarding path.
- Bootstrap bundles start with `worker bootstrap-start`; the remote worker generates a local keypair, sends its public key to `POST /api/workers/enroll`, receives a worker-scoped token, stores its assigned worker ID locally, and then starts the normal worker runtime with signed worker requests.
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
- Existing task environment variables remain available, including `NADO_TASK_ID`, `NADO_SESSION_ID`, `NADO_WORKER_ID`, `NADO_WORKSPACE`, `NADO_AGENT_TRANSCRIPT`, and `NADO_HOSTNAME`.
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
- Tool names are normalized, including `github`/`github-cli` to `gh` and `nvidia-smi` to `nvidiaSmi`.
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
- The dashboard can send worker management actions, including shutdown, through the existing worker management API.
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
