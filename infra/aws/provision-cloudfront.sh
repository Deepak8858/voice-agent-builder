#!/usr/bin/env bash
set -Eeuo pipefail

# Git Bash for Windows (MSYS2) rewrites arguments that look like absolute POSIX
# paths into Windows paths. That corrupts AWS CLI values which are not paths.
# Disable conversion globally; both variables are inert on Linux hosts and CI.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REGION="us-east-1"
ACCOUNT_ID="543777713748"
VPC_ID="vpc-0153c477887328ad8"
DOMAIN="incfrog.ai"
WWW_DOMAIN="www.incfrog.ai"
ORIGIN_DOMAIN="origin.incfrog.ai"
DISTRIBUTION_MARKER="voiceforge-production"
ORIGIN_ID="voiceforge-production-origin"
SECURITY_GROUP_NAME="voiceforge-production"
PROJECT_TAG="VoiceForge"
CLOUDFRONT_ZONE_ID="Z2FDTNDATAQYW2"
CACHING_DISABLED_POLICY_ID="4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
CACHING_OPTIMIZED_POLICY_ID="658327ea-f89d-4fab-a63d-7e88639e58f6"
ALL_VIEWER_POLICY_ID="216adef6-5c7f-47e4-b989-5492eafa07d3"
SECRET_FILE="$(pwd)/origin-verify-secret.txt"
LOCKDOWN=false

usage() {
  cat <<'USAGE'
Usage: ./provision-cloudfront.sh [--lockdown]

Provision or reconcile the VoiceForge CloudFront distribution. With --lockdown,
also replace public HTTPS origin ingress with the CloudFront origin prefix list.
USAGE
}

while (($#)); do
  case "$1" in
    --lockdown) LOCKDOWN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v aws >/dev/null || { echo 'AWS CLI is required.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'OpenSSL is required.' >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# A native Windows AWS CLI cannot resolve Git Bash /tmp paths in file://
# parameters. Convert only when cygpath exists, retaining Linux compatibility.
awsfile() {
  if command -v cygpath >/dev/null 2>&1; then
    printf 'file://%s' "$(cygpath -w "$1")"
  else
    printf 'file://%s' "$1"
  fi
}

is_none() {
  [[ -z "$1" || "$1" == "None" || "$1" == "null" ]]
}

# Route 53 hosted zone IDs returned by the API are prefixed with /hostedzone/,
# while change-resource-record-sets accepts the bare ID.
HOSTED_ZONE_RESULT="$(aws route53 list-hosted-zones-by-name --region "$REGION" \
  --dns-name "$DOMAIN" --max-items 1 \
  --query "HostedZones[?Name=='${DOMAIN}.']|[0].[Id,Config.PrivateZone]" --output text)"
read -r HOSTED_ZONE_ID HOSTED_ZONE_PRIVATE <<<"$HOSTED_ZONE_RESULT"
is_none "${HOSTED_ZONE_ID:-}" && { echo "Public Route 53 hosted zone for $DOMAIN was not found." >&2; exit 1; }
[[ "$HOSTED_ZONE_PRIVATE" == "False" || "$HOSTED_ZONE_PRIVATE" == "false" ]] \
  || { echo "Hosted zone for $DOMAIN is private; a public zone is required." >&2; exit 1; }
HOSTED_ZONE_ID="${HOSTED_ZONE_ID##*/}"

ELASTIC_IP="$(aws ec2 describe-addresses --region "$REGION" \
  --filters 'Name=tag:Name,Values=voiceforge-production' 'Name=tag:Project,Values=VoiceForge' \
  --query 'Addresses[0].PublicIp' --output text)"
is_none "$ELASTIC_IP" && { echo 'Tagged VoiceForge production Elastic IP was not found.' >&2; exit 1; }

cat >"$TMP_DIR/origin-record.json" <<JSON
{
  "Comment": "VoiceForge CloudFront origin",
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "${ORIGIN_DOMAIN}",
      "Type": "A",
      "TTL": 300,
      "ResourceRecords": [{"Value": "${ELASTIC_IP}"}]
    }
  }]
}
JSON
aws route53 change-resource-record-sets --region "$REGION" \
  --hosted-zone-id "$HOSTED_ZONE_ID" \
  --change-batch "$(awsfile "$TMP_DIR/origin-record.json")" >/dev/null

