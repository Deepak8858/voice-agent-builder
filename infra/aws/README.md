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

- GitHub Actions OIDC provider and `VoiceForgeGitHubDeployRole`, trusted only for the `production` environment in `Deepak8858/voice-agent-builder` with the `sts.amazonaws.com` audience. Its inline policy is written after the security group exists, because one statement must name that group's ARN; see "Just-in-time SSH ingress" below.
- Immutable, scan-on-push ECR repositories for API, web, and LiveKit agent SHA-tagged images, retaining the newest 10 images.
- Private, versioned, AES-256-encrypted S3 storage with public access blocked and non-TLS requests denied.
- Web ingress on ports 80/443 and restricted SSH ingress on port 22.
- `VoiceForgeEc2Profile`, with ECR pull permissions for only the three repositories and S3 object access only under the bucket's `knowledge/` prefix.
- One encrypted 30 GiB gp3-backed `t3.large`, requiring IMDSv2, bootstrapped with Docker Engine and Compose under `/opt/voiceforge`.
- One tagged Elastic IP associated with the instance.
- A monthly cost budget with an 80% forecast notification.

The final labeled output block contains the values needed for GitHub repository secrets/variables. It contains resource identifiers only and no credentials. Capture it in an approved operational record; never add credentials, private keys, GitHub secrets, Stripe keys, or application environment files to command output.

Operational caveat on immutable tags: because the repositories reject tag overwrites, pushing an image tag that already exists fails. This is intentional, since it guarantees a given SHA tag always refers to one image. It does mean re-running a deploy for a commit whose images were already pushed must either skip the push or tolerate that failure rather than retagging. Deployment-pipeline behavior is owned outside this directory; flag it there rather than relaxing immutability here.

## 4. CloudFront CDN

`infra/aws/provision-cloudfront.sh` puts Amazon CloudFront in front of the production instance. Like `provision.sh`, it is idempotent and rerunnable: every resource is discovered before it is created or updated, so a rerun converges toward the declared configuration instead of duplicating anything.

```bash path=null start=null
cd infra/aws
./provision-cloudfront.sh              # certificate, origin record, distribution, cutover
./provision-cloudfront.sh --lockdown   # later: restrict 443 to CloudFront's address ranges
```

### What it creates

- An ACM certificate in `us-east-1` for `incfrog.ai` with SAN `www.incfrog.ai`, DNS-validated. The validation CNAMEs are upserted into the Route 53 hosted zone automatically and the script waits until the certificate is `ISSUED`. CloudFront only accepts `us-east-1` certificates, which is why the region is not configurable.
- A simple A record `origin.incfrog.ai` → the Elastic IP (TTL 300, upsert). This gives CloudFront a stable origin name that always bypasses the CDN; nginx already includes `origin.incfrog.ai` in its `server_name` sets.
- One distribution, comment `voiceforge-production`, tagged `Project=VoiceForge`, rediscovered on rerun by scanning for an alias on `incfrog.ai`. Aliases `incfrog.ai` and `www.incfrog.ai`; viewer certificate is the ACM certificate, SNI-only, minimum `TLSv1.2_2021`; HTTP/2 and HTTP/3 enabled, IPv6 enabled, `PriceClass_All`, no logging, no default root object.
- The origin is `origin.incfrog.ai` as a custom origin: HTTPS-only on port 443, origin SSL protocol TLSv1.2, read timeout 60s, keepalive 60s. CloudFront attaches a custom origin header `X-Origin-Verify` carrying a generated secret; on rerun the script reuses the secret already present in the existing distribution config, so CloudFront and nginx never drift apart.
- The default cache behavior forwards everything: viewer protocol `redirect-to-https`, all methods (`GET,HEAD,OPTIONS,PUT,POST,PATCH,DELETE`), managed cache policy `CachingDisabled` (`4135ea2d-6df8-44a3-9df3-4b5a84be39ad`), managed origin request policy `AllViewer` (`216adef6-5c7f-47e4-b989-5492eafa07d3`). `AllViewer` is required, not a convenience: it passes cookies, query strings, and the viewer `Host` header through, and nginx routes by `Host` while the app validates request origins. Without it every request would arrive as `origin.incfrog.ai` and be rejected.
- Additional cache behaviors use the exact configuration below. `CachingOptimized` is `658327ea-f89d-4fab-a63d-7e88639e58f6`; `AllViewer` is `216adef6-5c7f-47e4-b989-5492eafa07d3`.

