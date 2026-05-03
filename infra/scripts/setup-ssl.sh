# =============================================================================
# VoiceForge AI — Let's Encrypt Setup Script
# =============================================================================
# Run this on EC2 to obtain SSL certificates via certbot.
# Usage: chmod +x infra/scripts/setup-ssl.sh && ./infra/scripts/setup-ssl.sh
# =============================================================================

set -euo pipefail

DOMAIN="${1:-voiceforge.ai}"
EMAIL="${2:-admin@voiceforge.ai}"

echo "🔒 Setting up Let's Encrypt SSL for ${DOMAIN}..."

# Create certbot directories
sudo mkdir -p /opt/voiceforge/data/certbot/conf
sudo mkdir -p /opt/voiceforge/data/certbot/www

# Pull nginx with certbot
docker run -d \
  --name certbot \
  -p 80:80 \
  -p 443:443 \
  -v /opt/voiceforge/data/certbot/conf:/etc/letsencrypt \
  -v /opt/voiceforge/data/certbot/www:/var/www/certbot \
  --restart unless-stopped \
  certbot/certbot \
  certonly --webroot -w /var/www/certbot -d ${DOMAIN} --email ${EMAIL} --agree-tos --no-eff-email

echo ""
echo "✅ Certbot container started."
echo "   Check status: docker logs certbot"
echo "   Certificates will be at: /opt/voiceforge/data/certbot/conf/live/${DOMAIN}/"