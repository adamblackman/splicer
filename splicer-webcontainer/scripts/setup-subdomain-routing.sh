#!/bin/bash
# Setup wildcard subdomain routing for Splicer Preview
#
# Cloud Run doesn't support wildcard domain mappings directly.
# This script sets up:
# 1. Global HTTP(S) Load Balancer
# 2. Serverless Network Endpoint Group (NEG) pointing to Cloud Run
# 3. Google-managed SSL certificate for wildcard domain
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Cloud Run service already deployed
#   - Domain DNS accessible (for verification)
#
# Usage:
#   ./scripts/setup-subdomain-routing.sh <PROJECT_ID> <REGION> <PREVIEW_DOMAIN>
#
# Example:
#   ./scripts/setup-subdomain-routing.sh my-project us-east5 preview.splicer.run
#
# After running this script:
#   1. Add DNS records as instructed
#   2. Wait for SSL certificate provisioning (can take 10-60 minutes)
#   3. Update deploy.sh with USE_SUBDOMAIN_ROUTING=true

set -euo pipefail

# Configuration
PROJECT_ID="${1:-}"
REGION="${2:-us-east5}"
PREVIEW_DOMAIN="${3:-}"  # e.g., preview.splicer.run
SERVICE_NAME="${4:-splicer-webcontainer}"

# Resource names
LB_NAME="splicer-preview-lb"
NEG_NAME="splicer-preview-neg"
BACKEND_NAME="splicer-preview-backend"
URL_MAP_NAME="splicer-preview-urlmap"
PROXY_NAME="splicer-preview-https-proxy"
CERT_NAME="splicer-preview-cert"
FORWARDING_RULE_NAME="splicer-preview-forwarding"
IP_NAME="splicer-preview-ip"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Validation
if [[ -z "${PROJECT_ID}" ]]; then
    echo -e "${RED}Error: PROJECT_ID is required${NC}"
    echo "Usage: $0 <PROJECT_ID> <REGION> <PREVIEW_DOMAIN>"
    exit 1
fi

if [[ -z "${PREVIEW_DOMAIN}" ]]; then
    echo -e "${RED}Error: PREVIEW_DOMAIN is required (e.g., preview.splicer.run)${NC}"
    exit 1
fi

echo -e "${CYAN}Setting up wildcard subdomain routing for Splicer Preview${NC}"
echo -e "  Project:        ${PROJECT_ID}"
echo -e "  Region:         ${REGION}"
echo -e "  Preview Domain: *.${PREVIEW_DOMAIN}"
echo -e "  Cloud Run:      ${SERVICE_NAME}"
echo ""

# Set project
gcloud config set project "${PROJECT_ID}"

# Step 1: Reserve a global static IP address
echo -e "${YELLOW}Step 1: Reserving global static IP address...${NC}"
if gcloud compute addresses describe "${IP_NAME}" --global &>/dev/null; then
    echo "  IP address ${IP_NAME} already exists"
else
    gcloud compute addresses create "${IP_NAME}" \
        --network-tier=PREMIUM \
        --ip-version=IPV4 \
        --global
fi

# Get the IP address
STATIC_IP=$(gcloud compute addresses describe "${IP_NAME}" \
    --global \
    --format="value(address)")
echo -e "  Static IP: ${GREEN}${STATIC_IP}${NC}"

# Step 2: Create Serverless NEG for Cloud Run
echo -e "${YELLOW}Step 2: Creating Serverless Network Endpoint Group...${NC}"
if gcloud compute network-endpoint-groups describe "${NEG_NAME}" --region="${REGION}" &>/dev/null; then
    echo "  NEG ${NEG_NAME} already exists"
else
    gcloud compute network-endpoint-groups create "${NEG_NAME}" \
        --region="${REGION}" \
        --network-endpoint-type=serverless \
        --cloud-run-service="${SERVICE_NAME}"
fi

# Step 3: Create backend service
echo -e "${YELLOW}Step 3: Creating backend service...${NC}"
if gcloud compute backend-services describe "${BACKEND_NAME}" --global &>/dev/null; then
    echo "  Backend service ${BACKEND_NAME} already exists"
else
    gcloud compute backend-services create "${BACKEND_NAME}" \
        --load-balancing-scheme=EXTERNAL_MANAGED \
        --global
fi

# Add NEG to backend service
echo "  Adding NEG to backend service..."
gcloud compute backend-services add-backend "${BACKEND_NAME}" \
    --global \
    --network-endpoint-group="${NEG_NAME}" \
    --network-endpoint-group-region="${REGION}" \
    2>/dev/null || echo "  NEG already attached to backend"

# Step 4: Create URL map
echo -e "${YELLOW}Step 4: Creating URL map...${NC}"
if gcloud compute url-maps describe "${URL_MAP_NAME}" &>/dev/null; then
    echo "  URL map ${URL_MAP_NAME} already exists"
else
    gcloud compute url-maps create "${URL_MAP_NAME}" \
        --default-service="${BACKEND_NAME}"