# ACM list-certificates cannot prove an exact SAN match. Inspect each plausible
# certificate and accept only the requested two-name set in a usable state.
CERT_ARN=""
CERT_ARNS="$(aws acm list-certificates --region "$REGION" \
  --certificate-statuses ISSUED PENDING_VALIDATION \
  --query "CertificateSummaryList[?DomainName=='${DOMAIN}'].CertificateArn" --output text)"
if [[ -n "$CERT_ARNS" && "$CERT_ARNS" != "None" ]]; then
  read -r -a CERT_ARN_ARRAY <<<"$CERT_ARNS"
  for CANDIDATE_ARN in "${CERT_ARN_ARRAY[@]}"; do
    CANDIDATE_NAMES="$(aws acm describe-certificate --region "$REGION" \
      --certificate-arn "$CANDIDATE_ARN" \
      --query 'sort(Certificate.SubjectAlternativeNames)' --output text)"
    if [[ "$CANDIDATE_NAMES" == "${DOMAIN}"$'\t'"${WWW_DOMAIN}" ]]; then
      CERT_ARN="$CANDIDATE_ARN"
      break
    fi
  done
fi
if [[ -z "$CERT_ARN" ]]; then
  # The stable token makes retries of request-certificate idempotent.
  IDEMPOTENCY_TOKEN="$(printf '%s' "voiceforge-${HOSTED_ZONE_ID}" | tr -cd 'A-Za-z0-9' | cut -c1-32)"
  CERT_ARN="$(aws acm request-certificate --region "$REGION" \
    --domain-name "$DOMAIN" --subject-alternative-names "$WWW_DOMAIN" \
    --validation-method DNS --idempotency-token "$IDEMPOTENCY_TOKEN" \
    --tags Key=Project,Value="$PROJECT_TAG" Key=Name,Value="$DISTRIBUTION_MARKER" \
    --query CertificateArn --output text)"
fi

# DomainValidationOptions are populated asynchronously after request. Wait for
# both records, then UPSERT each because ACM may use the same CNAME twice.
VALIDATION_RECORDS=""
for _ in {1..60}; do
  VALIDATION_RECORDS="$(aws acm describe-certificate --region "$REGION" \
    --certificate-arn "$CERT_ARN" \
    --query 'Certificate.DomainValidationOptions[?ResourceRecord].[ResourceRecord.Name,ResourceRecord.Type,ResourceRecord.Value]' \
    --output text)"
  RECORD_COUNT="$(printf '%s\n' "$VALIDATION_RECORDS" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
  ((RECORD_COUNT >= 2)) && break
  sleep 5
done
[[ -n "$VALIDATION_RECORDS" ]] || { echo 'ACM DNS validation records did not become available.' >&2; exit 1; }

while IFS=$'\t' read -r RECORD_NAME RECORD_TYPE RECORD_VALUE; do
  [[ -n "$RECORD_NAME" ]] || continue
  cat >"$TMP_DIR/acm-validation.json" <<JSON
{
  "Comment": "ACM validation for VoiceForge CloudFront",
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "${RECORD_NAME}",
      "Type": "${RECORD_TYPE}",
      "TTL": 300,
      "ResourceRecords": [{"Value": "${RECORD_VALUE}"}]
    }
  }]
}
JSON
  aws route53 change-resource-record-sets --region "$REGION" \
    --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "$(awsfile "$TMP_DIR/acm-validation.json")" >/dev/null
done <<<"$VALIDATION_RECORDS"
aws acm wait certificate-validated --region "$REGION" --certificate-arn "$CERT_ARN"

DISTRIBUTION_ID="$(aws cloudfront list-distributions --region "$REGION" \
  --query "DistributionList.Items[?contains(Aliases.Items, '${DOMAIN}')]|[0].Id" --output text)"
if [[ "$LOCKDOWN" == true ]] && is_none "$DISTRIBUTION_ID"; then
  echo '--lockdown requires an existing CloudFront distribution for incfrog.ai.' >&2
  exit 1
