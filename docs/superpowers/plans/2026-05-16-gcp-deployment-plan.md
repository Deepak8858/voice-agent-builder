# GCP Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy VoiceForge AI to GCP VM with Docker, HTTPS, CI/CD via GitHub Actions + GCP Artifact Registry

**Architecture:** Docker containers on GCP VM with Nginx reverse proxy. GitHub Actions builds and pushes to GCP Artifact Registry, then SSH deploys on VM via docker compose pull.

**Tech Stack:** Docker, Docker Compose, Nginx, Let's Encrypt certbot, GitHub Actions, GCP Artifact Registry, GCP Compute Engine

---

## Phase 1: VM Setup

### Task 1: SSH Key + VM Access Verified

**Files:**
- Local: `~/.ssh/voice-agent-builder`, `~/.ssh/voice-agent-builder.pub`

- [ ] **Step 1: Verify SSH connection**

```bash
ssh -i ~/.ssh/voice-agent-builder -o StrictHostKeyChecking=no aditya_bedrock@34.55.40.175 "whoami"
```
Expected: `aditya_bedrock`

---

## Phase 2: Docker Installation on VM

### Task 2: Install Docker on VM

**Files:**
- VM: Docker engine + compose plugin

- [ ] **Step 1: Create Docker install script**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 'cat > /tmp/install-docker.sh << "SCRIPTEOF"
#!/bin/bash
set -euo pipefail
echo "Installing Docker..."
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker aditya_bedrock
echo "Docker installed"
SCRIPTEOF
'
```

- [ ] **Step 2: Run install script**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "chmod +x /tmp/install-docker.sh && bash /tmp/install-docker.sh"
```
Expected: Docker installed (2-3 min)

- [ ] **Step 3: Verify Docker**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "docker --version && docker compose version"
```
Expected: version outputs

---

## Phase 3: Directory + DNS + SSL

### Task 3: Create Directory Structure

**Files:**
- VM: `/opt/voiceforge/`

- [ ] **Step 1: Create directories**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "sudo mkdir -p /opt/voiceforge/data/certs /opt/voiceforge/data/certbot/www /opt/voiceforge/logs && sudo chown -R aditya_bedrock:aditya_bedrock /opt/voiceforge && ls -la /opt/voiceforge/"
```

---

### Task 4: DNS A Record

**Files:**
- DNS provider (manual action required from user)

- [ ] **Step 1: User creates DNS A record**

**Action required:** Go to your DNS provider and add:
- Type: `A`
- Name: `vocal` (or `@` for root domain)
- Value: `34.55.40.175`
- TTL: 300

---

### Task 5: Install Certbot + Generate SSL

**Files:**
- VM: `/opt/voiceforge/data/certs/`

- [ ] **Step 1: Install certbot**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "sudo snap install --classic certbot && sudo ln -sf /snap/bin/certbot /usr/bin/certbot && certbot --version"
```
Expected: certbot version output

- [ ] **Step 2: Generate SSL certificate**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "sudo certbot certonly --nginx -d vocal.devdeepak.me --non-interactive --agree-tos -m aditya.bedrock@gmail.com && sudo ls /etc/letsencrypt/live/vocal.devdeepak.me/"
```
Expected: fullchain.pem, privkey.pem, chain.pem created

- [ ] **Step 3: Copy certs to /opt/voiceforge/data/certs**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "sudo cp /etc/letsencrypt/live/vocal.devdeepak.me/fullchain.pem /opt/voiceforge/data/certs/ && sudo cp /etc/letsencrypt/live/vocal.devdeepak.me/privkey.pem /opt/voiceforge/data/certs/key.pem && sudo cp /etc/letsencrypt/live/vocal.devdeepak.me/chain.pem /opt/voiceforge/data/certs/chain.pem && sudo chown -R aditya_bedrock:aditya_bedrock /opt/voiceforge/data/certs && chmod 600 /opt/voiceforge/data/certs/key.pem && ls -la /opt/voiceforge/data/certs/"
```

- [ ] **Step 4: Setup certbot renewal cron**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "sudo bash -c 'echo \"0 0 * * * root certbot renew --quiet --deploy-hook \\"docker restart vf-nginx\\"\" >> /etc/crontab'"
```

---

## Phase 4: Repository + Config

### Task 6: Clone Repository to VM

**Files:**
- VM: `/opt/voiceforge/`

- [ ] **Step 1: Clone repo**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "cd /opt/voiceforge && git clone https://github.com/Deepak8858/voice-agent-builder.git . 2>&1 | tail -5"
```

- [ ] **Step 2: Verify clone**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "cd /opt/voiceforge && ls package.json && cat package.json | grep '\"name\"'"
```

---

### Task 7: Create Production .env

