# Nado Agent Demo

This is the shortest path for checking that the MVP is usable from the control side.

## Start

```bash
NADO_TOKEN=docker-demo-token docker compose up --build
```

Open:

```text
http://127.0.0.1:59610/dashboard
```

The Docker demo auto-loads `docker-demo-token` in the Dashboard.

## Check Health

```bash
NADO_TOKEN=docker-demo-token node ./src/cli.js demo health --control http://127.0.0.1:59610
```

Expected signals:

```text
demoHealth=ok
workers=2 active=2
routeCheck=gpu status=assigned worker=docker-gpu inferred=gpu
routeCheck=ppt status=assigned worker=docker-code inferred=ppt
routeCheck=docs status=assigned worker=docker-code inferred=docs
verify=ok
```

## Try The Workbench

In the Dashboard Workbench:

1. Click `GPU 路由`, `文档任务`, or `PPT 任务`.
2. Click `预览路由` to see the selected worker and inferred capability.
3. Click `运行`.
4. Watch the terminal stream.
5. Use the result panel to inspect artifacts or download the ZIP.

The templates only prefill the prompt. They still use the real scheduler:

- GPU template should route to `docker-gpu`.
- Docs and PPT templates should route to `docker-code`.

## Verify Artifact Download From CLI

This submits a small shell task, waits for completion, lists the artifact, and downloads it back to the control side:

```bash
NADO_TOKEN=docker-demo-token node ./src/cli.js submit \
  --control http://127.0.0.1:59610 \
  --title "artifact smoke" \
  --capability code \
  --command 'printf "artifact ok from $NADO_WORKER_ID" > acceptance.txt; echo done $NADO_WORKER_ID' \
  --wait

NADO_TOKEN=docker-demo-token node ./src/cli.js artifacts <task-id> --control http://127.0.0.1:59610
NADO_TOKEN=docker-demo-token node ./src/cli.js artifact download <task-id> <artifact-id> --out ./demo-output --control http://127.0.0.1:59610
```

Use the printed task ID from the submit command and the artifact ID from the artifacts command.

## Add Another Worker

In the Workbench, click `添加工作端` to jump to the `接入` tab, then click `下载自助接入包`.

Copy the zip to an Ubuntu/WSL host and run:

```bash
bash ./start-worker.sh
```

The worker generates its own keypair, enrolls with the control server, receives a worker-scoped token, saves its worker ID locally, and starts the normal worker runtime.

If the Dashboard is opened on `127.0.0.1`, the server still tries to embed the best non-loopback LAN/IPv6 URL in downloaded bundles. For Docker-hosted control on another machine, set `NADO_PUBLIC_CONTROL_URL` first so the bundle contains the host URL instead of a container bridge address.

## Clean Demo History

In the Workbench, click `复位 Demo`.

This removes completed standalone demo tasks and completed verify/doctor diagnostic history while preserving meaningful session and batch work.

CLI equivalent:

```bash
NADO_TOKEN=docker-demo-token node ./src/cli.js demo reset --control http://127.0.0.1:59610 --dry-run
NADO_TOKEN=docker-demo-token node ./src/cli.js demo reset --control http://127.0.0.1:59610 --yes
```

Use `--keep 5` to retain the latest five completed standalone tasks, or `--no-system` when you only want to skip verify/doctor diagnostic cleanup.

## Useful CLI Checks

```bash
NADO_TOKEN=docker-demo-token node ./src/cli.js status --control http://127.0.0.1:59610
NADO_TOKEN=docker-demo-token node ./src/cli.js capabilities --control http://127.0.0.1:59610
NADO_TOKEN=docker-demo-token node ./src/cli.js context --control http://127.0.0.1:59610 --out ./.nado/AGENTS.md
```

## IPv6 Note

For remote IPv6 workers, use bracketed URLs:

```text
http://[2001:db8::10]:59610
```

For Docker-hosted control, set these before `docker compose up` when needed:

```bash
NADO_HOST=::
NADO_DOCKER_HOST_IP=::
NADO_PUBLIC_CONTROL_URL=http://[your-ipv6-address]:59610
```