fi
ORIGIN_VERIFY_SECRET=""
ETAG=""
EXISTING_CALLER_REFERENCE=""
if ! is_none "$DISTRIBUTION_ID"; then
  ETAG="$(aws cloudfront get-distribution-config --region "$REGION" \
    --id "$DISTRIBUTION_ID" --query ETag --output text)"
  ORIGIN_VERIFY_SECRET="$(aws cloudfront get-distribution-config --region "$REGION" \
    --id "$DISTRIBUTION_ID" \
    --query "DistributionConfig.Origins.Items[].CustomHeaders.Items[?HeaderName=='X-Origin-Verify'].HeaderValue | [0][0]" \
    --output text)"
  is_none "$ORIGIN_VERIFY_SECRET" && ORIGIN_VERIFY_SECRET=""
  # CallerReference is immutable after creation; update-distribution rejects a
  # config whose reference differs from the existing one, so reuse it verbatim.
  EXISTING_CALLER_REFERENCE="$(aws cloudfront get-distribution-config --region "$REGION" \
    --id "$DISTRIBUTION_ID" --query 'DistributionConfig.CallerReference' --output text)"
fi
if [[ -z "$ORIGIN_VERIFY_SECRET" ]]; then
  ORIGIN_VERIFY_SECRET="$(openssl rand -hex 32)"
fi
[[ "$ORIGIN_VERIFY_SECRET" =~ ^[A-Za-z0-9_-]+$ ]] \
  || { echo 'Existing origin verification header contains unsupported characters.' >&2; exit 1; }

# Persist with restrictive permissions without ever writing the value to stdout.
umask 077
printf '%s\n' "$ORIGIN_VERIFY_SECRET" >"$SECRET_FILE"
chmod 600 "$SECRET_FILE"

CALLER_REFERENCE="voiceforge-cloudfront-${HOSTED_ZONE_ID}"
if [[ -n "$EXISTING_CALLER_REFERENCE" && "$EXISTING_CALLER_REFERENCE" != "None" ]]; then
  CALLER_REFERENCE="$EXISTING_CALLER_REFERENCE"
