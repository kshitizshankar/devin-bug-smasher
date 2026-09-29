# Docker

One image (`Dockerfile`) and one Compose service (`compose.yaml`) run the service and dashboard from a fresh
clone. Without credentials it serves the offline replay ([`docs/REPLAY.md`](REPLAY.md)).

```sh
git clone https://github.com/kshitizshankar/devin-bug-smasher.git && cd devin-bug-smasher
docker compose up --build -d
curl http://127.0.0.1:8080/api/health
open http://127.0.0.1:8080/                         # or visit it in a browser
docker compose exec bug-smasher npm run replay -- next
docker compose exec bug-smasher npm run replay -- all
docker compose exec bug-smasher npm run replay -- report
docker compose exec bug-smasher npm run verify-check -- --image node:22.18.0-bookworm-slim
docker compose down                                 # keeps the data volume; add -v to remove it
```

## Image

- Build stage: `npm ci` from the lockfile and `npm run build` (the dashboard frontend).
- Runtime (`node:22.18.0-bookworm-slim`): TypeScript sources run directly by Node, `prompts/`, `replay/`, the
  built `dist/web/`, `git` and the Docker CLI. No `node_modules`, tests or build tools. The service needs no
  npm dependency at run time and still starts if `dist/web/` is missing.
- No credential is read at build time or stored in a layer; `.dockerignore` keeps `.env`, `data/`, keys and
  `.git` out of the build context.

## Service

| Setting | Value |
| --- | --- |
| Port | `127.0.0.1:${BUG_SMASHER_PORT:-8080}` on the host only |
| Listener | `HOST=0.0.0.0` inside the container (allowed only with `BUG_SMASHER_CONTAINER=true`) |
| Data | Named volume `bug-smasher-data` at `/app/data` (live store and `data/replay/`) |
| Settings | `.env` if present (optional); none are needed for replay |
| Docker | `/var/run/docker.sock` mounted, for verification in sibling containers |
| Verification workspace | `VERIFY_WORK_DIR` (default `/tmp/bug-smasher-verify`) mounted at the **same absolute path** on host and container |

The verifier asks the host daemon to bind-mount workspace paths it created inside the container; they
resolve on the host only because the path is identical on both sides. Set `VERIFY_WORK_DIR` to an absolute
host path (in the shell or `.env`) to keep the mirror across restarts.

**Docker socket privilege.** Access to the socket is equivalent to root on the host. The container needs it
only to start disposable test containers; run it only on a machine you trust with that access. Target test
containers get no credentials and lose network access after setup ([`docs/VERIFICATION.md`](VERIFICATION.md)).

## Live mode

Put the live settings in `.env` (see `.env.example`) and `docker compose up -d`. Operator commands run in the
container, for example `docker compose exec bug-smasher npm run setup -- --dry-run`.
