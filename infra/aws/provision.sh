#!/usr/bin/env bash
set -Eeuo pipefail

REGION="us-east-1"
ACCOUNT_ID="543777713748"
VPC_ID="vpc-0153c477887328ad8"
REPO_SLUG="Deepak8858/voice-agent-builder"
NAME_PREFIX="voiceforge"
BUCKET_NAME="voiceforge-knowledge-${ACCOUNT_ID}-${REGION}"
BUCKET_PREFIX="knowledge"
OIDC_URL="https://token.actions.githubusercontent.com"
OIDC_HOST="token.actions.githubusercontent.com"
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_HOST}"
DEPLOY_ROLE="VoiceForgeGitHubDeployRole"
INSTANCE_ROLE="VoiceForgeEc2Role"
INSTANCE_PROFILE="VoiceForgeEc2Profile"
SECURITY_GROUP_NAME="voiceforge-production"
BUDGET_NAME="VoiceForgeMonthlyCost"
ECR_REPOS=(voiceforge-api voiceforge-web voiceforge-livekit-agent)

SSH_CIDR=""
KEY_NAME=""
BUDGET_EMAIL=""
MONTHLY_BUDGET_USD="100"

usage() {
  cat <<'USAGE'
Usage: ./provision.sh --ssh-cidr <public-ip/32> --key-name <existing-key-pair> \
  --budget-email <address> [--monthly-budget-usd <amount>]

The SSH CIDR must be a restricted IPv4 CIDR and cannot be 0.0.0.0/0.
USAGE
}

while (($#)); do
  case "$1" in
    --ssh-cidr) SSH_CIDR="${2:?missing value}"; shift 2 ;;
    --key-name) KEY_NAME="${2:?missing value}"; shift 2 ;;
    --budget-email) BUDGET_EMAIL="${2:?missing value}"; shift 2 ;;
    --monthly-budget-usd) MONTHLY_BUDGET_USD="${2:?missing value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$SSH_CIDR" && -n "$KEY_NAME" && -n "$BUDGET_EMAIL" ]] || { usage >&2; exit 2; }
validate_ssh_cidr() {
  local cidr="$1" address prefix octet
  [[ "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]] \
    || { echo 'SSH CIDR must be a valid IPv4 CIDR.' >&2; return 1; }
  address="${cidr%/*}"
  prefix="${cidr#*/}"
  IFS=. read -r -a octets <<<"$address"
  for octet in "${octets[@]}"; do
    ((10#$octet <= 255)) || { echo 'SSH CIDR contains an invalid IPv4 octet.' >&2; return 1; }
  done
  [[ "$prefix" == "32" ]] \
    || { echo 'SSH CIDR must restrict access to one public IPv4 address using /32.' >&2; return 1; }
}
validate_ssh_cidr "$SSH_CIDR"
[[ "$MONTHLY_BUDGET_USD" =~ ^[0-9]+([.][0-9]{1,2})?$ ]] || { echo 'Budget must be a positive numeric USD amount.' >&2; exit 2; }
command -v aws >/dev/null || { echo 'AWS CLI is required.' >&2; exit 1; }
aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat >"$TMP_DIR/oidc-trust.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "${OIDC_ARN}"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "${OIDC_HOST}:aud": "sts.amazonaws.com",
        "${OIDC_HOST}:sub": "repo:${REPO_SLUG}:environment:production"
      }
    }
  }]
}
JSON

if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider \
    --url "$OIDC_URL" \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 >/dev/null
fi

if ! aws iam get-role --role-name "$DEPLOY_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$DEPLOY_ROLE" \
    --assume-role-policy-document "file://$TMP_DIR/oidc-trust.json" \
    --description "GitHub OIDC deployment role for ${REPO_SLUG}" >/dev/null
else
  aws iam update-assume-role-policy --role-name "$DEPLOY_ROLE" \
    --policy-document "file://$TMP_DIR/oidc-trust.json"
fi

