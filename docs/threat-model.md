# Nado Agent Threat Model

Snapshot date: 2026-08-19

## Scope and trust assumptions

Nado coordinates a trusted operator's public VM control plane and outbound-connected home or lab Workers. Administrators are trusted. Workers may be lost, revoked, temporarily compromised, or running unreliable tasks, but the current process executor is not designed to safely execute hostile code. The control plane is a single process with a JSON or SQLite-compatible embedded store.

## Assets

- Administrator, Worker, and enrollment credentials plus Worker signing private keys.
- Task prompts, commands, environment values, inputs, logs, transcripts, and artifacts.
- Worker inventory, labels, network/host telemetry, session affinity, and workspace history.
- Control-state integrity: task ownership, attempt leases, cancellation, recovery, audit records, and token revocation state.
- VM availability and home-machine CPU/GPU/disk capacity.

## Trust boundaries

1. Operator browser/CLI/MCP client to the VM control API.
2. Public HTTPS reverse proxy or private overlay to the native HTTP control listener.
3. NAT-side Worker runtime to the VM through outbound requests only.
4. Control process to its persistent volume.
5. Worker runtime to spawned shell/terminal-Agent processes and task workspaces.
6. Control/Worker processes to external LLM providers, package registries, and task-selected network services.

## Main threats and current mitigations

| Threat | Mitigations |
| --- | --- |
| Credential interception | Public deployments terminate TLS; private HTTP is allowed only inside an encrypted overlay. Remote Workers receive scoped revocable credentials instead of the administrator token. |
| Overlay listener exposed on the public NIC | The private-overlay deployment binds Docker's published Control port to the VM's `tailscale0`/`wg0` address. `deployment check --overlay` fails unless the Control URL matches a local overlay interface, the live Compose publication excludes wildcard/non-overlay addresses, and the request is direct. Tailscale ACL/WireGuard peer configuration and an Internet-side TCP denial probe remain required external evidence. |
| Stolen/replayed Worker requests | Self-service Workers register a public key and sign method/path/body hash/timestamp/nonce; token binding and nonce replay checks reject mismatches. |
| VM/Worker clock drift breaks signatures or tempts replay-window widening | Unauthenticated health exposes only server time and the public skew policy; preflight corrects for measured round trip, warns early, and fails with time-sync guidance before signed startup. Control records the latest verified signature skew, while the five-minute replay window remains fixed. |
| False assurance from gateway-wide security features | The control plane records the actual authentication mode of each successful Worker registration/heartbeat. Cross-site acceptance binds its identity gate to the selected Worker and rejects administrator or unsigned Worker authentication even when the gateway supports signed identities globally. |
| False remote-topology evidence | The control plane records the socket-observed Worker source by default and rejects loopback sources during cross-site acceptance. Forwarded source/protocol headers are trusted only when proxy mode is enabled and a distinct shared proxy secret authenticates the request; missing/invalid authentication makes Nado ignore them. Physical separation and firewall policy still require operator evidence. |
| TLS proxy bypass | The Azure base Compose binds native control to host loopback by default. Its bundled Caddy overlay is the only public listener, requires a distinct proxy secret, and overwrites proxy-auth/source/protocol/host headers before forwarding over the private Compose network. Cross-site acceptance also compares the target Worker's observed protocol instead of trusting only the advertised URL. The VM firewall must still keep backend port 8765 private. |
| Worker Agent tooling or container defaults expand the public VM attack surface | The Dockerfile has separate multi-stage targets. Azure and local Compose build the public Control from the minimal `control` target, which omits Claude CLI, Git, and Worker-only process tools; only the home/lab `worker` target installs them. The Control root filesystem is read-only and privilege gain is disabled. Its root entrypoint receives only volume-ownership, identity-switch, and capability-set-clearing privileges, then drops every capability set before launching Node as uid/gid 1000; only bounded `/tmp`, state, and audit mounts are writable. |
| Cancelling a shell wrapper leaves descendant computation running | Worker cancellation owns the process tree: Windows enumerates and force-stops descendants leaf-first, while POSIX tasks run in an isolated process group with TERM-to-KILL escalation. Graceful Worker shutdown waits for child closure and release evidence. A hard runtime crash cannot execute application cleanup, so production Workers must use the generated systemd, Scheduled Task, or launchd supervisor; hostile workloads still require a future container/VM executor. |
| Worker credential rotation failure | Only the bound signed Worker may prepare/confirm. An administrator can queue rotation but cannot obtain the replacement or private key. The live Worker waits until idle, generates and persists the replacement locally, verifies new-token acceptance plus predecessor `401`, and returns only non-secret record IDs. The old token remains valid until durable confirmation, and confirm is idempotent after a lost response. |
| Cross-Worker task/result forgery | Worker tokens are bound to one Worker ID; task writes require assigned Worker plus current live attempt; stale leases/results/artifact uploads are rejected. |
| Brute force or request flooding | Source-IP and identity fixed-window limits, bounded probe frequency, JSON size limits, artifact/input hard ceilings, and bounded output capture. Public deployments should add edge limits. |
| Browser XSS/clickjacking impact | Per-response nonce CSP without `unsafe-inline`/`unsafe-eval`, frame denial, MIME sniffing/referrer/permissions restrictions, no-store responses, safe text-oriented rendering, and no browser-storage persistence for the administrator token. |
| Token leakage through logs/audit | Audit stores no request body/raw token, fingerprints the administrator identity, uses Worker token record IDs, and sanitizes known bearer/token patterns. CLI export and the optional external NDJSON mirror use mode `0600` on Unix; sink status never exposes its host path. |
| Duplicate execution after WAN failure | Explicit at-least-once contract, attempt leases, stale-write rejection, bounded retry/backoff, and idempotent submission keys. External side effects still require application-level idempotency. |
| Corrupt or partial cross-site files | Offset-based resume, per-chunk and whole-file SHA-256, atomic finalization, ranged downloads, attempt ownership, and persisted offsets. |
| VM restart/data loss | SQLite deployment default, persistent volume, explicit schema/state migration, restart recovery, graceful audit flush, and offline backup/restore with a per-file SHA-256 manifest. A heartbeat data-directory lease rejects concurrent embedded-store writers; commit-time fencing prevents a stale pre-takeover process from replacing the new owner's snapshot. |
| Administrator token captured from service logs or backups | Configured tokens are redacted from Control/quickstart output. Remote-facing implicit generation fails closed; explicit generation uses exclusive private files outside the backed-up Control data directory. Quickstart no longer embeds configured tokens in printed example commands and disables Dashboard token injection when remotely advertised. |
| Compromised Worker executes beyond task scope | Per-task workspaces and optional isolated environment reduce accidental leakage, but strong containment requires a dedicated OS account, container, VM, or future executor sandbox. |
| Persistent Worker service gains excess host privilege | The generated systemd installer refuses an implicit root Worker and runs as the invoking/dedicated Agent login; the Windows task uses the current interactive user instead of SYSTEM; the macOS installer refuses root and creates a per-user LaunchAgent rather than a LaunchDaemon. Existing terminal-Agent credentials stay in their owning profile without being copied into a second service account. Operators should dedicate that account and protect the extracted bundle plus `.nado` directory. |
| Worker upgrade loses identity, races an active lease, or strands rollback | Production bundles use one operator-selected absolute data directory outside replaceable runtime folders. The documented flow drains first, validates identity with the new runtime before switching, restarts only one installed service, verifies the new build and target-pinned Doctor before resume, and retains the previous runtime for rollback against the unchanged data. Bundle/service manifests contain no private key; operators must protect the shared data directory and must never run old and new runtimes against it concurrently. |

