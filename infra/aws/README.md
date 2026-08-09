# VoiceForge AWS foundation runbook

This directory provisions the VoiceForge production foundation in `us-east-1` for AWS account `543777713748`. The scripts are intentionally not run by CI. Provisioning creates billable resources and must be performed interactively by an authorized administrator.

## 1. Harden IAM before provisioning anything else

The current root identity has unrestricted, non-delegable control of the account. A leaked root access key can disable billing controls, delete every workload, change account recovery details, and lock out all delegated administrators. Root activity also prevents meaningful least-privilege attribution. Complete these steps first:

1. Sign in as the root user in the AWS console and open **IAM → Security recommendations**.
2. Create an IAM administrative user dedicated to the human administrator. Grant administrative access through an `Administrators` group rather than attaching permissions directly to the user. AWS IAM Identity Center is preferable when available; this account bootstrap may use an IAM user.
3. Create that administrator's console password without embedding it in scripts, shell history, repository files, or chat. Require password reset at first sign-in.
4. Register a hardware security key or authenticator app as MFA for the new administrator. Sign out, sign in as that user, and verify administrative access before changing root credentials.
5. Return to the root account and register at least one root MFA device. Store recovery factors in a controlled location separate from the device.
6. Delete every root access key under **Security credentials**. Root access keys must not be retained for routine AWS CLI use.
7. Sign out of root and use only the MFA-protected administrator identity for this runbook. Keep root exclusively for the small set of account-level tasks that require it.
8. Enable account contact and billing-alert hygiene, then review CloudTrail events after provisioning so actions are attributable to the administrator rather than root.

Do not continue while the CLI is configured with root access keys.

## 2. Prerequisites

- AWS CLI v2 configured for the hardened administrator.
- An existing EC2 key pair in `us-east-1`; the script never creates or prints private key material.
- Your current public IPv4 address expressed as exactly `x.x.x.x/32`. The provisioner validates every octet, rejects broader networks, and reconciles the complete ingress ruleset on rerun.
- A monitored email address for AWS Budgets notifications. AWS may require the recipient to confirm the subscription.
- Bash for running the scripts. Authoring on Windows is supported, but execute using a Unix-compatible shell with LF line endings.

The deterministic uploads bucket is `voiceforge-knowledge-543777713748-us-east-1`. Application objects are restricted to the `knowledge/` prefix. Configure `KNOWLEDGE_STORAGE_PROVIDER=s3`, this bucket as `S3_KNOWLEDGE_BUCKET`, region `us-east-1`, and `S3_KNOWLEDGE_PREFIX=knowledge`; do not make objects public. The API fails at boot when S3 is selected without a bucket.

## 3. Provision

Review the complete diff and script before execution. Then run:

```bash path=null start=null
cd infra/aws
chmod +x provision.sh teardown.sh bootstrap-ubuntu.sh
./provision.sh \
  --ssh-cidr "203.0.113.10/32" \
  --key-name "voiceforge-admin" \
  --budget-email "aws-billing@example.com" \
  --monthly-budget-usd "100"
```

Rerunning is supported. Resources use deterministic names and are updated toward the declared configuration. The script resolves the current Canonical Ubuntu 24.04 amd64 gp3 AMI through the public SSM parameter; it does not hardcode an AMI ID. It creates:

- GitHub Actions OIDC provider and `VoiceForgeGitHubDeployRole`, trusted only for the `production` environment in `Deepak8858/voice-agent-builder` with the `sts.amazonaws.com` audience.
- Immutable, scan-on-push ECR repositories for API, web, and LiveKit agent SHA-tagged images, retaining the newest 10 images.
- Private, versioned, AES-256-encrypted S3 storage with public access blocked and non-TLS requests denied.
- Web ingress on ports 80/443 and restricted SSH ingress on port 22.
- `VoiceForgeEc2Profile`, with ECR pull permissions for only the three repositories and S3 object access only under the bucket's `knowledge/` prefix.
- One encrypted 30 GiB gp3-backed `t3.large`, requiring IMDSv2, bootstrapped with Docker Engine and Compose under `/opt/voiceforge`.
- One tagged Elastic IP associated with the instance.
- A monthly cost budget with an 80% forecast notification.

The final labeled output block contains the values needed for GitHub repository secrets/variables. It contains resource identifiers only and no credentials. Capture it in an approved operational record; never add credentials, private keys, GitHub secrets, Stripe keys, or application environment files to command output.

Operational caveat on immutable tags: because the repositories reject tag overwrites, pushing an image tag that already exists fails. This is intentional, since it guarantees a given SHA tag always refers to one image. It does mean re-running a deploy for a commit whose images were already pushed must either skip the push or tolerate that failure rather than retagging. Deployment-pipeline behavior is owned outside this directory; flag it there rather than relaxing immutability here.

## 4. Post-provision checks

1. Confirm the budget email subscription if AWS sends a confirmation request.
2. Verify the EC2 instance reports both system and instance status checks as passed.
3. Connect using the existing private key and the printed Elastic IP. Do not loosen SSH ingress if access fails; update `--ssh-cidr` and rerun instead.
4. On the host, verify `docker version`, `docker compose version`, and ownership/mode of `/opt/voiceforge`.
5. Populate GitHub with the printed deploy-role ARN, region, ECR URIs, instance address, bucket name, and bucket prefix. Treat SSH private keys and application environment values as secrets even though resource IDs are not secret.
6. Leave the LiveKit agent disabled until its environment exists. The AWS foundation does not require LiveKit configuration.

## 5. Teardown

Teardown permanently deletes images, all current and historical versions of uploaded knowledge files, the instance, and related resources. Export or retain anything required before running it. The exact account-ID argument is a deliberate guard:

```bash path=null start=null
cd infra/aws
./teardown.sh --confirm-account-id 543777713748
```

Before any destructive call, teardown verifies that the live AWS caller account matches both the hard-coded target and `--confirm-account-id`. Instance, Elastic IP, and security-group discovery is also constrained by the VoiceForge project tags and intended VPC where supported.

The administrator user and root MFA are deliberately not removed. The teardown is rerunnable and reports the identifiers it found or deleted. If AWS reports dependency violations, inspect the named resource rather than broadening permissions or deleting unrelated infrastructure.
