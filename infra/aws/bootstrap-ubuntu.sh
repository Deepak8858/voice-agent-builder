#!/usr/bin/env bash
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl unzip
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
  "$(dpkg --print-architecture)" "${VERSION_CODENAME}" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# The deploy workflow drives `docker compose` over SSH as the login user, so
# that user needs docker socket access without sudo.
usermod -aG docker ubuntu

# The deploy workflow authenticates to ECR on the host with
# `aws ecr get-login-password`, which is not part of the base AMI. The
# instance profile supplies the credentials.
if ! command -v aws >/dev/null 2>&1; then
  arch="$(uname -m)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
  rm -rf /tmp/awscliv2.zip /tmp/aws
fi

install -d -m 0750 -o root -g docker /opt/voiceforge

cat <<'SUMMARY'
=== VoiceForge bootstrap outputs ===
Docker service: enabled
Docker Compose plugin: installed
Deploy user docker access: ubuntu added to docker group
AWS CLI: installed
Application directory: /opt/voiceforge
=== End bootstrap outputs ===
SUMMARY