fi
cat >"$TMP_DIR/distribution-config.json" <<JSON
{
  "CallerReference": "${CALLER_REFERENCE}",
  "Aliases": {"Quantity": 2, "Items": ["${DOMAIN}", "${WWW_DOMAIN}"]},
  "DefaultRootObject": "",
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "${ORIGIN_ID}",
      "DomainName": "${ORIGIN_DOMAIN}",
      "OriginPath": "",
      "CustomHeaders": {
        "Quantity": 1,
        "Items": [{"HeaderName": "X-Origin-Verify", "HeaderValue": "${ORIGIN_VERIFY_SECRET}"}]
      },
      "CustomOriginConfig": {
        "HTTPPort": 443,
        "HTTPSPort": 443,
        "OriginProtocolPolicy": "https-only",
        "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
        "OriginReadTimeout": 60,
        "OriginKeepaliveTimeout": 60
      },
      "ConnectionAttempts": 3,
      "ConnectionTimeout": 10,
      "OriginShield": {"Enabled": false}
    }]
  },
  "OriginGroups": {"Quantity": 0},
  "DefaultCacheBehavior": {
    "TargetOriginId": "${ORIGIN_ID}",
    "TrustedSigners": {"Enabled": false, "Quantity": 0},
    "TrustedKeyGroups": {"Enabled": false, "Quantity": 0},
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 7,
      "Items": ["HEAD", "DELETE", "POST", "GET", "OPTIONS", "PUT", "PATCH"],
      "CachedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"]}
    },
    "SmoothStreaming": false,
    "Compress": true,
    "LambdaFunctionAssociations": {"Quantity": 0},
    "FunctionAssociations": {"Quantity": 0},
    "FieldLevelEncryptionId": "",
    "CachePolicyId": "${CACHING_DISABLED_POLICY_ID}",
    "OriginRequestPolicyId": "${ALL_VIEWER_POLICY_ID}"
  },
  "CacheBehaviors": {
    "Quantity": 4,
    "Items": [
      {
        "PathPattern": "/_next/static/*",
        "TargetOriginId": "${ORIGIN_ID}",
        "TrustedSigners": {"Enabled": false, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": false, "Quantity": 0},
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {"Quantity": 3, "Items": ["HEAD", "GET", "OPTIONS"], "CachedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"]}},
        "SmoothStreaming": false, "Compress": true,
        "LambdaFunctionAssociations": {"Quantity": 0}, "FunctionAssociations": {"Quantity": 0},
        "FieldLevelEncryptionId": "", "CachePolicyId": "${CACHING_OPTIMIZED_POLICY_ID}", "OriginRequestPolicyId": "${ALL_VIEWER_POLICY_ID}"
      },
      {
        "PathPattern": "/fonts/*",
        "TargetOriginId": "${ORIGIN_ID}",
        "TrustedSigners": {"Enabled": false, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": false, "Quantity": 0},
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {"Quantity": 3, "Items": ["HEAD", "GET", "OPTIONS"], "CachedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"]}},
        "SmoothStreaming": false, "Compress": true,
        "LambdaFunctionAssociations": {"Quantity": 0}, "FunctionAssociations": {"Quantity": 0},
        "FieldLevelEncryptionId": "", "CachePolicyId": "${CACHING_OPTIMIZED_POLICY_ID}", "OriginRequestPolicyId": "${ALL_VIEWER_POLICY_ID}"
      },
      {
        "PathPattern": "/images/*",
        "TargetOriginId": "${ORIGIN_ID}",
        "TrustedSigners": {"Enabled": false, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": false, "Quantity": 0},
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {"Quantity": 3, "Items": ["HEAD", "GET", "OPTIONS"], "CachedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"]}},
        "SmoothStreaming": false, "Compress": true,
        "LambdaFunctionAssociations": {"Quantity": 0}, "FunctionAssociations": {"Quantity": 0},
        "FieldLevelEncryptionId": "", "CachePolicyId": "${CACHING_OPTIMIZED_POLICY_ID}", "OriginRequestPolicyId": "${ALL_VIEWER_POLICY_ID}"
      },
      {
        "PathPattern": "/favicon.ico",
        "TargetOriginId": "${ORIGIN_ID}",
        "TrustedSigners": {"Enabled": false, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": false, "Quantity": 0},
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {"Quantity": 3, "Items": ["HEAD", "GET", "OPTIONS"], "CachedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"]}},
        "SmoothStreaming": false, "Compress": true,
        "LambdaFunctionAssociations": {"Quantity": 0}, "FunctionAssociations": {"Quantity": 0},
        "FieldLevelEncryptionId": "", "CachePolicyId": "${CACHING_OPTIMIZED_POLICY_ID}", "OriginRequestPolicyId": "${ALL_VIEWER_POLICY_ID}"
      }
    ]
  },
  "CustomErrorResponses": {"Quantity": 0},
  "Comment": "${DISTRIBUTION_MARKER}",
  "Logging": {"Enabled": false, "IncludeCookies": false, "Bucket": "", "Prefix": ""},
  "PriceClass": "PriceClass_All",
  "Enabled": true,
  "ViewerCertificate": {
    "ACMCertificateArn": "${CERT_ARN}",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021",
    "Certificate": "${CERT_ARN}",
    "CertificateSource": "acm"
  },
  "Restrictions": {"GeoRestriction": {"RestrictionType": "none", "Quantity": 0}},
  "WebACLId": "",
  "HttpVersion": "http2and3",
  "IsIPV6Enabled": true,
  "Staging": false,
  "ContinuousDeploymentPolicyId": ""
}
JSON

if is_none "$DISTRIBUTION_ID"; then
  cat >"$TMP_DIR/distribution-with-tags.json" <<JSON
{
  "DistributionConfig": $(cat "$TMP_DIR/distribution-config.json"),
  "Tags": {"Items": [{"Key": "Project", "Value": "${PROJECT_TAG}"}, {"Key": "Name", "Value": "${DISTRIBUTION_MARKER}"}]}
}
JSON
  read -r DISTRIBUTION_ID DISTRIBUTION_DOMAIN <<<"$(aws cloudfront create-distribution-with-tags \
    --region "$REGION" --distribution-config-with-tags "$(awsfile "$TMP_DIR/distribution-with-tags.json")" \
    --query 'Distribution.[Id,DomainName]' --output text)"
