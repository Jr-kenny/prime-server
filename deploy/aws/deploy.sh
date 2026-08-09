#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ENV_FILE="${PRIME_SERVER_ENV_FILE:-$REPO_ROOT/.env}"
readonly REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
readonly ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
readonly ECR_REPOSITORY="${PRIME_SERVER_ECR_REPOSITORY:-prime-server}"
readonly IMAGE_TAG="${PRIME_SERVER_IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)-arm64}"
readonly IMAGE_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPOSITORY}"
readonly ROLE_NAME="prime-server-ec2-runtime"
readonly INSTANCE_PROFILE_NAME="prime-server-ec2"
readonly SECURITY_GROUP_NAME="prime-server-public"
readonly LOG_GROUP="/prime-server/node"
readonly CONFIG_PARAM="/prime-server/coston2/runtime-env"
readonly IDENTITIES_PARAM="/prime-server/coston2/provider-identities"
readonly APP_NAME="prime-server"
readonly ELASTIC_IP_NAME="prime-server-public"
readonly MARKET_TYPE="${PRIME_SERVER_MARKET_TYPE:-on-demand}"

case "$MARKET_TYPE" in
  on-demand|spot) ;;
  *)
    echo "PRIME_SERVER_MARKET_TYPE must be on-demand or spot" >&2
    exit 1
    ;;
esac

if [[ -z "$REGION" || "$REGION" == "None" ]]; then
  echo "AWS region is not configured" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing Prime Server environment file: $ENV_FILE" >&2
  exit 1
fi
for required_key in \
  PRIME_SERVER_DEPLOYER_PRIVATE_KEY \
  PRIME_SERVER_PROVIDER_1_PRIVATE_KEY \
  PRIME_SERVER_PROVIDER_2_PRIVATE_KEY \
  PRIME_SERVER_PROVIDER_3_PRIVATE_KEY \
  PRIME_SERVER_PROVIDER_4_PRIVATE_KEY \
  PRIME_SERVER_RPC_URL \
  PRIME_SERVER_REGISTRY_ADDRESS \
  PRIME_SERVER_AUTH_SECRET; do
  if ! grep -q "^${required_key}=" "$ENV_FILE"; then
    echo "Missing $required_key in $ENV_FILE" >&2
    exit 1
  fi
done

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo "Preparing Prime Server AWS deployment in $REGION"

if ! aws ecr describe-repositories --region "$REGION" --repository-names "$ECR_REPOSITORY" >/dev/null 2>&1; then
  aws ecr create-repository \
    --region "$REGION" \
    --repository-name "$ECR_REPOSITORY" \
    --image-scanning-configuration scanOnPush=true \
    --image-tag-mutability IMMUTABLE >/dev/null
fi

aws ecr get-login-password --region "$REGION" | docker login \
  --username AWS \
  --password-stdin "$(printf '%s' "$IMAGE_URI" | cut -d/ -f1)" >/dev/null

if docker buildx version >/dev/null 2>&1; then
  docker buildx build \
    --platform linux/arm64 \
    --file "$REPO_ROOT/deploy/aws/Dockerfile" \
    --tag "$IMAGE_URI:$IMAGE_TAG" \
    --push \
    "$REPO_ROOT"
else
  docker build \
    --platform linux/arm64 \
    --file "$REPO_ROOT/deploy/aws/Dockerfile" \
    --tag "$IMAGE_URI:$IMAGE_TAG" \
    "$REPO_ROOT"
  docker push "$IMAGE_URI:$IMAGE_TAG"
fi

trust_policy="$tmp_dir/trust-policy.json"
jq -n '{Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{Service:"ec2.amazonaws.com"},Action:"sts:AssumeRole"}]}' > "$trust_policy"

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "file://$trust_policy"
else
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$trust_policy" \
    --description "Prime Server EC2 runtime role" \
    --tags Key=Application,Value="$APP_NAME" Key=ManagedBy,Value=prime-server-deploy >/dev/null
fi

aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