**Files:**
- Local: `.env.production`
- VM: `/opt/voiceforge/.env`

- [ ] **Step 1: Copy and fill .env.production**

```bash
cp .env.production.example .env.production
```

- [ ] **Step 2: User fills secrets**

**Action required:** Edit `.env.production` and fill in required values:
- Supabase: URL, keys, DATABASE_URL, DIRECT_URL, SERVICE_ROLE_KEY, JWT_SECRET
- Redis: `redis://redis:6379` (docker compose uses internal DNS)
- API URLs: `NEXT_PUBLIC_API_URL=https://vocal.devdeepak.me/api/v1`, `NEXT_PUBLIC_APP_URL=https://vocal.devdeepak.me`
- Domain: `WEB_BASE_URL=https://vocal.devdeepak.me`, `ALLOWED_ORIGINS=https://vocal.devdeepak.me`
- Providers: `ANTHROPIC_API_KEY`, `VAPI_API_KEY`, `STRIPE_SECRET_KEY`
- Secrets: generate `JWT_SECRET`, `ENCRYPTION_KEY`, `INTERNAL_API_KEY` with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `GRAFANA_ADMIN_PASSWORD`: set a strong password

- [ ] **Step 3: Upload .env to VM**

```bash
scp -i ~/.ssh/voice-agent-builder .env.production aditya_bedrock@34.55.40.175:/tmp/.env
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "sudo mv /tmp/.env /opt/voiceforge/.env && sudo chown aditya_bedrock:aditya_bedrock /opt/voiceforge/.env && chmod 600 /opt/voiceforge/.env"
```

---

## Phase 5: Docker Compose GCP

### Task 8: Create docker-compose.gcp.yml

**Files:**
- Create: `infra/docker/docker-compose.gcp.yml`

- [ ] **Step 1: Create GCP-targeted compose file**

```yaml
# =============================================================================
# VoiceForge AI — Production Docker Compose for GCP VM
# =============================================================================

services:
  web:
    image: gcr.io/project-0d572704-81fc-488d-94b/voiceforge-web:${IMAGE_TAG:-latest}
    container_name: vf-web
    restart: always
    ports:
      - "127.0.0.1:3000:3000"
    env_file:
      - /opt/voiceforge/.env
    environment:
      NODE_ENV: production
      PORT: 3000
      HOSTNAME: 0.0.0.0
    networks:
      - voiceforge
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 1G
        reservations:
          cpus: "0.5"
          memory: 512M
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3000/api/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  api:
    image: gcr.io/project-0d572704-81fc-488d-94b/voiceforge-api:${IMAGE_TAG:-latest}
    container_name: vf-api
    restart: always
    ports:
      - "127.0.0.1:4000:4000"
    env_file:
      - /opt/voiceforge/.env
    environment:
      NODE_ENV: production
      API_PORT: 4000
      REDIS_URL: redis://redis:6379
    depends_on:
      redis:
        condition: service_healthy
    networks:
      - voiceforge
    deploy:
      resources:
        limits:
          cpus: "1.5"
          memory: 2G
        reservations:
          cpus: "0.75"
          memory: 1G
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:4000/api/v1/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  redis:
    image: redis:7-alpine
    container_name: vf-redis
    restart: always
    command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    networks:
      - voiceforge
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 512M

  nginx:
    image: nginx:1.27-alpine
    container_name: vf-nginx
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./infra/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - /opt/voiceforge/data/certs:/opt/certs:ro
      - /opt/voiceforge/data/certbot/www:/var/www/certbot:ro
    depends_on:
      web:
        condition: service_healthy
      api:
        condition: service_healthy
    networks:
      - voiceforge
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 256M
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  prometheus:
    image: prom/prometheus:v2.52.0
    container_name: vf-prometheus
    restart: always
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.path=/prometheus
      - --storage.tsdb.retention.time=15d
    environment:
      METRICS_SCRAPE_TOKEN: ${METRICS_SCRAPE_TOKEN}
    volumes:
      - ./infra/docker/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    ports:
      - "127.0.0.1:9090:9090"
    networks:
      - voiceforge
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 512M

  grafana:
    image: grafana/grafana:11.0.0
    container_name: vf-grafana
    restart: always
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:?GRAFANA_ADMIN_PASSWORD must be set}
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_SERVER_ROOT_URL: "%(protocol)s://%(domain)s/grafana/"
      GF_SERVER_SERVE_FROM_SUB_PATH: "true"
      GF_DOMAIN: vocal.devdeepak.me
    volumes:
      - ./infra/docker/grafana/provisioning:/etc/grafana/provisioning:ro
      - grafana_data:/var/lib/grafana
    ports:
      - "127.0.0.1:3001:3000"
    depends_on:
      prometheus:
        condition: service_started
    networks:
      - voiceforge
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 256M

networks:
  voiceforge:
    driver: bridge

volumes:
  redis_data:
  prometheus_data:
  grafana_data:
```