else
  DISTRIBUTION_DOMAIN="$(aws cloudfront update-distribution --region "$REGION" \
    --id "$DISTRIBUTION_ID" --if-match "$ETAG" \
    --distribution-config "$(awsfile "$TMP_DIR/distribution-config.json")" \
    --query 'Distribution.DomainName' --output text)"
  DISTRIBUTION_ARN="arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DISTRIBUTION_ID}"
  aws cloudfront tag-resource --region "$REGION" --resource "$DISTRIBUTION_ARN" \
    --tags "Items=[{Key=Project,Value=${PROJECT_TAG}},{Key=Name,Value=${DISTRIBUTION_MARKER}}]" >/dev/null
fi

aws cloudfront wait distribution-deployed --region "$REGION" --id "$DISTRIBUTION_ID"

CUTOVER=false
if [[ -t 0 && -r /dev/tty ]]; then
  printf 'CloudFront is deployed. Cut over %s and %s now? [y/N] ' "$DOMAIN" "$WWW_DOMAIN" >/dev/tty
  read -r CUTOVER_REPLY </dev/tty
  case "$CUTOVER_REPLY" in
    y|Y|yes|YES) CUTOVER=true ;;
    *) echo 'DNS cutover skipped.' ;;
  esac
else
  echo 'DNS cutover skipped because no interactive terminal is available.'
  echo 'Run this script interactively to receive the cutover confirmation prompt.'
fi

if [[ "$CUTOVER" == true ]]; then
  cat >"$TMP_DIR/alias-records.json" <<JSON
{
  "Comment": "Cut VoiceForge production traffic over to CloudFront",
  "Changes": [
    {"Action":"UPSERT","ResourceRecordSet":{"Name":"${DOMAIN}","Type":"A","AliasTarget":{"HostedZoneId":"${CLOUDFRONT_ZONE_ID}","DNSName":"${DISTRIBUTION_DOMAIN}","EvaluateTargetHealth":false}}},
    {"Action":"UPSERT","ResourceRecordSet":{"Name":"${DOMAIN}","Type":"AAAA","AliasTarget":{"HostedZoneId":"${CLOUDFRONT_ZONE_ID}","DNSName":"${DISTRIBUTION_DOMAIN}","EvaluateTargetHealth":false}}},
    {"Action":"UPSERT","ResourceRecordSet":{"Name":"${WWW_DOMAIN}","Type":"A","AliasTarget":{"HostedZoneId":"${CLOUDFRONT_ZONE_ID}","DNSName":"${DISTRIBUTION_DOMAIN}","EvaluateTargetHealth":false}}},
    {"Action":"UPSERT","ResourceRecordSet":{"Name":"${WWW_DOMAIN}","Type":"AAAA","AliasTarget":{"HostedZoneId":"${CLOUDFRONT_ZONE_ID}","DNSName":"${DISTRIBUTION_DOMAIN}","EvaluateTargetHealth":false}}}
  ]
}
JSON
  aws route53 change-resource-record-sets --region "$REGION" \
    --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "$(awsfile "$TMP_DIR/alias-records.json")" >/dev/null
fi

