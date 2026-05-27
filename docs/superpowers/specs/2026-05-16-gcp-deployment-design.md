---
name: GCP Deployment Design
description: Production deployment of VoiceForge AI to GCP VM with Docker, CI/CD
type: project
---

# VoiceForge AI — GCP Deployment Design

## Context

Deploy VoiceForge AI monorepo to GCP VM (34.55.40.175, us-central1-f) for production use. Domain: vocal.devdeepak.me. No CI/CD currently. Supabase already in use.

## Infrastructure

| Component | Method | Notes |
|-----------|--------|-------|
| VM | GCP Compute Engine (existing) | Ubuntu 24.04, 8GB RAM, 48GB disk |
| Container runtime | Docker + Docker Compose | Installed fresh on VM |
| Web app | Next.js in Docker | Port 3000, standalone output |
| API | NestJS in Docker | Port 4000, Prisma + Redis |
| Redis | Docker container | Bundled in compose |
| Nginx | Docker nginx:alpine | Reverse proxy + SSL |
| SSL | Let's Encrypt via certbot | Auto-renewal |
| Database | Supabase (existing) | No VM-level DB needed |
| Monitoring | Prometheus + Grafana | Bundled in compose |

## CI/CD Flow

```
Developer push → GitHub Actions
├── Build Docker images (web + api)
├── Push to GCP Artifact Registry (gcr.io/project-xxx/voiceforge-{web,api})
└── SSH to VM → docker compose pull + restart

Artifact Registry repos:
- gcr.io/project-0d572704-81fc-488d-94b/voiceforge-web
- gcr.io/project-0d572704-81fc-488d-94b/voiceforge-api
```

## File Changes

| File | Action | Purpose |
|------|--------|---------|
| `infra/docker/docker-compose.gcp.yml` | Create | GCP-targeted compose (Artifact Registry) |
| `infra/docker/docker-compose.prod.yml` | Adapt | Remove ECR refs, keep structure |
| `.github/workflows/deploy-gcp.yml` | Create | GitHub Actions CI/CD workflow |
| `.env.production` | Create | Production env for VM (gitignored) |

## Steps

1. Install Docker on VM
2. Create Artifact Registry repos
3. Configure DNS A record (vocal.devdeepak.me → 34.55.40.175)
4. Create .env.production on VM
5. Clone repo to VM at /opt/voiceforge
6. Create docker-compose.gcp.yml
7. Run initial container deploy (docker compose up -d)
8. Configure certbot for Let's Encrypt SSL
9. Set up GitHub Actions secrets + workflow
10. Verify domain + SSL + health endpoints

## Success Criteria

- [ ] vocal.devdeepak.me loads web app
- [ ] API health at /api/v1/health returns 200
- [ ] SSL cert valid (HTTPS green)
- [ ] GitHub Actions deploys on push to main
- [ ] Prometheus metrics accessible at /prometheus/
- [ ] Grafana accessible at /grafana/
