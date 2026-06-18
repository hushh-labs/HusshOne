output "service_account_email" {
  value       = google_service_account.burst.email
  description = "The least-privilege burst service account. Use this for Workload Identity Federation, or with a key."
}

output "custom_role_id" {
  value       = google_project_iam_custom_role.burst.id
  description = "The least-privilege custom role bound to the service account."
}

output "tpu_result_bucket" {
  value       = var.enable_tpu ? google_storage_bucket.tpu_results[0].name : null
  description = "Set ONE_BURST_TPU_RESULT_BUCKET to this when running TPU bursts."
}

output "service_account_key_json" {
  value       = var.create_key ? base64decode(google_service_account_key.burst[0].private_key) : null
  sensitive   = true
  description = "The SA key JSON (only when create_key=true). Paste into One; never commit. Prefer keyless WIF."
}