repo_arn="arn:aws:ecr:${REGION}:${ACCOUNT_ID}:repository/${ECR_REPOSITORY}"
config_arn="arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${CONFIG_PARAM}"
identities_arn="arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${IDENTITIES_PARAM}"
log_arn="arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}:*"
runtime_policy="$tmp_dir/runtime-policy.json"
jq -n \
  --arg repo_arn "$repo_arn" \
  --arg config_arn "$config_arn" \
  --arg identities_arn "$identities_arn" \
  --arg log_arn "$log_arn" \
  --arg region "$REGION" \
  --arg account "$ACCOUNT_ID" \
  '{Version:"2012-10-17",Statement:[
    {Sid:"EcrToken",Effect:"Allow",Action:["ecr:GetAuthorizationToken"],Resource:"*"},
    {Sid:"EcrPull",Effect:"Allow",Action:["ecr:BatchCheckLayerAvailability","ecr:BatchGetImage","ecr:GetDownloadUrlForLayer"],Resource:$repo_arn},
    {Sid:"ReadPrimeConfig",Effect:"Allow",Action:["ssm:GetParameter"],Resource:[$config_arn,$identities_arn]},
    {Sid:"DecryptPrimeConfig",Effect:"Allow",Action:["kms:Decrypt"],Resource:"*",Condition:{StringEquals:{"kms:ViaService":("ssm." + $region + ".amazonaws.com"),"kms:CallerAccount":$account}}},
    {Sid:"WritePrimeLogs",Effect:"Allow",Action:["logs:CreateLogStream","logs:DescribeLogStreams","logs:PutLogEvents"],Resource:$log_arn}
  ]}' > "$runtime_policy"
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name prime-server-runtime \
  --policy-document "file://$runtime_policy"

if ! aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME" >/dev/null 2>&1; then
  aws iam create-instance-profile \
    --instance-profile-name "$INSTANCE_PROFILE_NAME" \
    --tags Key=Application,Value="$APP_NAME" Key=ManagedBy,Value=prime-server-deploy >/dev/null
fi
if ! aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME" \
  --query "InstanceProfile.Roles[?RoleName=='$ROLE_NAME'] | length(@)" \
  --output text | grep -q '^1$'; then
  aws iam add-role-to-instance-profile \
    --instance-profile-name "$INSTANCE_PROFILE_NAME" \
    --role-name "$ROLE_NAME" 2>/dev/null || true
fi

if ! aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "$LOG_GROUP" \
  --query "logGroups[?logGroupName=='$LOG_GROUP'] | length(@)" --output text | grep -q '^1$'; then
  aws logs create-log-group --region "$REGION" --log-group-name "$LOG_GROUP"
fi
aws logs put-retention-policy --region "$REGION" --log-group-name "$LOG_GROUP" --retention-in-days 14

identity_source="${PRIME_SERVER_IDENTITIES_SOURCE:-}"
if [[ -z "$identity_source" ]]; then
  identity_source="$(find "$REPO_ROOT/.prime-server/coston2" -mindepth 2 -maxdepth 2 -type d -name providers -print 2>/dev/null | sort | tail -n 1)"
fi
if [[ -z "$identity_source" || ! -f "$identity_source/provider-1/identity.json" ]]; then
  echo "Provider identity source was not found. Set PRIME_SERVER_IDENTITIES_SOURCE." >&2
  exit 1
fi

config_input="$tmp_dir/config-input.json"
jq -n --arg name "$CONFIG_PARAM" --rawfile value "$ENV_FILE" \
  '{Name:$name,Type:"SecureString",Value:$value,Overwrite:true}' > "$config_input"
aws ssm put-parameter --region "$REGION" --cli-input-json "file://$config_input" >/dev/null

identities_json="$tmp_dir/provider-identities.json"
jq -n \
  --rawfile provider1 "$identity_source/provider-1/identity.json" \
  --rawfile provider2 "$identity_source/provider-2/identity.json" \
  --rawfile provider3 "$identity_source/provider-3/identity.json" \
  --rawfile provider4 "$identity_source/provider-4/identity.json" \
  '{"provider-1":($provider1|fromjson),"provider-2":($provider2|fromjson),"provider-3":($provider3|fromjson),"provider-4":($provider4|fromjson)}' > "$identities_json"
identities_input="$tmp_dir/identities-input.json"
jq -n --arg name "$IDENTITIES_PARAM" --rawfile value "$identities_json" \
  '{Name:$name,Type:"SecureString",Value:$value,Overwrite:true}' > "$identities_input"
