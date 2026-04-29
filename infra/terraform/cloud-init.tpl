#cloud-config
package_update: true
package_upgrade: true
packages:
  - docker.io
  - docker-compose-v2
  - curl
  - jq
  - ca-certificates
  - gnupg
  - lsb-release
  - nginx
  - certbot
  - python3-certbot-nginx
  - azure-cli

runcmd:
  # --- Docker setup ---------------------------------------------------------
  - systemctl enable docker
  - systemctl start docker
  - usermod -aG docker ${admin_user}

  # --- App directory --------------------------------------------------------
  - mkdir -p /opt/${app_name}/infra/nginx/ssl
  - mkdir -p /opt/${app_name}/logs
  - chown -R ${admin_user}:${admin_user} /opt/${app_name}

  # --- Log rotation for Docker ----------------------------------------------
  - |
    cat <<'EOF' > /etc/logrotate.d/docker-container
    /var/lib/docker/containers/*/*.log {
      rotate 5
      daily
      compress
      size=10M
      missingok
      delaycompress
      copytruncate
    }
    EOF

  # --- sysctl tuning for networking -----------------------------------------
  - |
    cat <<'EOF' >> /etc/sysctl.conf
    net.core.somaxconn = 4096
    net.ipv4.ip_local_port_range = 1024 65535
    EOF
  - sysctl -p

  # --- Install Azure Monitor Agent (if not present) -------------------------
  # The Terraform azurerm_virtual_machine_extension handles this,
  # but we ensure curl is available for any bootstrap scripts.

  # --- Harden SSH (disable password auth, reduce MaxAuthTries) --------------
  - sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
  - sed -i 's/#MaxAuthTries 6/MaxAuthTries 3/' /etc/ssh/sshd_config
  - systemctl restart sshd

  # --- Setup unattended upgrades for security patches -----------------------
  - apt-get install -y unattended-upgrades
  - dpkg-reconfigure -plow unattended-upgrades -f noninteractive

final_message: "VoiceForge VM setup complete. Ready for Docker Compose deployment."

users:
  - default
  - name: ${app_name}
    sudo: false
    groups: docker
    shell: /bin/bash
    lock_passwd: true