ECR_RESOURCE_ARNS=()
for repo in "${ECR_REPOS[@]}"; do
  if ! aws ecr describe-repositories --region "$REGION" --repository-names "$repo" >/dev/null 2>&1; then
    aws ecr create-repository --region "$REGION" --repository-name "$repo" \
      --image-scanning-configuration scanOnPush=true \
      --image-tag-mutability IMMUTABLE \
      --encryption-configuration encryptionType=AES256 >/dev/null
  else
    aws ecr put-image-scanning-configuration --region "$REGION" --repository-name "$repo" \
      --image-scanning-configuration scanOnPush=true >/dev/null
    aws ecr put-image-tag-mutability --region "$REGION" --repository-name "$repo" \
      --image-tag-mutability IMMUTABLE >/dev/null
  fi
  aws ecr put-lifecycle-policy --region "$REGION" --repository-name "$repo" --lifecycle-policy-text \
    '{"rules":[{"rulePriority":1,"description":"Retain the 10 newest images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}' >/dev/null
  ECR_RESOURCE_ARNS+=("arn:aws:ecr:${REGION}:${ACCOUNT_ID}:repository/${repo}")
done

printf '%s\n' "${ECR_RESOURCE_ARNS[@]}" | sed 's/.*/"&",/' | sed '$ s/,$//' >"$TMP_DIR/ecr-arns.txt"
cat >"$TMP_DIR/deploy-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {"Sid":"EcrLogin","Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*"},
    {"Sid":"PushPullOnlyVoiceForgeRepositories","Effect":"Allow","Action":[
      "ecr:BatchCheckLayerAvailability","ecr:BatchGetImage","ecr:CompleteLayerUpload",
      "ecr:GetDownloadUrlForLayer","ecr:InitiateLayerUpload","ecr:ListImages",
      "ecr:PutImage","ecr:UploadLayerPart"
    ],"Resource":[$(cat "$TMP_DIR/ecr-arns.txt")]}
  ]
}
JSON
aws iam put-role-policy --role-name "$DEPLOY_ROLE" --policy-name VoiceForgeEcrPushPull \
  --policy-document "file://$TMP_DIR/deploy-policy.json"

if ! aws s3api head-bucket --region "$REGION" --bucket "$BUCKET_NAME" >/dev/null 2>&1; then
  aws s3api create-bucket --region "$REGION" --bucket "$BUCKET_NAME" >/dev/null
