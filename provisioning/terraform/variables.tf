variable "project_id" {
  type        = string
  description = "The customer's GCP project where One burst workloads run (BYOC)."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Default region for bursts and the TPU result bucket."
}

variable "service_account_id" {
  type        = string
  default     = "hushh-burst"
  description = "ID for the least-privilege burst service account."
}

variable "custom_role_id" {
  type        = string
  default     = "oneBurst"
  description = "ID for the least-privilege custom role."
}

variable "enable_tpu" {
  type        = bool
  default     = false
  description = "Also provision the TPU path (Cloud TPU API + a GCS result bucket)."
}

variable "tpu_result_bucket" {
  type        = string
  default     = ""
  description = "Name for the TPU result bucket. Defaults to <project>-one-burst-tpu when empty."
}

variable "create_key" {
  type        = bool
  default     = false
  description = "Create a service-account JSON key (output as sensitive). Prefer Workload Identity Federation where possible."
}
