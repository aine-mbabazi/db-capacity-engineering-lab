# -----------------------------------------------------------------------------
# Remote state: S3 backend + DynamoDB lock table.
#
# Terraform's `backend` block is resolved before the rest of the config (and
# before input variables are evaluated), so it cannot reference var.* or
# locals - the bucket/key/region/dynamodb_table below are NOT wired to
# variables.tf. Instead this is a partial configuration: the placeholders are
# filled in at `terraform init` time from values the group's bootstrap script
# creates, via a (gitignored) backend-config file:
#
#     terraform init -backend-config=backend.hcl
#
# where backend.hcl looks like:
#
#     bucket         = "<bucket the bootstrap script created>"
#     key            = "a2/capacity-lab/terraform.tfstate"
#     region         = "<bootstrap region>"
#     dynamodb_table = "<lock table the bootstrap script created>"
#
# Equivalent `-backend-config="key=value"` flags work too. If the group is
# also running state storage against LocalStack rather than real AWS S3/
# DynamoDB, add `endpoints = { s3 = "...", dynamodb = "..." }`,
# `use_path_style = true`, and `skip_credentials_validation = true` to the
# same backend-config file - the `backend "s3"` block supports those keys
# directly, so nothing here needs to change.
# -----------------------------------------------------------------------------
terraform {
  backend "s3" {
    bucket         = "REPLACE_WITH_BOOTSTRAP_BUCKET_NAME"
    key            = "a2/capacity-lab/terraform.tfstate"
    region         = "REPLACE_WITH_BOOTSTRAP_REGION"
    dynamodb_table = "REPLACE_WITH_BOOTSTRAP_LOCK_TABLE_NAME"
    encrypt        = true
  }
}