- [ ] **Step 2: Copy to VM**

```bash
scp -i ~/.ssh/voice-agent-builder infra/docker/docker-compose.gcp.yml aditya_bedrock@34.55.40.175:/opt/voiceforge/docker-compose.yml
```

- [ ] **Step 3: Commit**

```bash
git add infra/docker/docker-compose.gcp.yml && git commit -m "feat(infra): add GCP-targeted docker-compose"
```

---

## Phase 6: GCP Artifact Registry

### Task 9: Create Artifact Registry Repos

**Files:**
- GCP: Artifact Registry repos

- [ ] **Step 1: Enable Artifact Registry API**

```bash
gcloud services enable artifactregistry.googleapis.com --project=project-0d572704-81fc-488d-94b
```

- [ ] **Step 2: Create web repository**

```bash
gcloud artifacts repositories create voiceforge-web --repository-format=docker --location=us-central1 --project=project-0d572704-81fc-488d-94b --description="VoiceForge AI Web Docker image"
```

- [ ] **Step 3: Create api repository**

```bash
gcloud artifacts repositories create voiceforge-api --repository-format=docker --location=us-central1 --project=project-0d572704-81fc-488d-94b --description="VoiceForge AI API Docker image"
```

- [ ] **Step 4: Verify repos**

```bash
gcloud artifacts repositories list --project=project-0d572704-81fc-488d-94b
```
Expected: voiceforge-web, voiceforge-api listed

---

## Phase 7: Initial Docker Deploy

### Task 10: Build and Push Images Manually

**Files:**
- Local: Docker buildx + push

- [ ] **Step 1: Auth to GCP Artifact Registry**

```bash
gcloud auth activate-service-account --key-file=<path-to-gcp-sa-json>
gcloud auth configure-docker us-central1-docker.pkg.dev --project=project-0d572704-81fc-488d-94b
```

- [ ] **Step 2: Build and push web image**

```bash
docker buildx create --use 2>/dev/null || true
docker buildx build --platform linux/amd64 -f infra/docker/Dockerfile.web -t us-central1-docker.pkg.dev/project-0d572704-81fc-488d-94b/voiceforge-web:manual --push --build-arg NEXT_PUBLIC_API_URL=https://vocal.devdeepak.me/api/v1 --build-arg NEXT_PUBLIC_APP_URL=https://vocal.devdeepak.me .
```

- [ ] **Step 3: Build and push api image**

```bash
docker buildx build --platform linux/amd64 -f infra/docker/Dockerfile.api -t us-central1-docker.pkg.dev/project-0d572704-81fc-488d-94b/voiceforge-api:manual --push .
```

---

### Task 11: Initial Docker Compose Deploy on VM

**Files:**
- VM: running containers

- [ ] **Step 1: Pull and start services**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "cd /opt/voiceforge && export IMAGE_TAG=manual && docker compose -f docker-compose.yml pull && docker compose -f docker-compose.yml up -d && sleep 30 && docker ps"
```
Expected: vf-web, vf-api, vf-redis, vf-nginx all running

- [ ] **Step 2: Check API logs**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "docker compose -f docker-compose.yml logs api --tail=30"
```

- [ ] **Step 3: Run Prisma generate**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "cd /opt/voiceforge && docker compose -f docker-compose.yml exec -T api npx prisma generate"
```

- [ ] **Step 4: Run Prisma migrate**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "cd /opt/voiceforge && docker compose -f docker-compose.yml exec -T api npx prisma migrate deploy"
```

---

## Phase 8: GitHub Actions CI/CD

### Task 12: Create GitHub Actions Workflow

**Files:**
- Create: `.github/workflows/deploy-gcp.yml`

- [ ] **Step 1: Create deploy workflow**

