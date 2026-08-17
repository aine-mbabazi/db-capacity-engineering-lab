output "instance_id" {
  description = "EC2 instance ID of the app host (module.service)."
  value       = module.service.instance_id
}

output "db_endpoint" {
  description = "RDS endpoint (host:port) of the primary database (module.data)."
  value       = module.data.db_endpoint
}

output "secret_arn" {
  description = "Secrets Manager ARN holding the DB credentials (module.data)."
  value       = module.data.secret_arn
}