fi

# Step 5: Create Google-managed SSL certificate
echo -e "${YELLOW}Step 5: Creating Google-managed SSL certificate...${NC}"
echo "  This will create a certificate for:"
echo "    - ${PREVIEW_DOMAIN} (apex)"
echo "    - *.${PREVIEW_DOMAIN} (wildcard)"

if gcloud compute ssl-certificates describe "${CERT_NAME}" &>/dev/null; then
    echo "  SSL certificate ${CERT_NAME} already exists"
else
    # Note: Wildcard certificates require DNS authorization
    gcloud compute ssl-certificates create "${CERT_NAME}" \
        --domains="${PREVIEW_DOMAIN},*.${PREVIEW_DOMAIN}" \
        --global
fi

# Step 6: Create HTTPS target proxy
echo -e "${YELLOW}Step 6: Creating HTTPS target proxy...${NC}"
if gcloud compute target-https-proxies describe "${PROXY_NAME}" &>/dev/null; then
    echo "  HTTPS proxy ${PROXY_NAME} already exists"
    # Update the certificate in case it changed
    gcloud compute target-https-proxies update "${PROXY_NAME}" \
        --ssl-certificates="${CERT_NAME}" \
        2>/dev/null || true
else
    gcloud compute target-https-proxies create "${PROXY_NAME}" \
        --ssl-certificates="${CERT_NAME}" \
        --url-map="${URL_MAP_NAME}"
fi

# Step 7: Create global forwarding rule
echo -e "${YELLOW}Step 7: Creating global forwarding rule...${NC}"
if gcloud compute forwarding-rules describe "${FORWARDING_RULE_NAME}" --global &>/dev/null; then
    echo "  Forwarding rule ${FORWARDING_RULE_NAME} already exists"
else
    gcloud compute forwarding-rules create "${FORWARDING_RULE_NAME}" \
        --load-balancing-scheme=EXTERNAL_MANAGED \
        --network-tier=PREMIUM \
        --address="${IP_NAME}" \
        --target-https-proxy="${PROXY_NAME}" \
        --global \
        --ports=443
fi

# Step 8: Check certificate status
echo -e "${YELLOW}Step 8: Checking SSL certificate status...${NC}"
CERT_STATUS=$(gcloud compute ssl-certificates describe "${CERT_NAME}" \
    --format="value(managed.status)" 2>/dev/null || echo "UNKNOWN")
DOMAIN_STATUS=$(gcloud compute ssl-certificates describe "${CERT_NAME}" \
    --format="yaml(managed.domainStatus)" 2>/dev/null || echo "")

echo -e "  Certificate status: ${CERT_STATUS}"
echo -e "  Domain status:"
echo "${DOMAIN_STATUS}" | sed 's/^/    /'

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Setup complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

echo -e "${CYAN}REQUIRED DNS CONFIGURATION:${NC}"
echo ""
echo "Add the following DNS records to your domain:"
echo ""
echo "  ${YELLOW}Type   Name                      Value${NC}"
echo "  A      ${PREVIEW_DOMAIN}           ${STATIC_IP}"
echo "  A      *.${PREVIEW_DOMAIN}         ${STATIC_IP}"
echo ""
echo "Or if using CNAME (requires separate apex handling):"
echo "  CNAME  *.${PREVIEW_DOMAIN}         ${STATIC_IP}.bc.googleusercontent.com"
echo ""

if [[ "${CERT_STATUS}" != "ACTIVE" ]]; then
    echo -e "${YELLOW}SSL CERTIFICATE PROVISIONING:${NC}"
    echo ""
    echo "The SSL certificate is still provisioning. This typically takes 10-60 minutes"
    echo "after DNS records are properly configured."
    echo ""
    echo "Check certificate status:"
    echo "  gcloud compute ssl-certificates describe ${CERT_NAME} --format='yaml(managed)'"
    echo ""
    echo "Common issues:"
    echo "  - DNS records not propagated yet (check with: dig ${PREVIEW_DOMAIN})"
    echo "  - CAA records blocking Google (add: 0 issue \"pki.goog\")"
    echo ""
fi

echo -e "${CYAN}DEPLOY WITH SUBDOMAIN ROUTING:${NC}"
echo ""
echo "Once DNS is configured and certificate is active, deploy with:"
echo ""
echo "  PREVIEW_DOMAIN=${PREVIEW_DOMAIN} \\"
echo "  USE_SUBDOMAIN_ROUTING=true \\"
echo "  ./scripts/deploy.sh ${PROJECT_ID} ${REGION}"
echo ""

echo -e "${CYAN}TESTING:${NC}"
echo ""
echo "After deployment, create a session and access it at:"
echo "  https://{session_id}.${PREVIEW_DOMAIN}/?token={access_token}"
echo ""
echo "The Load Balancer URL is:"
echo "  https://${STATIC_IP} (will show certificate error until DNS is configured)"
echo ""
