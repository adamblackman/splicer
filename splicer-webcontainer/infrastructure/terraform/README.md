# Splicer Preview Subdomain Routing - Terraform

This Terraform configuration sets up the infrastructure for subdomain-based preview routing:
`{session_id}.preview.yourdomain.com`

## Architecture

```
Client Browser
      │
      ▼
DNS Wildcard (*.preview.domain)
      │
      ▼
Global HTTPS Load Balancer
      │
      ├─► Wildcard SSL Certificate (*.preview.domain)
      │
      ▼
Serverless NEG
      │
      ▼
Cloud Run Service
```

## Prerequisites

1. **Google Cloud Project** with billing enabled
2. **gcloud CLI** installed and authenticated
3. **Terraform** >= 1.0 installed
4. **Existing Cloud Run service** deployed (via `scripts/deploy.sh`)
5. **Domain** you control for DNS configuration

## Quick Start

```bash
# 1. Navigate to terraform directory
cd infrastructure/terraform

# 2. Copy and edit variables file
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# 3. Initialize Terraform
terraform init

# 4. Preview changes
terraform plan

# 5. Apply changes
terraform apply
```

## DNS Configuration

### Option A: Cloud DNS (Managed by Terraform)

Set `manage_dns = true` in your `terraform.tfvars`. Terraform will create:
- DNS managed zone
- Wildcard A record
- CAA record for certificate issuance

After apply, configure your domain registrar to use the nameservers from the output.

### Option B: External DNS (Cloudflare, Route53, etc.)

Set `manage_dns = false` (default). After `terraform apply`:

1. Get the load balancer IP from output:
   ```bash
   terraform output load_balancer_ip
   ```

2. Add DNS records at your provider:
   ```
   Type: A
   Name: *.preview
   Value: <load_balancer_ip>
   TTL: 300
   
   Type: CAA
   Name: preview.yourdomain.com
   Value: 0 issue "pki.goog"
   ```

## SSL Certificate Provisioning

The Google-managed SSL certificate is provisioned automatically but requires:

1. DNS configured correctly (A record pointing to load balancer IP)
2. DNS propagation (can take up to 48 hours, usually faster)
3. Certificate provisioning (up to 60 minutes after DNS is correct)

Check certificate status:
```bash
gcloud compute ssl-certificates describe splicer-preview-wildcard-cert --global
```

## Updating Cloud Run

After Terraform is applied, update your Cloud Run deployment with new environment variables:

```bash
gcloud run services update splicer-webcontainer \
  --region=us-east5 \
  --set-env-vars="PREVIEW_DOMAIN=preview.yourdomain.com,USE_SUBDOMAIN_ROUTING=true"
```

Or update `scripts/deploy.sh` to include these variables.

## Variables

| Name | Description | Default | Required |
|------|-------------|---------|----------|
| `project_id` | GCP project ID | - | Yes |
| `preview_domain` | Domain for previews (e.g., preview.splicer.run) | - | Yes |
| `region` | Cloud Run region | us-east5 | No |
| `cloud_run_service_name` | Name of Cloud Run service | splicer-webcontainer | No |
| `manage_dns` | Create Cloud DNS zone | false | No |
| `enable_cdn` | Enable Cloud CDN | false | No |

## Outputs

| Name | Description |
|------|-------------|
| `load_balancer_ip` | IP address for DNS A record |
| `ssl_certificate_name` | Certificate resource name |
| `dns_instructions` | Manual DNS setup instructions |
| `environment_variables` | Env vars for Cloud Run |

## Troubleshooting

### Certificate stuck in PROVISIONING

1. Verify DNS A record points to correct IP
2. Check CAA record allows `pki.goog`
3. Wait up to 60 minutes after DNS change
4. Check status: `gcloud compute ssl-certificates describe <name> --global`

### 502 Bad Gateway

1. Verify Cloud Run service is running
2. Check backend service health
3. Ensure serverless NEG points to correct service

### WebSocket not connecting

1. Backend timeout should be >= 3600s (set in `load_balancer.tf`)
2. Verify session affinity is enabled
3. Check browser console for specific errors

## Cleanup

To destroy all resources:

```bash
terraform destroy
```

**Warning**: This will delete the load balancer and static IP. Update DNS before destroying to avoid downtime.