aws ssm put-parameter --region "$REGION" --cli-input-json "file://$identities_input" >/dev/null

vpc_id="$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true Name=state,Values=available --query 'Vpcs[0].VpcId' --output text)"
subnet_id="$(aws ec2 describe-subnets --region "$REGION" --filters Name=vpc-id,Values="$vpc_id" Name=availability-zone,Values="${REGION}a" Name=map-public-ip-on-launch,Values=true --query 'Subnets[0].SubnetId' --output text)"
if [[ -z "$subnet_id" || "$subnet_id" == "None" ]]; then
  subnet_id="$(aws ec2 describe-subnets --region "$REGION" --filters Name=vpc-id,Values="$vpc_id" Name=map-public-ip-on-launch,Values=true --query 'Subnets[0].SubnetId' --output text)"
fi

security_group_id="$(aws ec2 describe-security-groups --region "$REGION" \
  --filters Name=vpc-id,Values="$vpc_id" Name=group-name,Values="$SECURITY_GROUP_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text)"
if [[ -z "$security_group_id" || "$security_group_id" == "None" ]]; then
  security_group_id="$(aws ec2 create-security-group \
    --region "$REGION" \
    --group-name "$SECURITY_GROUP_NAME" \
    --description "Prime Server public RPC only" \
    --vpc-id "$vpc_id" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Application,Value=$APP_NAME},{Key=ManagedBy,Value=prime-server-deploy}]" \
    --query GroupId --output text)"
fi
aws ec2 authorize-security-group-ingress \
  --region "$REGION" \
  --group-id "$security_group_id" \
  --protocol tcp \
  --port 8080 \
  --cidr 0.0.0.0/0 2>/dev/null || true

ami_id="$(aws ssm get-parameter \
  --region "$REGION" \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query Parameter.Value --output text)"

user_data="$tmp_dir/user-data.sh"
sed \
  -e "s|__AWS_REGION__|$REGION|g" \
  -e "s|__CONFIG_PARAM__|$CONFIG_PARAM|g" \
  -e "s|__IDENTITIES_PARAM__|$IDENTITIES_PARAM|g" \
  -e "s|__IMAGE_URI__|$IMAGE_URI|g" \
  -e "s|__IMAGE_TAG__|$IMAGE_TAG|g" \
  -e "s|__LOG_GROUP__|$LOG_GROUP|g" \
  "$REPO_ROOT/deploy/aws/bootstrap.sh" > "$user_data"

existing_instance_id="$(aws ec2 describe-instances --region "$REGION" \
  --filters Name=tag:Application,Values="$APP_NAME" Name=tag:ManagedBy,Values=prime-server-deploy \
  Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[0].InstanceId' --output text | awk '$1 != "None" {print $1; exit}')"

if [[ -n "$existing_instance_id" ]]; then
  instance_id="$existing_instance_id"
  reuse_instance=true
  echo "Using existing Prime Server instance $instance_id"
else
  reuse_instance=false
  run_instance_args=(
    --region "$REGION"
    --image-id "$ami_id"
    --instance-type m7g.medium
    --subnet-id "$subnet_id"
    --security-group-ids "$security_group_id"
    --associate-public-ip-address
    --iam-instance-profile Name="$INSTANCE_PROFILE_NAME"
    --metadata-options HttpEndpoint=enabled,HttpTokens=required,HttpPutResponseHopLimit=2
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=40,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}'
    --user-data "file://$user_data"
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=prime-server-public},{Key=Application,Value=$APP_NAME},{Key=ManagedBy,Value=prime-server-deploy},{Key=ImageTag,Value=$IMAGE_TAG},{Key=MarketType,Value=$MARKET_TYPE}]"
    --query 'Instances[0].InstanceId'
    --output text
  )
  if [[ "$MARKET_TYPE" == "spot" ]]; then
    run_instance_args+=(--instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=persistent,InstanceInterruptionBehavior=stop}')
  fi
  instance_id="$(aws ec2 run-instances "${run_instance_args[@]}")"
fi

aws ec2 wait instance-running --region "$REGION" --instance-ids "$instance_id"

