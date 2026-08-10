#!/bin/bash
# =============================================================================
# VoiceForge AI — retired EC2 setup script
# =============================================================================
# This prepared the pre-migration host: it SSHed to a hardcoded ap-south-1
# address, installed Docker from the Ubuntu archive, and initialised Docker
# Swarm, which the stack never used. It is kept only as a signpost and refuses
# to run.
# =============================================================================

set -euo pipefail

cat >&2 <<'NOTICE'
infra/scripts/setup-ec2.sh has been retired and does nothing.

Host provisioning is now performed by infra/aws/provision.sh, which creates the
us-east-1 instance together with its IAM, ECR, S3, and network resources, and
applies infra/aws/bootstrap-ubuntu.sh as user data to install Docker Engine and
the Compose plugin.

Read infra/aws/README.md before provisioning; it creates billable resources and
is run deliberately by an administrator, never by CI.
NOTICE
exit 1
