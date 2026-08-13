#!/bin/bash
# =============================================================================
# VoiceForge AI — retired SSL setup script
# =============================================================================
# This issued a certificate for a default voiceforge.ai domain by starting a
# long-lived certbot container bound to ports 80 and 443. On the current host
# those ports belong to nginx, so running it would either fail to bind or take
# the site down. It is kept only as a signpost and refuses to run.
# =============================================================================

set -euo pipefail

cat >&2 <<'NOTICE'
infra/scripts/setup-ssl.sh has been retired and does nothing.

TLS is bootstrapped through nginx itself. Until a certificate exists nginx
serves the app over HTTP and answers the ACME webroot; once the certificate is
present its entrypoint hook enables the TLS server and redirects plain HTTP.

Follow infra/nginx/TLS-BOOTSTRAP.txt to issue the first certificate. Renewal is
handled by the voiceforge-certbot-renew systemd timer, which the deploy workflow
installs and enables; no cron entry and no standing certbot container are used.
NOTICE
exit 1
