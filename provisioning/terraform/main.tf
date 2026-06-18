# One Burst Compute — BYOC provisioning (Terraform).
# Provisions exactly what One needs to burst into the customer's own GCP project:
# APIs, a least-privilege custom role, a dedicated service account, and (optionally)
# the TPU result bucket. Designed to be run by a standard IaC pipeline or a human.

locals {
  # Least-privilege permissions. Mirrors REQUIRED_PERMISSIONS in src/lib/burst/setup.ts,
  # plus GPU image/network reads; TPU permissions are appended when enable_tpu = true.
  gpu_permissions = [
    "compute.instances.create",
    "compute.instances.get",
    "compute.instances.delete",
    "compute.instances.setMetadata",
    "compute.instances.setLabels",
    "compute.disks.create",
    "compute.subnetworks.use",
    "compute.zoneOperations.get",
  ]
  tpu_permissions = [
    "tpu.nodes.create",
    "tpu.nodes.get",
    "tpu.nodes.delete",
    "tpu.operations.get",
  ]
  permissions   = var.enable_tpu ? concat(local.gpu_permissions, local.tpu_permissions) : local.gpu_permissions
  bucket_name   = var.tpu_result_bucket != "" ? var.tpu_result_bucket : "${var.project_id}-one-burst-tpu"
  base_services = ["compute.googleapis.com", "storage.googleapis.com"]
  services      = var.enable_tpu ? concat(local.base_services, ["tpu.googleapis.com"]) : local.base_services
}

resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_project_iam_custom_role" "burst" {
  project     = var.project_id
  role_id     = var.custom_role_id
  title       = "One Burst"
  description = "Least-privilege role for One burst compute."
  permissions = local.permissions
}

resource "google_service_account" "burst" {
  project      = var.project_id
  account_id   = var.service_account_id
  display_name = "Hushh One Burst (least privilege)"
}

resource "google_project_iam_member" "burst_role" {
  project = var.project_id
  role    = google_project_iam_custom_role.burst.id
  member  = "serviceAccount:${google_service_account.burst.email}"
}

# TPU result bucket (only when enable_tpu). The TPU node writes results here; the
# control plane reads them. Access is bucket-scoped, not project-wide.
resource "google_storage_bucket" "tpu_results" {
  count                       = var.enable_tpu ? 1 : 0
  project                     = var.project_id
  name                        = local.bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false

  lifecycle_rule {
    condition { age = 7 } # results are transient; clean up after a week
    action { type = "Delete" }
  }
}

resource "google_storage_bucket_iam_member" "tpu_results_writer" {
  count  = var.enable_tpu ? 1 : 0
  bucket = google_storage_bucket.tpu_results[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.burst.email}"
}

# Optional key. Prefer Workload Identity Federation (keyless) — see README.
resource "google_service_account_key" "burst" {
  count              = var.create_key ? 1 : 0
  service_account_id = google_service_account.burst.name
}
