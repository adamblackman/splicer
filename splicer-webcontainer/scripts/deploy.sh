#!/bin/bash
# Deploy Splicer Webcontainer to Google Cloud Run
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Docker installed
#   - Project configured in gcloud
#
# Usage:
#   ./scripts/deploy.sh [PROJECT_ID] [REGION] [SERVICE_NAME]
#
# Examples:
#   ./scripts/deploy.sh my-project us-central1 preview-orchestrator

set -euo pipefail

# Configuration (override with environment variables or arguments)
PROJECT_ID="${1:-${GOOGLE_CLOUD_PROJECT:-your-gcp-project-id}}"
REGION="${2:-${CLOUD_RUN_REGION:-your-gcp-region}}"
SERVICE_NAME="${3:-splicer-webcontainer}"

# Registry configuration
ARTIFACT_REGISTRY="${REGION}-docker.pkg.dev"
REPOSITORY="splicer"
IMAGE_NAME="preview-orchestrator"
TAG="${TAG:-latest}"

# Full image path
FULL_IMAGE="${ARTIFACT_REGISTRY}/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${TAG}"

# Get project number for constructing the service URL
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)" 2>/dev/null || echo "")
if [[ -n "${PROJECT_NUMBER}" ]]; then
    BASE_URL="https://${SERVICE_NAME}-${PROJECT_NUMBER}.${REGION}.run.app"
else
    BASE_URL=""
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Validation
if [[ -z "${PROJECT_ID}" ]]; then
    echo -e "${RED}Error: PROJECT_ID is required${NC}"
    echo "Usage: $0 <PROJECT_ID> [REGION] [SERVICE_NAME]"
    echo "Or set GOOGLE_CLOUD_PROJECT environment variable"
    exit 1
fi

echo -e "${CYAN}Deploying Splicer Webcontainer${NC}"
echo -e "  Project:  ${PROJECT_ID}"
echo -e "  Region:   ${REGION}"
echo -e "  Service:  ${SERVICE_NAME}"
echo -e "  Image:    ${FULL_IMAGE}"
echo ""

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

# Step 1: Configure Docker for Artifact Registry
echo -e "${YELLOW}Step 1: Configuring Docker for Artifact Registry...${NC}"
gcloud auth configure-docker "${ARTIFACT_REGISTRY}" --quiet

# Step 2: Create Artifact Registry repository if it doesn't exist
echo -e "${YELLOW}Step 2: Ensuring Artifact Registry repository exists...${NC}"
gcloud artifacts repositories describe "${REPOSITORY}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" 2>/dev/null || \
gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --description="Splicer container images"

# Step 3: Build the image
echo -e "${YELLOW}Step 3: Building Docker image...${NC}"
docker build \
    --platform linux/amd64 \
    --tag "${FULL_IMAGE}" \
    --file Dockerfile \
    .

# Step 4: Push to Artifact Registry
echo -e "${YELLOW}Step 4: Pushing image to Artifact Registry...${NC}"
docker push "${FULL_IMAGE}"

# Step 5: Deploy to Cloud Run
echo -e "${YELLOW}Step 5: Deploying to Cloud Run...${NC}"

# Note: Secrets should be created in Secret Manager first:
# gcloud secrets create SUPABASE_URL --data-file=- <<< "your-url"
# gcloud secrets create SUPABASE_SECRET_KEY --data-file=- <<< "your-key"
# echo -n "$(openssl rand -hex 32)" | gcloud secrets create CLOUD_RUN_WEBCONTAINER_SECRET --data-file=-

# Subdomain routing configuration (enabled by default for production)
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-preview.spliceronline.com}"
USE_SUBDOMAIN_ROUTING="${USE_SUBDOMAIN_ROUTING:-true}"

# Build env vars string
ENV_VARS="ENVIRONMENT=production"
ENV_VARS="${ENV_VARS},SESSION_IDLE_TIMEOUT=600"
ENV_VARS="${ENV_VARS},SESSION_MAX_LIFETIME=3600"
ENV_VARS="${ENV_VARS},SESSION_STARTUP_TIMEOUT=180"
if [[ -n "${BASE_URL}" ]]; then
    ENV_VARS="${ENV_VARS},BASE_URL=${BASE_URL}"
    echo -e "  Base URL: ${BASE_URL}"
fi

# Add subdomain routing config if enabled
if [[ "${USE_SUBDOMAIN_ROUTING}" == "true" && -n "${PREVIEW_DOMAIN}" ]]; then
    ENV_VARS="${ENV_VARS},USE_SUBDOMAIN_ROUTING=true"
    ENV_VARS="${ENV_VARS},PREVIEW_DOMAIN=${PREVIEW_DOMAIN}"
    echo -e "  Preview Domain: *.${PREVIEW_DOMAIN}"
    echo -e "  Subdomain Routing: enabled"
fi

gcloud run deploy "${SERVICE_NAME}" \
    --image="${FULL_IMAGE}" \
    --platform=managed \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --allow-unauthenticated \
    --port=8080 \
    --memory=4Gi \
    --cpu=2 \
    --min-instances=0 \
    --max-instances=10 \
    --timeout=3600 \
    --concurrency=80 \
    --session-affinity \
    --set-env-vars="${ENV_VARS}" \
    --set-secrets="SUPABASE_URL=SUPABASE_URL:latest" \
    --set-secrets="SUPABASE_SECRET_KEY=SUPABASE_SECRET_KEY:latest" \
    --set-secrets="CLOUD_RUN_WEBCONTAINER_SECRET=CLOUD_RUN_WEBCONTAINER_SECRET:latest"

# Step 6: Get service URL
echo -e "${YELLOW}Step 6: Getting service URL...${NC}"
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --platform=managed \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --format="value(status.url)")

echo ""
echo -e "${GREEN}✓ Deployment complete!${NC}"
echo ""
echo -e "${CYAN}Service URL:${NC} ${SERVICE_URL}"
echo ""
echo -e "${YELLOW}API Endpoints:${NC}"
echo "  Health:   ${SERVICE_URL}/health"
echo "  Ready:    ${SERVICE_URL}/ready"
echo "  Sessions: ${SERVICE_URL}/api/sessions"
echo ""
echo -e "${YELLOW}Create a preview session (requires X-API-Key header):${NC}"
echo "curl -X POST ${SERVICE_URL}/api/sessions \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -H 'X-API-Key: <CLOUD_RUN_WEBCONTAINER_SECRET>' \\"
echo "  -d '{\"repo_owner\": \"owner\", \"repo_name\": \"repo\", \"repo_ref\": \"main\"}'"