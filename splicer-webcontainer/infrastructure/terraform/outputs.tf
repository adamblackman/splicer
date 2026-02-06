# Outputs for Splicer Preview Subdomain Routing

output "load_balancer_ip" {
  description = "Static IP address of the load balancer. Use this for DNS A record."
  value       = google_compute_global_address.preview_lb.address
}

output "ssl_certificate_name" {
  description = "Name of the managed SSL certificate"
  value       = google_certificate_manager_certificate.preview.name
}

output "ssl_certificate_domains" {
  description = "Domains covered by the SSL certificate"
  value       = ["*.${var.preview_domain}"]
}

output "dns_authorization_record" {
  description = "CNAME record required for DNS authorization (add this to your DNS)"
  value       = {
    type  = "CNAME"
    name  = google_certificate_manager_dns_authorization.preview.dns_resource_record[0].name
    value = google_certificate_manager_dns_authorization.preview.dns_resource_record[0].data
  }
}

output "backend_service_name" {
  description = "Name of the backend service"
  value       = google_compute_backend_service.preview.name
}

output "neg_name" {
  description = "Name of the serverless NEG"
  value       = google_compute_region_network_endpoint_group.preview_neg.name
}

output "dns_instructions" {
  description = "Instructions for DNS configuration"
  value       = var.manage_dns ? "DNS is managed by Terraform via Cloud DNS" : <<-EOT
    
    Add these DNS records at your domain provider:
    
    === RECORD 1: Certificate Validation (CNAME) ===
    Type:  CNAME
    Name:  ${google_certificate_manager_dns_authorization.preview.dns_resource_record[0].name}
    Value: ${google_certificate_manager_dns_authorization.preview.dns_resource_record[0].data}
    
    === RECORD 2: Wildcard Subdomain (A) ===
    Type:  A
    Name:  *.preview
    Value: ${google_compute_global_address.preview_lb.address}
    
    === RECORD 3: CAA (optional but recommended) ===
    Type:  CAA
    Name:  ${var.preview_domain}
    Value: 0 issue "pki.goog"
    
  EOT
}

output "ssl_certificate_status" {
  description = "Status of SSL certificate provisioning"
  value       = <<-EOT
    
    SSL Certificate: ${google_certificate_manager_certificate.preview.name}
    Domain: *.${var.preview_domain}
    
    IMPORTANT: You must add TWO DNS records:
    
    1. CNAME record for certificate validation (see dns_authorization_record output)
    2. A record for wildcard subdomain: *.preview -> ${google_compute_global_address.preview_lb.address}
    
    The certificate will be provisioned after the CNAME record is verified.
    This can take 15-60 minutes after DNS propagation.
    
    Check certificate status with:
    gcloud certificate-manager certificates describe ${google_certificate_manager_certificate.preview.name}
    
  EOT
}

output "environment_variables" {
  description = "Environment variables to set for Cloud Run"
  value       = <<-EOT
    
    Add these environment variables to your Cloud Run deployment:
    
    PREVIEW_DOMAIN=${var.preview_domain}
    USE_SUBDOMAIN_ROUTING=true
    
  EOT
}

# DNS nameservers (only if managing DNS)
output "dns_nameservers" {
  description = "Nameservers for the DNS zone (only if manage_dns=true). Configure these at your domain registrar."
  value       = var.manage_dns ? google_dns_managed_zone.preview[0].name_servers : []
}