| Precedence | Path pattern | Allowed methods | Viewer policy | Compress | Cache policy | Origin request policy |
|-----------:|--------------|-----------------|---------------|----------|--------------|-----------------------|
| 1 | `/_next/static/*` | `GET,HEAD,OPTIONS` | `redirect-to-https` | true | `CachingOptimized` | `AllViewer` |
| 2 | `/fonts/*` | `GET,HEAD,OPTIONS` | `redirect-to-https` | true | `CachingOptimized` | `AllViewer` |
| 3 | `/images/*` | `GET,HEAD,OPTIONS` | `redirect-to-https` | true | `CachingOptimized` | `AllViewer` |
| 4 | `/favicon.ico` | `GET,HEAD,OPTIONS` | `redirect-to-https` | true | `CachingOptimized` | `AllViewer` |

- The Route 53 cutover: alias A and AAAA records for `incfrog.ai` and `www.incfrog.ai` are upserted to the distribution domain, but only after the distribution reports `Deployed`, and only after a single interactive yes/no confirmation read from the terminal. Everything before the cutover is invisible to production traffic.

### Required execution order

The order matters; each step depends on the previous one being verified.

1. Run `./provision-cloudfront.sh`. Decline the cutover prompt on the first pass if you want to test first.
2. Test through the distribution domain **before** any DNS change, using the viewer `Host` header the app expects:

   ```bash path=null start=null
   curl -sSI -H "Host: incfrog.ai" https://dXXXXXXXXXXXXX.cloudfront.net/
   ```

   A correct response here proves the whole chain — certificate, origin routing, Host forwarding — without touching production DNS.
3. Rerun the script and confirm the cutover so the apex and `www` aliases point at the distribution.
4. Add `ORIGIN_VERIFY_SECRET=<value>` to `/opt/voiceforge/.env` on the host (see secret handoff below) and recreate nginx so it starts enforcing the header:

   ```bash path=null start=null
   docker compose -f /opt/voiceforge/docker-compose.aws.yml up -d --force-recreate nginx
   ```

   Do this only after the cutover; if nginx enforces the header while DNS still points browsers directly at the instance, every direct request is rejected with 403.
5. Run `./provision-cloudfront.sh --lockdown` last. It replaces the security group's 443 `0.0.0.0/0` ingress rule with the managed prefix list `com.amazonaws.global.cloudfront.origin-facing` (its `pl-` ID is discovered at runtime), leaving port 80 and SSH untouched. It requires the distribution to already exist and refuses to run if the prefix-list rule would exceed the security group rule quota. After lockdown, only CloudFront's origin-facing address ranges can reach 443 directly.

### Secret handoff

The origin-verify secret authenticates CloudFront to nginx and must never appear in stdout, shell history, or the repository. The script therefore prints nothing secret; it writes the value to `origin-verify-secret.txt` (mode 600) in the current directory. Handle it like a private key:

1. `scp` the file to the host, append its value to `/opt/voiceforge/.env` as `ORIGIN_VERIFY_SECRET=<value>`, then recreate nginx as above.
2. Delete the local file once the value is in place. Never commit it and never `echo` it.

If the file is lost, do not regenerate the secret out of band: extract the current value from the distribution config (`aws cloudfront get-distribution-config`, origin custom headers), because the script reuses whatever the distribution already carries.

### Rollback

Each step reverses independently, in roughly the opposite order:

- Repoint the `incfrog.ai` and `www.incfrog.ai` aliases back to plain A records on the Elastic IP. Traffic bypasses CloudFront within the alias TTL.
- Re-open 443 to `0.0.0.0/0` on the `voiceforge-production` security group (rerunning `provision.sh` does this as part of its ingress reconciliation).
- Remove `ORIGIN_VERIFY_SECRET` from `/opt/voiceforge/.env` and force-recreate nginx so it stops requiring the header.

The distribution and certificate can stay in place unused to make re-enabling straightforward; verify current AWS pricing before deciding whether to retain them long term.

### Caveat: provision.sh reverts the lockdown

`provision.sh` reconciles the security group's ingress set on every rerun: it revokes all existing rules and re-adds exactly 80/443 from `0.0.0.0/0` plus the operator SSH `/32` (see the just-in-time SSH section below). That reconciliation strips the CloudFront prefix-list rule and re-opens 443 to the world. **After any `provision.sh` rerun, rerun `./provision-cloudfront.sh --lockdown`.**

### Certificate renewal is unaffected

certbot renewal on the host keeps working after the CDN rollout: port 80 remains open to `0.0.0.0/0` (lockdown only touches 443), and the ACME HTTP-01 exchange does not traverse CloudFront — the webroot is served from the port-80 server, which is exempt from the origin-verify check. The Let's Encrypt certificate remains what nginx presents to CloudFront on the origin side; the ACM certificate is used only on the viewer side.

## 5. Just-in-time SSH ingress for the deploy workflow

The deploy workflow runs `ssh` and `scp` from a GitHub-hosted runner. GitHub does not give those runners stable egress addresses, so there is no fixed CIDR to pre-authorize. Widening port 22 to `0.0.0.0/0` to work around this would expose the host permanently, so the deploy role is instead allowed to open a narrow hole for itself and close it again.

