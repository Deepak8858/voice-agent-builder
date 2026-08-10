# =============================================================================
# VoiceForge AI — retired deploy script (PowerShell)
# =============================================================================
# This deployed to the pre-migration EC2 host in ap-south-1 by building images
# on the server and pushing the mutable `latest` tag. It is kept only as a
# signpost and refuses to run.
#
# It is not merely outdated, it is unsafe: it targeted a different AWS account
# and host, and `latest` cannot identify which commit is in production, which is
# exactly what the SHA-tagged pipeline exists to guarantee.
# =============================================================================

$ErrorActionPreference = "Stop"

Write-Error @"
scripts/deploy.ps1 has been retired and does nothing.

Production deploys run only through the "Deploy production to AWS EC2" GitHub
Actions workflow (.github/workflows/deploy-aws-ec2.yml), dispatched with:
  git_sha             the full 40-character commit SHA to deploy
  confirm_production  the literal string deploy-production

That workflow builds on Depot, pushes immutable SHA-tagged images to ECR in
us-east-1, records a rollback bundle, and verifies health before marking the
release current. Building on the host or pushing a mutable tag bypasses all of it.

See docs/RUNBOOK.md for the deployment and rollback procedure.
"@
exit 1
