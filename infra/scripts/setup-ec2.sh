#!/bin/bash
# =============================================================================
# VoiceForge AI — EC2 Deployment Script (Run once on fresh EC2)
# =============================================================================
# Run this once to set up Docker Swarm + prerequisites on voiceforge EC2.
# Usage: chmod +x infra/scripts/deploy-ec2.sh && ./infra/scripts/deploy-ec2.sh
# =============================================================================

set -euo pipefail

EC2_HOST="13.234.56.188"
EC2_USER="ubuntu"
SSH_KEY_PATH="${HOME}/.ssh/voiceforge_ec2.pem"

echo "🚀 Setting up voiceforge EC2 instance..."

# SSH connection test
echo "🔌 Testing SSH connection..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
  -i "${SSH_KEY_PATH}" "${EC2_USER}@${EC2_HOST}" "echo 'SSH OK'" || {
  echo "❌ SSH connection failed. Check key path and security group."
  exit 1
}

# Install prerequisites via SSH
ssh -o StrictHostKeyChecking=no -i "${SSH_KEY_PATH}" "${EC2_USER}@${EC2_HOST}" << 'ENDSSH'
  set -euo pipefail

  echo "📦 Installing Docker..."
  sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2

  echo "🔧 Enabling Docker..."
  sudo systemctl enable docker
  sudo systemctl start docker

  echo "🐝 Initializing Docker Swarm..."
  sudo docker swarm init --advertise-addr 127.0.0.1 || echo "Swarm already initialized"

  echo "📁 Creating deployment directory..."
  sudo mkdir -p /opt/voiceforge
  sudo chown -R ubuntu:ubuntu /opt/voiceforge

  echo "✅ EC2 setup complete"
ENDSSH

echo ""
echo "✅ EC2 ready for deployment!"
echo ""
echo "Next steps:"
echo "  1. Create .env file: scp -i ${SSH_KEY_PATH} .env ${EC2_USER}@${EC2_HOST}:/opt/voiceforge/.env"
echo "  2. Deploy stack: docker stack deploy -c /opt/voiceforge/docker-compose.prod.yml voiceforge"
echo "  3. Or use GitHub Actions CI/CD (recommended)"