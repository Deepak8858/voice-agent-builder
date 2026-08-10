#!/bin/bash
# =============================================================================
# VoiceForge AI — retired in-host deployment script
# =============================================================================
# This ran on the EC2 instance during the pre-migration pipeline. It pulled the
# mutable `latest` tag from an ap-south-1 registry using docker-compose.prod.yml,
# a compose file that no longer exists. It is kept only as a signpost and
# refuses to run.
#
# Its role is now performed inside the deploy workflow, which additionally
# validates the environment, runs migrations before replacement, keeps a
# rollback bundle per release, and verifies health afterwards.
# =============================================================================

set -euo pipefail

cat >&2 <<'NOTICE'
infra/scripts/deploy-ec2.sh has been retired and does nothing.

The deployment steps now live in .github/workflows/deploy-aws-ec2.yml, which
executes them over SSH against /opt/voiceforge using the exact commit SHA. There
is no separate script to copy onto the host.

See docs/RUNBOOK.md for the deployment and rollback procedure.
NOTICE
exit 1