if [[ "$LOCKDOWN" == true ]]; then
  PREFIX_LIST_ID="$(aws ec2 describe-managed-prefix-lists --region "$REGION" \
    --filters 'Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing' \
    --query 'PrefixLists[0].PrefixListId' --output text)"
  is_none "$PREFIX_LIST_ID" && { echo 'CloudFront origin-facing managed prefix list was not found.' >&2; exit 1; }
  SG_ID="$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=vpc-id,Values=${VPC_ID}" "Name=group-name,Values=${SECURITY_GROUP_NAME}" \
      'Name=tag:Project,Values=VoiceForge' \
    --query 'SecurityGroups[0].GroupId' --output text)"
  is_none "$SG_ID" && { echo 'VoiceForge production security group was not found.' >&2; exit 1; }

  PREFIX_LIST_WEIGHT="$(aws ec2 describe-managed-prefix-lists --region "$REGION" \
    --prefix-list-ids "$PREFIX_LIST_ID" --query 'PrefixLists[0].MaxEntries' --output text)"
  SG_RULE_QUOTA="$(aws service-quotas get-service-quota --region "$REGION" \
    --service-code vpc --quota-code L-0EA8095F --query 'Quota.Value' --output text)"
  read -r IPV4_RULES IPV6_RULES SG_REFERENCE_RULES PREFIX_LIST_RULES <<<"$(
    aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG_ID" \
      --query 'SecurityGroups[0].[length(IpPermissions[].IpRanges[]),length(IpPermissions[].Ipv6Ranges[]),length(IpPermissions[].UserIdGroupPairs[]),length(IpPermissions[].PrefixListIds[])]' \
      --output text
  )"
  CURRENT_INGRESS_WEIGHT=$((IPV4_RULES + IPV6_RULES + SG_REFERENCE_RULES + PREFIX_LIST_RULES))
  HAS_PREFIX_RULE="$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG_ID" \
    --query "length(SecurityGroups[0].IpPermissions[].PrefixListIds[?PrefixListId=='${PREFIX_LIST_ID}'])" \
    --output text)"
  HAS_PUBLIC_HTTPS="$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG_ID" \
    --query 'length(SecurityGroups[0].IpPermissions[?IpProtocol==`tcp` && FromPort==`443` && ToPort==`443`].IpRanges[?CidrIp==`0.0.0.0/0`])' \
    --output text)"
  # Managed prefix lists consume their MaxEntries weight against the SG quota.
  # Account for removal of public 443 only when that exact rule currently exists.
  if [[ "$HAS_PREFIX_RULE" == "0" ]]; then
    PROJECTED_WEIGHT=$((CURRENT_INGRESS_WEIGHT - HAS_PUBLIC_HTTPS + PREFIX_LIST_WEIGHT))
    ((PROJECTED_WEIGHT <= ${SG_RULE_QUOTA%.*})) || {
      echo "CloudFront prefix-list rule weight would exceed the security group ingress quota." >&2
      exit 1
    }
  fi

  aws ec2 revoke-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions 'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' \
    >/dev/null 2>&1 || true
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=443,ToPort=443,PrefixListIds=[{PrefixListId=${PREFIX_LIST_ID},Description=CloudFront origin-facing}]" \
    >/dev/null 2>&1 || {
      aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG_ID" \
        --query "SecurityGroups[0].IpPermissions[?FromPort==\`443\`].PrefixListIds[?PrefixListId=='${PREFIX_LIST_ID}'].PrefixListId" \
        --output text | grep -qw "$PREFIX_LIST_ID"
    }
  echo 'Origin HTTPS ingress is restricted to the CloudFront managed prefix list.'
  echo 'IMPORTANT: rerunning infra/aws/provision.sh restores public 443 ingress; rerun this script with --lockdown afterwards.'
fi

cat <<SUMMARY
=== VoiceForge CloudFront outputs ===
Certificate ARN: ${CERT_ARN}
Distribution ID: ${DISTRIBUTION_ID}
Distribution domain: ${DISTRIBUTION_DOMAIN}
Origin record: ${ORIGIN_DOMAIN} -> ${ELASTIC_IP}
Alias records: ${DOMAIN} and ${WWW_DOMAIN} (A and AAAA)$([[ "$CUTOVER" == true ]] && printf ' updated' || printf ' not changed')
Origin verification secret file: ${SECRET_FILE}

Next steps:
1. Before cutover, test the distribution domain while sending Host: ${DOMAIN}.
2. Run this script interactively and confirm the DNS cutover if it was skipped.
3. Securely copy ${SECRET_FILE} to the host, add ORIGIN_VERIFY_SECRET=<file contents> to /opt/voiceforge/.env, and force-recreate nginx. Do not paste the secret into shell history.
4. Run ./provision-cloudfront.sh --lockdown after the origin secret is active and traffic is verified.
5. If infra/aws/provision.sh is rerun, it restores public 443 ingress. Rerun ./provision-cloudfront.sh --lockdown afterwards.
=== End VoiceForge CloudFront outputs ===
SUMMARY
