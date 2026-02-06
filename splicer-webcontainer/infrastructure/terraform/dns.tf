# Cloud DNS configuration (optional)
#
# This creates a Cloud DNS managed zone and wildcard A record.
# Only used when manage_dns = true
#
# If using external DNS (e.g., Cloudflare, Route53), set manage_dns = false
# and manually create:
#   *.preview.{domain} A {load_balancer_ip}

# Cloud DNS managed zone
resource "google_dns_managed_zone" "preview" {
  count = var.manage_dns ? 1 : 0

  name        = var.dns_zone_name
  dns_name    = "${var.preview_domain}."
  description = "DNS zone for Splicer preview subdomains"

  # DNSSEC configuration (recommended for production)
  dnssec_config {
    state = "on"
  }

  depends_on = [google_project_service.dns]
}

# Wildcard A record pointing to the load balancer
resource "google_dns_record_set" "preview_wildcard" {
  count = var.manage_dns ? 1 : 0

  name         = "*.${var.preview_domain}."
  type         = "A"
  ttl          = 300
  managed_zone = google_dns_managed_zone.preview[0].name

  rrdatas = [google_compute_global_address.preview_lb.address]
}

# CAA record to allow Google to issue certificates
resource "google_dns_record_set" "preview_caa" {
  count = var.manage_dns ? 1 : 0

  name         = "${var.preview_domain}."
  type         = "CAA"
  ttl          = 300
  managed_zone = google_dns_managed_zone.preview[0].name

  rrdatas = [
    "0 issue \"pki.goog\"",
    "0 issue \"letsencrypt.org\"",
  ]
}