## Residual risks

- The administrator bearer token has broad control-plane authority; there is no tenant/project RBAC yet.
- Shell and terminal-Agent tasks inherit the Worker user's OS permissions and may access host/network resources available to that account.
- The administrator token remains readable by page JavaScript while the Dashboard is open; an origin-level XSS could act with that authority despite the lack of persistent browser storage.
- Fixed-window rate-limit state is per control process and not shared across future replicas.
- In-store audit retention is bounded to 5,000 events. The optional NDJSON mirror supplies a bounded external append stream and exposes any failed/dropped delivery as incomplete integrity, but backfill, retention, integrity protection, rotation, transport, and access controls remain operator/log-platform responsibilities.
- The embedded store is deliberately single-writer. Its lease/fencing prevents accidental concurrent writers but is not active/active, consensus, or Byzantine fault tolerance.
- A malicious task can cause external side effects before connectivity loss; Nado cannot provide exactly-once semantics for arbitrary commands.
- DNS, certificate reachability, VM/NSG hardening, backups, non-bundled proxy variants, and external LLM credential handling remain operator responsibilities.

## Operational response

1. For routine expiry of a running Worker, use `nado worker manage --action rotate_token --wait`; use direct `worker token rotate` only when the Worker process is stopped or concurrency is otherwise excluded. For suspected compromise, revoke immediately and pause or drain the Worker instead of using the overlap flow.
2. Export the audit trail, preserve the external NDJSON mirror when configured, and retain the VM/control-volume snapshot before pruning history.
3. Inspect Worker events, task attempt history, lease transitions, artifacts, and routing decisions.
4. Rotate administrator credentials with an overlap window through `NADO_ADMIN_TOKENS`, then remove the old token.
5. Rebuild/re-enroll the Worker with a new local signing key when host compromise is possible.
6. Run `doctor`, `verify --all-workers`, and the credential-rotation/old-token-rejection acceptance scenario before returning the site to service.