if [[ "$reuse_instance" == "true" ]]; then
  for attempt in $(seq 1 60); do
    ping_status="$(aws ssm describe-instance-information \
      --region "$REGION" \
      --filters Key=InstanceIds,Values="$instance_id" \
      --query 'InstanceInformationList[0].PingStatus' --output text)"
    if [[ "$ping_status" == "Online" ]]; then
      break
    fi
    if [[ "$attempt" == "60" ]]; then
      echo "Prime Server instance did not become available through SSM." >&2
      exit 1
    fi
    sleep 5
  done
  command_input="$tmp_dir/ssm-deploy-command.json"
  jq -n \
    --arg instance "$instance_id" \
    --rawfile command "$user_data" \
    '{InstanceIds:[$instance],DocumentName:"AWS-RunShellScript",Comment:"Deploy Prime Server container",Parameters:{commands:[$command]}}' \
    > "$command_input"
  command_id="$(aws ssm send-command \
    --region "$REGION" \
    --cli-input-json "file://$command_input" \
    --query 'Command.CommandId' --output text)"
  if ! aws ssm wait command-executed \
    --region "$REGION" \
    --command-id "$command_id" \
    --instance-id "$instance_id"; then
    aws ssm get-command-invocation \
      --region "$REGION" \
      --command-id "$command_id" \
      --instance-id "$instance_id" \
      --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' \
      --output json >&2
    exit 1
  fi
fi
aws ec2 create-tags \
  --region "$REGION" \
  --resources "$instance_id" \
  --tags Key=ImageTag,Value="$IMAGE_TAG" Key=MarketType,Value="$MARKET_TYPE"

allocation_id="$(aws ec2 describe-addresses --region "$REGION" \
  --filters Name=tag:Application,Values="$APP_NAME" Name=tag:ManagedBy,Values=prime-server-deploy \
  --query 'Addresses[0].AllocationId' --output text)"
if [[ -z "$allocation_id" || "$allocation_id" == "None" ]]; then
  allocation_id="$(aws ec2 allocate-address \
    --region "$REGION" \
    --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$ELASTIC_IP_NAME},{Key=Application,Value=$APP_NAME},{Key=ManagedBy,Value=prime-server-deploy}]" \
    --query AllocationId --output text)"
fi
aws ec2 associate-address \
  --region "$REGION" \
  --allocation-id "$allocation_id" \
  --instance-id "$instance_id" \
  --allow-reassociation >/dev/null
public_ip="$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$allocation_id" --query 'Addresses[0].PublicIp' --output text)"
echo "Prime Server instance: $instance_id"
echo "Prime Server market type: $MARKET_TYPE"
echo "Prime Server public IP: $public_ip"

for attempt in $(seq 1 90); do
  if curl --fail --silent --show-error --max-time 5 "http://${public_ip}:8080/health" > "$tmp_dir/health.json"; then
    break
  fi
  if [[ "$attempt" == "90" ]]; then
    echo "Prime Server did not become healthy. Inspect SSM and CloudWatch logs for $instance_id." >&2
    exit 1
  fi
  sleep 10
done

deployment_state="$REPO_ROOT/.prime-server/aws-deployment.json"
mkdir -p "$(dirname "$deployment_state")"
jq -n \
  --arg region "$REGION" \
  --arg account "$ACCOUNT_ID" \
  --arg instance "$instance_id" \
  --arg public_ip "$public_ip" \
  --arg allocation_id "$allocation_id" \
  --arg market_type "$MARKET_TYPE" \
  --arg image "$IMAGE_URI:$IMAGE_TAG" \
  --arg role "$ROLE_NAME" \
  --arg profile "$INSTANCE_PROFILE_NAME" \
  --arg security_group "$security_group_id" \
  --arg registry "$(awk -F= '$1=="PRIME_SERVER_REGISTRY_ADDRESS" {print substr($0,index($0,"=")+1)}' "$ENV_FILE")" \
  --arg deployed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --slurpfile health "$tmp_dir/health.json" \
  '{region:$region,account:$account,instanceId:$instance,publicIp:$public_ip,elasticIpAllocationId:$allocation_id,marketType:$market_type,image:$image,role:$role,instanceProfile:$profile,securityGroupId:$security_group,registryAddress:$registry,deployedAt:$deployed_at,health:$health[0]}' \
  > "$deployment_state"
chmod 0600 "$deployment_state"

echo "Prime Server is healthy at http://${public_ip}:8080/health"
echo "Deployment state saved under .prime-server/aws-deployment.json"
