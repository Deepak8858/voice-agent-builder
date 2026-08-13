# VoiceForge AI — Azure VM Deployment Checkpoint (SUPERSEDED)

> **Status:** HISTORICAL. Superseded by the AWS EC2 migration.
> **Original date:** 2026-04-29 · **Superseded:** 2026-08-09
>
> Nothing in this document is an instruction. It describes the retired Azure
> staging VM and the state of that effort at the point it was abandoned. It is
> kept only to explain why certain code and Dockerfile decisions exist.
>
> For anything operational, use:
> - `docs/RUNBOOK.md` — current on-call, deploy, rollback, and observability
> - `infra/README.md` — current infrastructure layout and GitHub configuration
> - `infra/aws/README.md` — provisioning
> - `.github/workflows/deploy-aws-ec2.yml` — the only production deploy path
>
> **Do not run any command in this file.** The Azure resource group, VM, public
> IP, Key Vault, and the `docker-compose.prod.yml`, `Dockerfile.api` /
> `Dockerfile.web` root-level paths and `ci-cd-vm.yml` workflow it references no
> longer exist. The Dockerfiles now live under `infra/docker/` and production
> uses `infra/docker/docker-compose.aws.yml` with images pulled from ECR.

---

## What replaced it

| Then (Azure) | Now (AWS) |
|---|---|
| `Standard_D2s_v3` VM in `eastus2` | single `t3.large` in `us-east-1`, account `543777713748` |
| Images built on the VM with `docker build` | built by Depot, pushed to ECR, tagged with the full commit SHA |
| `docker-compose.prod.yml` | `infra/docker/docker-compose.aws.yml` |
| `vocal.devdeepak.me` | `deep-ak.dev` |
| Azure Key Vault + VM managed identity | `/opt/voiceforge/.env` on the host + EC2 instance profile for S3 |
| `certbot --nginx` on the host | containerised nginx with a two-state TLS entrypoint and a certbot renewal systemd timer |
| Application Insights, Log Analytics | PostHog, CloudWatch, and capped `json-file` container logs |
| `ci-cd-vm.yml` / `deploy-azure-vm.yml` | `deploy-aws-ec2.yml`, `workflow_dispatch`-only |

Supabase Postgres was and remains external to the compute stack, and was not
affected by the migration.

---

## Why this record is still useful

The blocker that dominated this checkpoint was a real, non-Azure-specific
problem: **`lightningcss` has no prebuilt binary for musl**, so a Next.js 16 +
Tailwind v4 web image cannot be built on Alpine:

```
Error: Cannot find module '../lightningcss.linux-x64-musl.node'
```

That is why the web image is built on a glibc Debian base rather than Alpine.
Do not "simplify" the web Dockerfile back to Alpine — it will fail the same way.

The other fixes recorded here (the no-op OpenTelemetry stub in
`apps/api/src/tracing.ts`, the metrics module wiring, the explicit auth DTO
types) landed on `main` long ago and are simply part of the codebase now.

The Dockerfile notes in the original table are **obsolete and were actively
harmful**: the `npm ci` → `npm install` change described there was a workaround
for the Alpine failure and was reverted during the AWS migration. The repo is
pnpm-native and installs with `pnpm --frozen-lockfile`, which is what honours the
`pnpm.overrides` in the root `package.json`. Re-introducing `npm install` would
silently drop those overrides.

---

## Closed security items

These were open action items against the Azure VM. They are closed because the
resources they refer to were destroyed, **not** because they were remediated in
place:

- The GitHub PAT exposed in plaintext CLI output during that effort must be
  treated as compromised and revoked if it has not been already. Nothing in the
  current stack uses a PAT: AWS and Depot both authenticate through GitHub OIDC.
- The Azure NSG rule that allowed SSH from `0.0.0.0/0` died with the NSG. On AWS,
  `infra/aws/provision.sh` requires an explicit `--ssh-cidr` and refuses an
  open-world value.
- The `api-test` / `web-test` placeholder containers and the VM-built images with
  hardcoded `http://<ip>` URLs no longer exist anywhere.
