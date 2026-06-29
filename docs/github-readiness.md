# GitHub Readiness Review

This checklist is the pre-push gate for publishing Nado Agent to GitHub.

## Current Result

- The source tree is not currently a Git repository in this workspace, so there is no tracked/untracked split to audit with `git status`.
- No production API keys or private key files were found in source files outside ignored runtime output.
- The only token-like values found in publishable source are documented demo placeholders such as `dev-token`, `docker-demo-token`, `NADO_TOKEN`, and test fixtures.
- `.nado/` contains runtime state, logs, screenshots, generated worker bundles, demo task outputs, and MCP config snapshots. It must stay uncommitted.
- `docker-compose.yml` is a local demo stack. It mounts local Claude settings from the operator machine and enables dashboard token auto-load for the demo.
- `docker-compose.azure.yml` is the production-shaped VM stack. It does not mount local Claude settings, does not include demo workers, and requires explicit `.env` values.

## Do Not Publish

- `.nado/`
- `.env` and `.env.*`
- `.claude/` and `.claude.json`
- generated worker bundles such as `nado-worker-*.zip`
- downloaded artifacts such as `downloads/`, `task-output/`, `session-output/`, `batch-output/`, and `demo-output/`
- any real admin token, worker token, enrollment token, LLM API key, SSH key, TLS private key, or cloud credential

## Safe To Publish

- `src/`, `test/`, `docs/`, `deploy/`
- `README.md`, `DEMO.md`, `AGENTS.md`
- `Dockerfile`
- `docker-compose.yml` as a documented demo-only compose file
- `docker-compose.azure.yml` as the VM deployment compose file
- `.env.example` because it contains placeholders only

## Required Before First Push

1. Initialize Git only after confirming `.gitignore` is present.
2. Run the secret scan:

```bash
rg -n --hidden -S "(OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|AZURE_.*SECRET|api[_-]?key\\s*[:=]|password\\s*[:=]|-----BEGIN (RSA|OPENSSH|EC|PRIVATE) KEY-----|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})" -g "!.git" -g "!.nado" -g "!node_modules" -g "!docs/github-readiness.md"
```

3. Treat matches in docs/tests as acceptable only when they are obvious placeholders or test fixtures.
4. Run `npm test`.
5. Confirm GitHub Actions can run `npm ci`, `npm test`, the secret scan, compose config validation, and Docker image build.
6. Do not commit runtime output from `.nado/`; if a Git repo already exists elsewhere, confirm with `git status --short --ignored`.

## Production Security Notes

- Replace all demo tokens. `dev-token` and `docker-demo-token` are examples only.
- Rotate admin tokens by temporarily setting `NADO_ADMIN_TOKENS` to both old and new comma-separated values, updating clients, then removing the old token.
- Do not run production with `NADO_DASHBOARD_AUTO_TOKEN=true` or `--dashboard-auto-token`.
- Do not put `NADO_TOKEN` in process command-line arguments for production services. Use the `.env` file, VM secret management, or an orchestrator secret mechanism.
- Use `NADO_STORE=sqlite` for VM deployments. JSON remains useful for local development and small disposable demos.
- Prefer HTTPS through a reverse proxy or Azure Application Gateway when the dashboard is reachable from the public internet.
- Restrict inbound Azure NSG rules to trusted operator and worker source ranges whenever possible.
- Generate remote workers through self-service bootstrap bundles so each worker receives its own signed identity and revocable worker token.
