#!/usr/bin/env bash
set -Eeuo pipefail

REGION="us-east-1"
ACCOUNT_ID="543777713748"
VPC_ID="vpc-0153c477887328ad8"
BUCKET_NAME="voiceforge-knowledge-${ACCOUNT_ID}-${REGION}"
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
DEPLOY_ROLE="VoiceForgeGitHubDeployRole"
INSTANCE_ROLE="VoiceForgeEc2Role"
INSTANCE_PROFILE="VoiceForgeEc2Profile"
SECURITY_GROUP_NAME="voiceforge-production"
BUDGET_NAME="VoiceForgeMonthlyCost"
ECR_REPOS=(voiceforge-api voiceforge-web voiceforge-livekit-agent)
CONFIRM_ACCOUNT_ID=""

while (($#)); do
  case "$1" in
    --confirm-account-id) CONFIRM_ACCOUNT_ID="${2:?missing value}"; shift 2 ;;
    *) echo "Usage: ./teardown.sh --confirm-account-id ${ACCOUNT_ID}" >&2; exit 2 ;;
  esac
done
[[ "$CONFIRM_ACCOUNT_ID" == "$ACCOUNT_ID" ]] || { echo 'Exact target account confirmation is required.' >&2; exit 2; }
command -v aws >/dev/null || { echo 'AWS CLI is required.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'python3 is required to empty the versioned bucket.' >&2; exit 1; }
CALLER_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ "$CALLER_ACCOUNT_ID" == "$ACCOUNT_ID" && "$CALLER_ACCOUNT_ID" == "$CONFIRM_ACCOUNT_ID" ]] \
  || { echo "AWS credentials target account $CALLER_ACCOUNT_ID, not confirmed account $ACCOUNT_ID; refusing teardown." >&2; exit 2; }

INSTANCE_IDS="$(aws ec2 describe-instances --region "$REGION" \
  --filters 'Name=tag:Name,Values=voiceforge-production' 'Name=tag:Project,Values=VoiceForge' \
    "Name=vpc-id,Values=${VPC_ID}" 'Name=instance-state-name,Values=pending,running,stopping,stopped' \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
if [[ -n "$INSTANCE_IDS" && "$INSTANCE_IDS" != "None" ]]; then
  read -r -a INSTANCE_ARRAY <<<"$INSTANCE_IDS"
  aws ec2 terminate-instances --region "$REGION" --instance-ids "${INSTANCE_ARRAY[@]}" >/dev/null
  aws ec2 wait instance-terminated --region "$REGION" --instance-ids "${INSTANCE_ARRAY[@]}"
fi

ALLOCATION_IDS="$(aws ec2 describe-addresses --region "$REGION" \
  --filters 'Name=tag:Name,Values=voiceforge-production' 'Name=tag:Project,Values=VoiceForge' \
  --query 'Addresses[].AllocationId' --output text)"
for allocation_id in $ALLOCATION_IDS; do
  ASSOCIATION_ID="$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$allocation_id" --query 'Addresses[0].AssociationId' --output text)"
  [[ "$ASSOCIATION_ID" == "None" ]] || aws ec2 disassociate-address --region "$REGION" --association-id "$ASSOCIATION_ID"
  aws ec2 release-address --region "$REGION" --allocation-id "$allocation_id"
done

SG_IDS="$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=vpc-id,Values=${VPC_ID}" "Name=group-name,Values=${SECURITY_GROUP_NAME}" \
    'Name=tag:Project,Values=VoiceForge' --query 'SecurityGroups[].GroupId' --output text)"
if [[ -n "$SG_IDS" && "$SG_IDS" != "None" ]]; then
  read -r -a SG_ARRAY <<<"$SG_IDS"
  [[ "${#SG_ARRAY[@]}" -eq 1 ]] || { echo "Expected one VoiceForge security group; found: $SG_IDS" >&2; exit 1; }
  SG_ID="${SG_ARRAY[0]}"
  aws ec2 delete-security-group --region "$REGION" --group-id "$SG_ID"
else
  SG_ID="None"
fi

if aws s3api head-bucket --region "$REGION" --bucket "$BUCKET_NAME" >/dev/null 2>&1; then
  BUCKET_NAME="$BUCKET_NAME" python3 <<'PY'
import json, os, subprocess
bucket = os.environ["BUCKET_NAME"]
raw = subprocess.check_output(["aws", "s3api", "list-object-versions", "--bucket", bucket, "--output", "json"], text=True)
data = json.loads(raw)
objects = [{"Key": item["Key"], "VersionId": item["VersionId"]} for group in ("Versions", "DeleteMarkers") for item in data.get(group, [])]
for offset in range(0, len(objects), 1000):
    payload = json.dumps({"Objects": objects[offset:offset + 1000], "Quiet": True})
    subprocess.run(["aws", "s3api", "delete-objects", "--bucket", bucket, "--delete", payload], check=True, stdout=subprocess.DEVNULL)
PY
  aws s3api delete-bucket --region "$REGION" --bucket "$BUCKET_NAME"
fi

for repo in "${ECR_REPOS[@]}"; do
  aws ecr describe-repositories --region "$REGION" --repository-names "$repo" >/dev/null 2>&1 && \
    aws ecr delete-repository --region "$REGION" --repository-name "$repo" --force >/dev/null || true
done

if aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE" >/dev/null 2>&1; then
  aws iam remove-role-from-instance-profile --instance-profile-name "$INSTANCE_PROFILE" --role-name "$INSTANCE_ROLE" >/dev/null 2>&1 || true
  aws iam delete-instance-profile --instance-profile-name "$INSTANCE_PROFILE"
fi
if aws iam get-role --role-name "$INSTANCE_ROLE" >/dev/null 2>&1; then
  aws iam delete-role-policy --role-name "$INSTANCE_ROLE" --policy-name VoiceForgeRuntimeAccess >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$INSTANCE_ROLE"
fi
if aws iam get-role --role-name "$DEPLOY_ROLE" >/dev/null 2>&1; then
  aws iam delete-role-policy --role-name "$DEPLOY_ROLE" --policy-name VoiceForgeEcrPushPull >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$DEPLOY_ROLE"
fi
aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1 && \
  aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" || true
aws budgets describe-budget --region "$REGION" --account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME" >/dev/null 2>&1 && \
  aws budgets delete-budget --region "$REGION" --account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME" || true

cat <<SUMMARY
=== VoiceForge AWS teardown outputs ===
Region: ${REGION}
Terminated instance IDs: ${INSTANCE_IDS:-none}
Released Elastic IP allocation IDs: ${ALLOCATION_IDS:-none}
Deleted security group ID: ${SG_ID:-none}
Deleted bucket: ${BUCKET_NAME}
Deleted deploy role ARN: arn:aws:iam::${ACCOUNT_ID}:role/${DEPLOY_ROLE}
Deleted instance role ARN: arn:aws:iam::${ACCOUNT_ID}:role/${INSTANCE_ROLE}
Deleted OIDC provider ARN: ${OIDC_ARN}
Deleted ECR repositories: ${ECR_REPOS[*]}
Deleted budget: ${BUDGET_NAME}
=== End AWS teardown outputs ===
SUMMARY