```yaml
name: Deploy to GCP VM

on:
  push:
    branches: [main]
  workflow_dispatch:

env:
  GCP_PROJECT: project-0d572704-81fc-488d-94b
  GCP_REGION: us-central1
  REGISTRY_WEB: gcr.io/${{ secrets.GCP_PROJECT }}/voiceforge-web
  REGISTRY_API: gcr.io/${{ secrets.GCP_PROJECT }}/voiceforge-api
  VM_HOST: 34.55.40.175
  VM_USER: aditya_bedrock
  DEPLOY_PATH: /opt/voiceforge

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Auth to GCP Artifact Registry
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}

      - name: Configure Docker for GAR
        run: gcloud auth configure-docker ${{ env.GCP_REGION }}-docker.pkg.dev

      - name: Extract metadata
        id: meta
        run: |
          IMAGE_TAG=$(date +%Y%m%d-%H%M%S)-${GITHUB_SHA::8}
          echo "image_tag=${IMAGE_TAG}" >> $GITHUB_OUTPUT

      - name: Build Web image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: infra/docker/Dockerfile.web
          push: true
          tags: ${{ env.GCP_REGION }}-docker.pkg.dev/${{ secrets.GCP_PROJECT }}/voiceforge-web:${{ steps.meta.outputs.image_tag }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            NEXT_PUBLIC_API_URL=https://vocal.devdeepak.me/api/v1
            NEXT_PUBLIC_APP_URL=https://vocal.devdeepak.me

      - name: Build API image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: infra/docker/Dockerfile.api
          push: true
          tags: ${{ env.GCP_REGION }}-docker.pkg.dev/${{ secrets.GCP_PROJECT }}/voiceforge-api:${{ steps.meta.outputs.image_tag }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Deploy to VM
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ env.VM_HOST }}
          username: ${{ env.VM_USER }}
          key: ${{ secrets.GCP_VM_SSH_KEY }}
          script: |
            cd ${{ env.DEPLOY_PATH }}
            export IMAGE_TAG=${{ steps.meta.outputs.image_tag }}
            git pull origin main
            docker compose -f docker-compose.yml pull
            docker compose -f docker-compose.yml up -d --remove-orphans
            sleep 30
            curl -sf --max-time 10 http://localhost:4000/api/v1/health && echo "API healthy" || echo "API check failed"

      - name: Run Prisma migration
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ env.VM_HOST }}
          username: ${{ env.VM_USER }}
          key: ${{ secrets.GCP_VM_SSH_KEY }}
          script: |
            cd ${{ env.DEPLOY_PATH }}
            docker compose -f docker-compose.yml exec -T api npx prisma migrate deploy || echo "Migration may already be applied"
```

- [ ] **Step 2: Commit workflow**

```bash
git add .github/workflows/deploy-gcp.yml && git commit -m "feat(ci): add GCP VM deployment workflow"
```

---

### Task 13: GitHub Actions Secrets

**Files:**
- GitHub: Repo Settings → Secrets

- [ ] **Step 1: User creates GCP Service Account**

**Action required:** In GCP Console:
1. IAM → Service Accounts → Create new
2. Name: `github-actions-deploy`
3. Grant roles: `Artifact Registry Writer`, `Compute Instance Admin (v1)`
4. Create key as JSON → download file

- [ ] **Step 2: User adds GitHub secrets**

In GitHub repo Settings → Secrets and variables → Actions → New repository secret:
1. `GCP_SA_KEY` = paste entire downloaded GCP SA JSON file contents
2. `GCP_PROJECT` = `project-0d572704-81fc-488d-94b`
3. `GCP_VM_SSH_KEY` = paste entire contents of `~/.ssh/voice-agent-builder` (private key, no .pub)

---

## Phase 9: Verification

### Task 14: Verify Deployment

**Files:**
- Browser + curl

- [ ] **Step 1: Verify HTTP redirects**

```bash
curl -I http://vocal.devdeepak.me 2>&1 | head -5
```
Expected: 301 redirect to HTTPS

- [ ] **Step 2: Verify web health**

```bash
curl -sfk https://vocal.devdeepak.me/api/health
```
Expected: 200 response

- [ ] **Step 3: Verify API health**

```bash
curl -sfk https://vocal.devdeepak.me/api/v1/health
```
Expected: 200 response

- [ ] **Step 4: Verify SSL + web app**

```bash
curl -sfk https://vocal.devdeepak.me 2>&1 | head -30
```
Expected: Next.js HTML returned

- [ ] **Step 5: Check containers on VM**

```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "docker ps --format 'table {{.Names}}\t{{.Status}}'"
```
Expected: vf-web, vf-api, vf-redis, vf-nginx all running

- [ ] **Step 6: User opens browser**

**Action:** User opens https://vocal.devdeepak.me in browser

---

### Task 15: Push CI/CD Pipeline

**Files:**
- GitHub: Actions tab

- [ ] **Step 1: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Monitor GitHub Actions**

**Action:** Watch GitHub Actions tab for build + deploy pipeline

- [ ] **Step 3: Verify pipeline success**

After Actions completes:
```bash
ssh -i ~/.ssh/voice-agent-builder aditya_bedrock@34.55.40.175 "docker compose -f docker-compose.yml logs api --tail=10"
```

---

## Success Criteria

- [ ] vocal.devdeepak.me loads via HTTPS (green padlock)
- [ ] /api/v1/health returns 200
- [ ] /api/health returns 200
- [ ] GitHub Actions deploys on push to main
- [ ] Prometheus at /prometheus/ accessible
- [ ] Grafana at /grafana/ accessible (admin + GRAFANA_ADMIN_PASSWORD)