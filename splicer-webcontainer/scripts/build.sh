#!/bin/bash
# Build Docker image for Splicer Webcontainer
#
# Usage:
#   ./scripts/build.sh [IMAGE_NAME] [TAG]
#
# Examples:
#   ./scripts/build.sh                          # Uses defaults
#   ./scripts/build.sh my-registry/preview-orchestrator v1.0.0

set -euo pipefail

# Configuration
IMAGE_NAME="${1:-splicer-webcontainer}"
TAG="${2:-latest}"
FULL_IMAGE="${IMAGE_NAME}:${TAG}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Building Docker image: ${FULL_IMAGE}${NC}"

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

# Build the image
docker build \
    --platform linux/amd64 \
    --tag "${FULL_IMAGE}" \
    --file Dockerfile \
    .

echo -e "${GREEN}✓ Build complete: ${FULL_IMAGE}${NC}"

# Show image size
echo -e "\n${YELLOW}Image details:${NC}"
docker images "${IMAGE_NAME}:${TAG}" --format "Size: {{.Size}}"

echo -e "\n${YELLOW}To run locally:${NC}"
echo "docker run -p 8080:8080 \\"
echo "  -e SUPABASE_URL=your-supabase-url \\"
echo "  -e SUPABASE_SECRET_KEY=your-secret-key \\"
echo "  ${FULL_IMAGE}"
