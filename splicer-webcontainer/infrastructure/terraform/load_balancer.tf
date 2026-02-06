# Global HTTPS Load Balancer for Subdomain-based Preview Routing
#
# Architecture:
# Client -> Global Forwarding Rule -> Target HTTPS Proxy -> URL Map -> Backend Service -> Serverless NEG -> Cloud Run

# Static IP address for the load balancer
# This IP is used for DNS A record (*.preview.{domain} -> this IP)
resource "google_compute_global_address" "preview_lb" {
  name        = "splicer-preview-lb-ip"
  description = "Static IP for Splicer preview subdomain load balancer"

  depends_on = [google_project_service.compute]
}

# Serverless Network Endpoint Group pointing to Cloud Run
resource "google_compute_region_network_endpoint_group" "preview_neg" {
  name                  = "splicer-preview-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = var.cloud_run_service_name
  }

  depends_on = [google_project_service.compute, google_project_service.run]
}

# Backend service with session affinity
# Note: timeout_sec is not supported for serverless NEGs
resource "google_compute_backend_service" "preview" {
  name                  = "splicer-preview-backend"
  description           = "Backend service for Splicer preview subdomain routing"
  protocol              = "HTTPS"
  port_name             = "http"
  enable_cdn            = var.enable_cdn
  load_balancing_scheme = "EXTERNAL_MANAGED"

  # Session affinity to route requests to the same Cloud Run instance
  # This is critical for preview sessions which are stateful
  session_affinity = "GENERATED_COOKIE"
  
  affinity_cookie_ttl_sec = 3600  # 1 hour

  backend {
    group = google_compute_region_network_endpoint_group.preview_neg.id
  }

  # Logging configuration
  log_config {
    enable      = true
    sample_rate = var.log_sample_rate
  }

  # IAP configuration (optional)
  dynamic "iap" {
    for_each = var.enable_iap ? [1] : []
    content {
      oauth2_client_id     = ""  # Configure via console or separate resource
      oauth2_client_secret = ""
    }
  }

  depends_on = [google_project_service.compute]
}

# URL map - routes all traffic to the backend
resource "google_compute_url_map" "preview" {
  name            = "splicer-preview-url-map"
  description     = "URL map for Splicer preview subdomain routing"
  default_service = google_compute_backend_service.preview.id
}

# Certificate Manager resources for wildcard SSL certificate
# Wildcard certificates require DNS authorization

# DNS Authorization for wildcard domain
resource "google_certificate_manager_dns_authorization" "preview" {
  name        = "splicer-preview-dns-auth"
  description = "DNS authorization for wildcard preview certificate"
  domain      = var.preview_domain

  depends_on = [google_project_service.certificatemanager]
}

# Wildcard certificate using Certificate Manager
resource "google_certificate_manager_certificate" "preview" {
  name        = "splicer-preview-wildcard-cert"
  description = "Wildcard certificate for preview subdomains"

  managed {
    domains = ["*.${var.preview_domain}"]
    dns_authorizations = [google_certificate_manager_dns_authorization.preview.id]
  }

  depends_on = [google_project_service.certificatemanager]
}

# Certificate map to attach certificate to load balancer
resource "google_certificate_manager_certificate_map" "preview" {
  name        = "splicer-preview-cert-map"
  description = "Certificate map for preview subdomains"

  depends_on = [google_project_service.certificatemanager]
}

# Certificate map entry for wildcard
resource "google_certificate_manager_certificate_map_entry" "preview" {
  name         = "splicer-preview-cert-entry"
  description  = "Certificate map entry for wildcard preview"
  map          = google_certificate_manager_certificate_map.preview.name
  certificates = [google_certificate_manager_certificate.preview.id]
  matcher      = "PRIMARY"
}

# Target HTTPS proxy - terminates SSL using Certificate Manager
resource "google_compute_target_https_proxy" "preview" {
  name            = "splicer-preview-https-proxy"
  url_map         = google_compute_url_map.preview.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.preview.id}"

  # Optional: Use custom SSL policy for TLS version requirements
  ssl_policy = var.ssl_policy != "" ? var.ssl_policy : null
}

# Global forwarding rule - entry point for HTTPS traffic
resource "google_compute_global_forwarding_rule" "preview_https" {
  name                  = "splicer-preview-https-rule"
  description           = "HTTPS forwarding rule for Splicer preview subdomains"
  target                = google_compute_target_https_proxy.preview.id
  port_range            = "443"
  ip_address            = google_compute_global_address.preview_lb.address
  load_balancing_scheme = "EXTERNAL_MANAGED"

  depends_on = [google_project_service.compute]
}

# Optional: HTTP to HTTPS redirect
resource "google_compute_url_map" "preview_redirect" {
  name = "splicer-preview-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "preview_redirect" {
  name    = "splicer-preview-http-proxy"
  url_map = google_compute_url_map.preview_redirect.id
}

resource "google_compute_global_forwarding_rule" "preview_http" {
  name                  = "splicer-preview-http-rule"
  description           = "HTTP to HTTPS redirect for Splicer preview subdomains"
  target                = google_compute_target_http_proxy.preview_redirect.id
  port_range            = "80"
  ip_address            = google_compute_global_address.preview_lb.address
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
