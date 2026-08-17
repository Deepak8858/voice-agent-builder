#!/bin/sh
set -eu

cert_dir=/etc/letsencrypt/live/incfrog.ai
https_config=/etc/nginx/conf.d/voiceforge-https.conf
http_config=/etc/nginx/conf.d/voiceforge-http.conf

rm -f /etc/nginx/conf.d/default.conf "$https_config"
cp /opt/voiceforge-nginx/http.conf "$http_config"

if [ -s "$cert_dir/fullchain.pem" ] && [ -s "$cert_dir/privkey.pem" ] && [ -s "$cert_dir/chain.pem" ]; then
  cp /opt/voiceforge-nginx/http-redirect.conf "$http_config"
  cp /opt/voiceforge-nginx/https.conf.template "$https_config"

  # CloudFront origin lockdown. When ORIGIN_VERIFY_SECRET is set, every HTTPS
  # request must carry the same value in X-Origin-Verify, which only the
  # CloudFront distribution injects; direct-to-origin requests get 403. The
  # marker stays a comment when the variable is unset so the stack works
  # before and without CloudFront. Port 80 is exempt on purpose: it serves
  # only the ACME webroot and the HTTPS redirect, and certbot renewals do not
  # traverse CloudFront.
  if [ -n "${ORIGIN_VERIFY_SECRET:-}" ]; then
    # The value is interpolated into nginx config; refuse anything that could
    # change config structure rather than trying to escape it.
    case "$ORIGIN_VERIFY_SECRET" in
      *[!A-Za-z0-9_-]*)
        echo "ORIGIN_VERIFY_SECRET must contain only [A-Za-z0-9_-]; refusing to start." >&2
        exit 1
        ;;
    esac
    sed -i "s|#ORIGIN_VERIFY_MARKER|if (\$http_x_origin_verify != \"${ORIGIN_VERIFY_SECRET}\") { return 403; }|" \
      "$https_config"
    echo "Origin verification is enforced on HTTPS requests." >&2
  else
    echo "ORIGIN_VERIFY_SECRET is not set; origin verification is not enforced." >&2
  fi
else
  echo "TLS certificate is not present; starting HTTP-only for ACME bootstrap." >&2
fi
