# VoiceForge AI — Infrastructure

Production runs on a single EC2 instance in `us-east-1` (AWS account
`543777713748`). Images are built by Depot and stored in ECR. Postgres is
external Supabase and is not part of this stack.

## Structure

```
infra/
├── aws/
│   ├── provision.sh          # Creates the AWS foundation (run by an admin)
│   ├── bootstrap-ubuntu.sh   # EC2 user data: Docker Engine + Compose
│   ├── teardown.sh           # Destroys the foundation
│   └── README.md             # Provisioning runbook — read before running
├── docker/
│   ├── Dockerfile.api            # NestJS image
│   ├── Dockerfile.web            # Next.js image
│   ├── Dockerfile.livekit-agent  # LiveKit voice agent image
│   ├── docker-compose.yml        # Local development
│   └── docker-compose.aws.yml    # Production (EC2)
├── nginx/
│   ├── nginx.conf                # Base config and upstreams
│   ├── http.conf                 # Pre-certificate: serves the app over HTTP
│   ├── http-redirect.conf        # Post-certificate: redirects to HTTPS
│   ├── https.conf.template       # TLS server
│   ├── docker-entrypoint.d/      # Selects HTTP or HTTPS at container start
│   ├── systemd/                  # Certificate renewal service and timer
│   └── TLS-BOOTSTRAP.txt         # First-certificate procedure
└── scripts/                      # Retired pre-migration scripts; they exit 1
```

## Local development

```bash
cd infra/docker
docker compose up --build
```

`docker-compose.yml` is the local-dev stack. Production uses
`docker-compose.aws.yml`, which pulls SHA-tagged images from ECR and is never
built on the host.

## Production deployment

Deploys run only through the **Deploy production to AWS EC2** workflow
(`.github/workflows/deploy-aws-ec2.yml`). It is `workflow_dispatch`-only and
requires the full 40-character `git_sha` plus `confirm_production=deploy-production`.

Nothing deploys by pushing to a branch. See `docs/RUNBOOK.md` for the full
procedure and rollback behavior.

## Provisioning

`infra/aws/provision.sh` creates the instance, IAM roles, ECR repositories, the
knowledge S3 bucket, security group, Elastic IP, and a cost budget. It creates
billable resources, so it is run deliberately by an administrator and never by
CI. Read `infra/aws/README.md` first.

## GitHub configuration

Repository **variables**:
- `AWS_DEPLOY_ROLE_ARN` — OIDC role permitted to push to ECR
- `DEPOT_API_PROJECT_ID`, `DEPOT_WEB_PROJECT_ID`, `DEPOT_LIVEKIT_PROJECT_ID`
- `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_BILLING_MODE` — `demo` or `live`; baked into the web image

Repository **secrets**:
- `AWS_EC2_HOST`, `AWS_EC2_USER`, `AWS_EC2_SSH_KEY`, `AWS_EC2_KNOWN_HOSTS`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

AWS and Depot both authenticate through GitHub OIDC; no static cloud tokens are
stored. The workflow fails at its validation step if any of the above is unset,
rather than partway through a build or a deploy.
