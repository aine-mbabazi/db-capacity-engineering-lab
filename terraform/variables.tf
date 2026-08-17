variable "app_ami_id" {
  description = "AMI ID for the app instance launched by module.service. No default - must be supplied per environment (a LocalStack fake AMI id for local runs, a real AMI id in AWS)."
  type        = string
}

variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

# -----------------------------------------------------------------------------
# LocalStack / tflocal endpoint overrides.
#
# Mirrors the AWS SDK's AWS_ENDPOINT_URL / AWS_ENDPOINT_URL_<SERVICE>
# convention: aws_endpoint_url is the fallback endpoint used for every
# service below unless that service has its own override set. Defaults point
# at the LocalStack gateway (localhost:4566) so `terraform apply` works
# out of the box for local runs.
#
# To target real AWS instead: set aws_endpoint_url = "" and leave the
# per-service overrides empty (or run via `tflocal`, which injects these
# for you and is a drop-in wrapper around the `terraform` binary).
# -----------------------------------------------------------------------------
variable "aws_endpoint_url" {
  description = "Default LocalStack/AWS endpoint URL used for any service below that doesn't have its own override. Empty string = no override (real AWS default endpoints)."
  type        = string
  default     = "http://localhost:4566"
}

variable "aws_endpoint_url_ec2" {
  description = "Endpoint override for EC2. Empty string falls back to aws_endpoint_url."
  type        = string
  default     = ""
}

variable "aws_endpoint_url_rds" {
  description = "Endpoint override for RDS. Empty string falls back to aws_endpoint_url."
  type        = string
  default     = ""
}

variable "aws_endpoint_url_secretsmanager" {
  description = "Endpoint override for Secrets Manager. Empty string falls back to aws_endpoint_url."
  type        = string
  default     = ""
}

variable "aws_endpoint_url_ecr" {
  description = "Endpoint override for ECR. Empty string falls back to aws_endpoint_url."
  type        = string
  default     = ""
}

variable "aws_endpoint_url_s3" {
  description = "Endpoint override for S3. Empty string falls back to aws_endpoint_url."
  type        = string
  default     = ""
}

variable "aws_endpoint_url_dynamodb" {
  description = "Endpoint override for DynamoDB. Empty string falls back to aws_endpoint_url."
  type        = string
  default     = ""
}

variable "aws_access_key" {
  description = "Access key passed to the AWS provider. LocalStack accepts any non-empty value; defaults to LocalStack's conventional \"test\". Override for real AWS (or leave unset there and use your normal credential chain by clearing this and skip_aws_credentials_validation)."
  type        = string
  default     = "test"
}

variable "aws_secret_key" {
  description = "Secret key passed to the AWS provider. LocalStack accepts any non-empty value; defaults to LocalStack's conventional \"test\"."
  type        = string
  default     = "test"
  sensitive   = true
}

variable "skip_aws_credentials_validation" {
  description = "Skip AWS credential/account-id validation and the EC2 metadata check. true for LocalStack, false against real AWS."
  type        = bool
  default     = true
}

variable "s3_use_path_style" {
  description = "Use path-style S3 addressing. Required by LocalStack; real AWS supports virtual-hosted style too, so this is safe to leave true either way."
  type        = bool
  default     = true
}
