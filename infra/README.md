# VoiceForge AI — Infrastructure

## Structure

```
infra/
├── docker/
│   ├── Dockerfile.api      # NestJS container
│   ├── Dockerfile.web       # Next.js container
│   ├── docker-compose.yml   # Local dev
│   └── docker-compose.prod.yml  # Production (EC2)
├── nginx/
│   └── nginx.conf           # Reverse proxy config
└── scripts/
    ├── setup-ec2.sh         # First-time EC2 setup
    ├── deploy-ec2.sh        # GitHub Actions SSH script
    └── setup-ssl.sh         # Let's Encrypt certbot
```

## Quick Start

### Local Development

```bash
cd infra/docker
docker compose up --build
```

### EC2 Deployment

```bash
# One-time EC2 setup
chmod +x infra/scripts/setup-ec2.sh
./infra/scripts/setup-ec2.sh

# Copy .env file
scp -i ~/.ssh/voiceforge_ec2.pem .env ubuntu@13.234.56.188:/opt/voiceforge/.env

# Deploy via GitHub Actions (recommended)
# Push to main/staging → CI/CD pipeline runs automatically
```

## GitHub Actions Secrets

Required secrets:
- `AWS_EC2_HOST` → `13.234.56.188`
- `AWS_EC2_USER` → `ubuntu`
- `AWS_EC2_SSH_KEY` → SSH private key
- `AWS_ROLE_ARN` → IAM role ARN for OIDC
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` → Clerk publishable key

Required variables:
- `AWS_ACCOUNT_ID` → AWS account ID
- `AWS_REGION` → `ap-south-1`
- `NEXT_PUBLIC_API_URL` → API URL
- `NEXT_PUBLIC_APP_URL` → App URL
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL` → `/sign-in`
- `NEXT_PUBLIC_CLERK_SIGN_UP_URL` → `/sign-up`
- `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL` → `/dashboard`
- `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL` → `/dashboard`