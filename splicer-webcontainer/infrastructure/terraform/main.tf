# Terraform configuration for Splicer Preview Subdomain Routing
#
# This sets up:
# - Global HTTPS Load Balancer
# - Wildcard SSL certificate for *.preview.{domain}
# - Serverless NEG pointing to Cloud Run
# - Cloud DNS zone and wildcard record (optional)
#
# Usage:
#   cd infrastructure/terraform
#   terraform init
#   terraform plan -var="project_id=your-project" -var="preview_domain=preview.splicer.run"
#   terraform apply

terraform {
  required_version = ">= 1.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }

  # Uncomment and configure for remote state storage
  # backend "gcs" {
  #   bucket = "your-terraform-state-bucket"
  #   prefix = "splicer/preview-routing"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# Enable required APIs
resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "dns" {
  count              = var.manage_dns ? 1 : 0
  service            = "dns.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "certificatemanager" {
  service            = "certificatemanager.googleapis.com"
  disable_on_destroy = false
}

# Data source for existing Cloud Run service
data "google_cloud_run_service" "preview" {
  name     = var.cloud_run_service_name
  location = var.region
}