`VoiceForgeGitHubDeployRole` therefore carries two EC2 statements beyond its ECR access:

- `JustInTimeSshIngress` grants only `ec2:AuthorizeSecurityGroupIngress` and `ec2:RevokeSecurityGroupIngress`, with `Resource` pinned to the ARN of the single `voiceforge-production` security group. The role cannot touch any other security group, cannot launch or terminate instances, and cannot modify instance attributes. The workflow uses this to add TCP 22 for the runner's own public IP as a `/32` immediately before it needs SSH, and to revoke that exact rule afterwards, including when the deploy fails.
- `ReadSecurityGroupRulesWildcardRequiredByEc2` grants `ec2:DescribeSecurityGroups` and `ec2:DescribeSecurityGroupRules` so the workflow can resolve the rule it just created and revoke it precisely rather than by guesswork. Its `Resource` is `*` because EC2 `Describe*` actions do not support resource-level permissions; IAM rejects any narrower ARN for them. The wildcard is an AWS constraint, not an oversight, and it is isolated in its own read-only statement so a reviewer can see that at a glance.

The role is deliberately not granted `ec2:CreateTags`, so it cannot tag the rules it creates. A consequence for the workflow: it must not pass `--tag-specifications` to `authorize-security-group-ingress`, because doing so makes the call additionally authorize against the `security-group-rule` resource type, which is not granted here. Identify the temporary rule with the per-CIDR `Description` field inside `--ip-permissions` instead.

The workflow needs to know which group to open, so set the repository variable `AWS_SECURITY_GROUP_ID` to the security group ID printed in the provisioning summary. It is a variable rather than a secret because a group ID is not sensitive and masking it would only obscure deployment error messages. The deploy job validates its shape before building anything and fails fast when it is missing or malformed.

The operator `/32` supplied through `--ssh-cidr` is a separate, persistent rule. The workflow's temporary rule is scoped to a different address and is added and removed independently, so a deploy never disturbs operator access, and revoking the temporary rule never removes it. Port 22 is never opened to `0.0.0.0/0` by either path.

A workflow that is hard-killed between authorize and revoke — a cancelled run, a runner that disappears — can leave an orphaned `/32` behind. Re-running `provision.sh` clears it: the provisioner revokes every existing ingress rule on the group by rule ID and then re-adds exactly 80/tcp and 443/tcp from `0.0.0.0/0` plus 22/tcp from the supplied `--ssh-cidr`. Any rule that is not part of that declared set, including a stale runner `/32`, is removed. This is a full reconciliation of the ingress set, not an additive pass. It follows that provisioning must not be run concurrently with a deploy, since reconciliation would revoke the in-flight runner rule and break the deploy's SSH session.

Because an orphaned rule survives until someone notices, prefer checking for it directly after an aborted deploy rather than waiting for the next provision run:

```bash path=null start=null
aws ec2 describe-security-group-rules --region us-east-1 \
  --filters Name=group-id,Values=sg-0a0cdaa867a158101 \
  --query 'SecurityGroupRules[?IsEgress==`false` && FromPort==`22`].[SecurityGroupRuleId,CidrIpv4,Description]' \
  --output table
```

Anything on port 22 other than the operator `/32` is a leftover and should be revoked by its rule ID.

## 6. Post-provision checks

1. Confirm the budget email subscription if AWS sends a confirmation request.
2. Verify the EC2 instance reports both system and instance status checks as passed.
3. Connect using the existing private key and the printed Elastic IP. Do not loosen SSH ingress if access fails; update `--ssh-cidr` and rerun instead.
4. On the host, verify `docker version`, `docker compose version`, and ownership/mode of `/opt/voiceforge`.
5. Populate GitHub with the printed deploy-role ARN, region, ECR URIs, security group ID as `AWS_SECURITY_GROUP_ID`, instance address, bucket name, and bucket prefix. Treat SSH private keys and application environment values as secrets even though resource IDs are not secret.
6. Leave the LiveKit agent disabled until its environment exists. The AWS foundation does not require LiveKit configuration.

## 7. Teardown

Teardown permanently deletes images, all current and historical versions of uploaded knowledge files, the instance, and related resources. Export or retain anything required before running it. The exact account-ID argument is a deliberate guard:

```bash path=null start=null
cd infra/aws
./teardown.sh --confirm-account-id 543777713748
```

Before any destructive call, teardown verifies that the live AWS caller account matches both the hard-coded target and `--confirm-account-id`. Instance, Elastic IP, and security-group discovery is also constrained by the VoiceForge project tags and intended VPC where supported.

The administrator user and root MFA are deliberately not removed. The teardown is rerunnable and reports the identifiers it found or deleted. If AWS reports dependency violations, inspect the named resource rather than broadening permissions or deleting unrelated infrastructure.
