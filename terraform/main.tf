terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# -----------------------------------------------------------------------------
# Per-service endpoint resolution: each service uses its own override if set,
# otherwise falls back to the shared aws_endpoint_url. See variables.tf.
# -----------------------------------------------------------------------------
locals {
  endpoint_ec2            = var.aws_endpoint_url_ec2 != "" ? var.aws_endpoint_url_ec2 : var.aws_endpoint_url
  endpoint_rds            = var.aws_endpoint_url_rds != "" ? var.aws_endpoint_url_rds : var.aws_endpoint_url
  endpoint_secretsmanager = var.aws_endpoint_url_secretsmanager != "" ? var.aws_endpoint_url_secretsmanager : var.aws_endpoint_url
  endpoint_ecr            = var.aws_endpoint_url_ecr != "" ? var.aws_endpoint_url_ecr : var.aws_endpoint_url
  endpoint_s3             = var.aws_endpoint_url_s3 != "" ? var.aws_endpoint_url_s3 : var.aws_endpoint_url
  endpoint_dynamodb       = var.aws_endpoint_url_dynamodb != "" ? var.aws_endpoint_url_dynamodb : var.aws_endpoint_url
}

provider "aws" {
  region = var.aws_region

  access_key                  = var.aws_access_key
  secret_key                  = var.aws_secret_key
  skip_credentials_validation = var.skip_aws_credentials_validation
  skip_metadata_api_check     = var.skip_aws_credentials_validation
  skip_requesting_account_id  = var.skip_aws_credentials_validation
  s3_use_path_style           = var.s3_use_path_style

  endpoints {
    ec2            = local.endpoint_ec2 != "" ? local.endpoint_ec2 : null
    rds            = local.endpoint_rds != "" ? local.endpoint_rds : null
    secretsmanager = local.endpoint_secretsmanager != "" ? local.endpoint_secretsmanager : null
    ecr            = local.endpoint_ecr != "" ? local.endpoint_ecr : null
    s3             = local.endpoint_s3 != "" ? local.endpoint_s3 : null
    dynamodb       = local.endpoint_dynamodb != "" ? local.endpoint_dynamodb : null
  }
}

# -----------------------------------------------------------------------------
# Root module: composes the group's regional-health-platform data + service
# modules for the A2 rehost of this lab's capacity-api + MySQL onto
# AWS/LocalStack infrastructure.
# -----------------------------------------------------------------------------
module "data" {
  source = "git::https://github.com/aine-mbabazi/regional-health-platform.git//modules/data"

  db_name           = "capacity_lab"
  db_username       = "app"
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  engine_version    = "8.0"
  secret_name       = "regional-health/db"
}

module "service" {
  source = "git::https://github.com/aine-mbabazi/regional-health-platform.git//modules/service"

  app_ami_id    = var.app_ami_id
  instance_type = "t3.small"
  secret_arn    = module.data.secret_arn
  db_endpoint   = module.data.db_endpoint
  db_port       = module.data.db_port
  app_port      = 3000
}