fi
aws s3api put-public-access-block --region "$REGION" --bucket "$BUCKET_NAME" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --region "$REGION" --bucket "$BUCKET_NAME" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
aws s3api put-bucket-versioning --region "$REGION" --bucket "$BUCKET_NAME" --versioning-configuration Status=Enabled
cat >"$TMP_DIR/bucket-policy.json" <<JSON
{"Version":"2012-10-17","Statement":[{"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*","Action":"s3:*","Resource":["arn:aws:s3:::${BUCKET_NAME}","arn:aws:s3:::${BUCKET_NAME}/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}
JSON
aws s3api put-bucket-policy --region "$REGION" --bucket "$BUCKET_NAME" --policy "file://$TMP_DIR/bucket-policy.json"

cat >"$TMP_DIR/ec2-trust.json" <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
if ! aws iam get-role --role-name "$INSTANCE_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$INSTANCE_ROLE" --assume-role-policy-document "file://$TMP_DIR/ec2-trust.json" \
    --description "VoiceForge EC2 runtime role" >/dev/null
else
  aws iam update-assume-role-policy --role-name "$INSTANCE_ROLE" --policy-document "file://$TMP_DIR/ec2-trust.json"
fi
cat >"$TMP_DIR/instance-policy.json" <<JSON
{
  "Version":"2012-10-17",
  "Statement":[
    {"Sid":"EcrLogin","Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*"},
    {"Sid":"PullVoiceForgeImages","Effect":"Allow","Action":["ecr:BatchCheckLayerAvailability","ecr:BatchGetImage","ecr:GetDownloadUrlForLayer"],"Resource":[$(cat "$TMP_DIR/ecr-arns.txt")]},
    {"Sid":"ListKnowledgePrefix","Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::${BUCKET_NAME}","Condition":{"StringLike":{"s3:prefix":["${BUCKET_PREFIX}","${BUCKET_PREFIX}/*"]}}},
    {"Sid":"ReadWriteKnowledgePrefix","Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":"arn:aws:s3:::${BUCKET_NAME}/${BUCKET_PREFIX}/*"}
  ]
}
JSON
aws iam put-role-policy --role-name "$INSTANCE_ROLE" --policy-name VoiceForgeRuntimeAccess \
  --policy-document "file://$TMP_DIR/instance-policy.json"
if ! aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$INSTANCE_PROFILE" >/dev/null
fi
PROFILE_ROLE="$(aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE" --query 'InstanceProfile.Roles[0].RoleName' --output text)"
if [[ "$PROFILE_ROLE" == "None" ]]; then
  aws iam add-role-to-instance-profile --instance-profile-name "$INSTANCE_PROFILE" --role-name "$INSTANCE_ROLE"
elif [[ "$PROFILE_ROLE" != "$INSTANCE_ROLE" ]]; then
  echo "Instance profile already contains unexpected role: $PROFILE_ROLE" >&2
  exit 1
fi

SG_ID="$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=vpc-id,Values=${VPC_ID}" "Name=group-name,Values=${SECURITY_GROUP_NAME}" \
    'Name=tag:Project,Values=VoiceForge' \
  --query 'SecurityGroups[0].GroupId' --output text)"
if [[ "$SG_ID" == "None" ]]; then
  SG_ID="$(aws ec2 create-security-group --region "$REGION" --vpc-id "$VPC_ID" \
    --group-name "$SECURITY_GROUP_NAME" --description "VoiceForge production web ingress" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=${SECURITY_GROUP_NAME}},{Key=Project,Value=VoiceForge}]" \
    --query GroupId --output text)"
fi
ensure_ingress() {
  local port="$1" cidr="$2"
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=${port},ToPort=${port},IpRanges=[{CidrIp=${cidr}}]" >/dev/null 2>&1 || {
      aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG_ID" \
        --query "SecurityGroups[0].IpPermissions[?FromPort==\`${port}\`].IpRanges[].CidrIp" --output text | grep -qw "$cidr"
    }
}
# Reconcile the complete ingress set so a reused group cannot retain stale IPv4,
# IPv6, port-range, or security-group-reference access.
INGRESS_RULE_IDS="$(aws ec2 describe-security-group-rules --region "$REGION" \
  --filters "Name=group-id,Values=${SG_ID}" \
  --query 'SecurityGroupRules[?IsEgress==`false`].SecurityGroupRuleId' --output text)"
if [[ -n "$INGRESS_RULE_IDS" && "$INGRESS_RULE_IDS" != "None" ]]; then
  read -r -a INGRESS_RULE_ARRAY <<<"$INGRESS_RULE_IDS"
  aws ec2 revoke-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --security-group-rule-ids "${INGRESS_RULE_ARRAY[@]}" >/dev/null
fi
ensure_ingress 80 0.0.0.0/0
ensure_ingress 443 0.0.0.0/0
ensure_ingress 22 "$SSH_CIDR"

AMI_ID="$(aws ssm get-parameter --region "$REGION" --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query 'Parameter.Value' --output text)"
SUBNET_ID="$(aws ec2 describe-subnets --region "$REGION" --filters "Name=vpc-id,Values=${VPC_ID}" "Name=default-for-az,Values=true" \
  --query 'sort_by(Subnets,&AvailabilityZone)[0].SubnetId' --output text)"
INSTANCE_ID="$(aws ec2 describe-instances --region "$REGION" \
  --filters 'Name=tag:Name,Values=voiceforge-production' 'Name=tag:Project,Values=VoiceForge' \
    "Name=vpc-id,Values=${VPC_ID}" 'Name=instance-state-name,Values=pending,running,stopping,stopped' \
  --query 'Reservations[].Instances[].InstanceId | [0]' --output text)"
if [[ "$INSTANCE_ID" == "None" ]]; then
  INSTANCE_ID="$(aws ec2 run-instances --region "$REGION" --image-id "$AMI_ID" --instance-type t3.large \
    --key-name "$KEY_NAME" --subnet-id "$SUBNET_ID" --security-group-ids "$SG_ID" \
    --iam-instance-profile "Name=${INSTANCE_PROFILE}" \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true,Encrypted=true}' \
    --user-data "file://$(dirname "$0")/bootstrap-ubuntu.sh" \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=voiceforge-production},{Key=Project,Value=VoiceForge}]' \
    --query 'Instances[0].InstanceId' --output text)"
fi
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
EXPECTED_PROFILE_ARN="$(aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE" \
  --query 'InstanceProfile.Arn' --output text)"
ACTUAL_PROFILE_ARN="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' --output text)"
[[ "$ACTUAL_PROFILE_ARN" == "$EXPECTED_PROFILE_ARN" ]] \
  || { echo "Instance $INSTANCE_ID has unexpected instance profile: $ACTUAL_PROFILE_ARN" >&2; exit 1; }
ACTUAL_SECURITY_GROUPS="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)"
[[ "$ACTUAL_SECURITY_GROUPS" == "$SG_ID" ]] \
  || { echo "Instance $INSTANCE_ID must use only security group $SG_ID; found: $ACTUAL_SECURITY_GROUPS" >&2; exit 1; }
aws ec2 modify-instance-metadata-options --region "$REGION" --instance-id "$INSTANCE_ID" \
  --http-tokens required --http-endpoint enabled >/dev/null
for _ in {1..30}; do
  read -r METADATA_TOKENS METADATA_STATE <<<"$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].MetadataOptions.[HttpTokens,State]' --output text)"
  [[ "$METADATA_TOKENS" == "required" && "$METADATA_STATE" == "applied" ]] && break
  sleep 2
done
[[ "$METADATA_TOKENS" == "required" && "$METADATA_STATE" == "applied" ]] \
  || { echo "Instance $INSTANCE_ID did not apply required IMDSv2 metadata options." >&2; exit 1; }

ALLOCATION_ID="$(aws ec2 describe-addresses --region "$REGION" \
  --filters 'Name=tag:Name,Values=voiceforge-production' 'Name=tag:Project,Values=VoiceForge' \
  --query 'Addresses[0].AllocationId' --output text)"
if [[ "$ALLOCATION_ID" == "None" ]]; then
  ALLOCATION_ID="$(aws ec2 allocate-address --region "$REGION" --domain vpc \
    --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=voiceforge-production},{Key=Project,Value=VoiceForge}]' \
    --query AllocationId --output text)"
fi
EIP_INSTANCE="$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOCATION_ID" --query 'Addresses[0].InstanceId' --output text)"
if [[ "$EIP_INSTANCE" != "$INSTANCE_ID" ]]; then
  [[ "$EIP_INSTANCE" == "None" ]] || { echo "Elastic IP is attached to unexpected instance $EIP_INSTANCE" >&2; exit 1; }
  aws ec2 associate-address --region "$REGION" --instance-id "$INSTANCE_ID" --allocation-id "$ALLOCATION_ID" >/dev/null
fi
ELASTIC_IP="$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOCATION_ID" --query 'Addresses[0].PublicIp' --output text)"

cat >"$TMP_DIR/budget.json" <<JSON
{"BudgetName":"${BUDGET_NAME}","BudgetLimit":{"Amount":"${MONTHLY_BUDGET_USD}","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST","CostTypes":{"IncludeTax":true,"IncludeSubscription":true,"UseBlended":false,"IncludeRefund":false,"IncludeCredit":false,"IncludeUpfront":true,"IncludeRecurring":true,"IncludeOtherSubscription":true,"IncludeSupport":true,"IncludeDiscount":true,"UseAmortized":false}}
JSON
cat >"$TMP_DIR/notifications.json" <<JSON
[{"Notification":{"NotificationType":"FORECASTED","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"${BUDGET_EMAIL}"}]}]
JSON
# The Budgets API is global and is served from us-east-1.
if aws budgets describe-budget --region "$REGION" --account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME" >/dev/null 2>&1; then
  aws budgets update-budget --region "$REGION" --account-id "$ACCOUNT_ID" --new-budget "file://$TMP_DIR/budget.json"
else
  aws budgets create-budget --region "$REGION" --account-id "$ACCOUNT_ID" --budget "file://$TMP_DIR/budget.json" \
    --notifications-with-subscribers "file://$TMP_DIR/notifications.json"
fi

DEPLOY_ROLE_ARN="$(aws iam get-role --role-name "$DEPLOY_ROLE" --query 'Role.Arn' --output text)"
INSTANCE_PROFILE_ARN="$(aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE" --query 'InstanceProfile.Arn' --output text)"
cat <<SUMMARY
=== VoiceForge AWS foundation outputs ===
Region: ${REGION}
GitHub OIDC provider ARN: ${OIDC_ARN}
Deploy role ARN: ${DEPLOY_ROLE_ARN}
ECR API URI: ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/voiceforge-api
ECR web URI: ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/voiceforge-web
ECR LiveKit agent URI: ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/voiceforge-livekit-agent
Knowledge bucket: ${BUCKET_NAME}
Knowledge bucket prefix: ${BUCKET_PREFIX}/
Security group ID: ${SG_ID}
Instance profile ARN: ${INSTANCE_PROFILE_ARN}
Instance ID: ${INSTANCE_ID}
Elastic IP allocation ID: ${ALLOCATION_ID}
Elastic IP: ${ELASTIC_IP}
Budget name: ${BUDGET_NAME}
=== End AWS foundation outputs ===
SUMMARY
