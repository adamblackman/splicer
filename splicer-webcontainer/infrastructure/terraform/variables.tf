# Input variables for Splicer Preview Subdomain Routing

variable "project_id" {
  description = "Google Cloud project ID"
  type        = string
}

variable "region" {
  description = "Google Cloud region for Cloud Run"
  type        = string
  default     = "us-east5"
}

variable "preview_domain" {
  description = "Domain for preview subdomains (e.g., preview.splicer.run). Wildcard cert will be created for *.{preview_domain}"
  type        = string
}

variable "cloud_run_service_name" {
  description = "Name of the existing Cloud Run service"
  type        = string
  default     = "splicer-webcontainer"
}

variable "manage_dns" {
  description = "Whether to create and manage Cloud DNS zone. Set to false if using external DNS (e.g., Cloudflare)"
  type        = bool
  default     = false
}

variable "dns_zone_name" {
  description = "Name for the Cloud DNS managed zone (only used if manage_dns is true)"
  type        = string
  default     = "preview-zone"
}

variable "parent_domain" {
  description = "Parent domain for DNS zone (e.g., splicer.run). Only used if manage_dns is true"
  type        = string
  default     = ""
}

variable "enable_cdn" {
  description = "Enable Cloud CDN for static asset caching"
  type        = bool
  default     = false
}

variable "enable_iap" {
  description = "Enable Identity-Aware Proxy (for additional auth layer)"
  type        = bool
  default     = false
}

variable "ssl_policy" {
  description = "SSL policy name for TLS configuration. Leave empty for default"
  type        = string
  default     = ""
}

variable "log_sample_rate" {
  description = "Logging sample rate for load balancer (0.0 to 1.0)"
  type        = number
  default     = 1.0
}
