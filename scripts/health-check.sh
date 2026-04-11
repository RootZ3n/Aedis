#!/bin/bash
# Aedis Health Check — curls all four services, color coded

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

services=(
  "Aedis:18796:/health"
  "Portum:18797:/health"
  "Squidley API:18791:/health"
  "Crucibulum:18795:/"
)

all_up=true

for entry in "${services[@]}"; do
  name="${entry%%:*}"
  rest="${entry#*:}"
  port="${rest%%:*}"
  path="${rest#*:}"

  http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}${path}" 2>/dev/null || echo "000")

  if [[ "$http_code" =~ ^[2][0][0-9]$ ]]; then
    echo -e "${GREEN}[UP]   ${name} (${port}) — HTTP ${http_code}${NC}"
  elif [[ "$http_code" =~ ^[3][0-9][0-9]$ ]]; then
    echo -e "${YELLOW}[REDIR] ${name} (${port}) — HTTP ${http_code}${NC}"
  else
    echo -e "${RED}[DOWN] ${name} (${port}) — HTTP ${http_code}${NC}"
    all_up=false
  fi
done

echo ""
if $all_up; then
  echo -e "${GREEN}All services healthy ✓${NC}"
  exit 0
else
  echo -e "${RED}One or more services down${NC}"
  exit 1
fi
