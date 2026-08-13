#!/bin/sh
set -eu

cert_dir=/etc/letsencrypt/live/deep-ak.dev
https_config=/etc/nginx/conf.d/voiceforge-https.conf
http_config=/etc/nginx/conf.d/voiceforge-http.conf

rm -f /etc/nginx/conf.d/default.conf "$https_config"
cp /opt/voiceforge-nginx/http.conf "$http_config"

if [ -s "$cert_dir/fullchain.pem" ] && [ -s "$cert_dir/privkey.pem" ] && [ -s "$cert_dir/chain.pem" ]; then
  cp /opt/voiceforge-nginx/http-redirect.conf "$http_config"
  cp /opt/voiceforge-nginx/https.conf.template "$https_config"
else
  echo "TLS certificate is not present; starting HTTP-only for ACME bootstrap." >&2
fi
