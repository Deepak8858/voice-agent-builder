#!/bin/bash
set -euo pipefail

# Deploy placeholder containers on Azure VM
docker rm -f api-test web-test 2>/dev/null || true

# API placeholder
docker run -d --name api-test --restart unless-stopped \
  -p 127.0.0.1:4000:4000 \
  node:20-alpine \
  sh -c 'node -e "const h=require(\"http\");h.createServer((req,res)=>{res.writeHead(req.url==\"/health\"?200:404,{\"Content-Type\":\"application/json\"});res.end(JSON.stringify({status:\"ok\",service:\"voiceforge-api-placeholder\"}));}).listen(4000)"'

# Web placeholder
docker run -d --name web-test --restart unless-stopped \
  -p 127.0.0.1:3000:80 \
  nginx:alpine

# Verify
sleep 2
curl -sf http://localhost:4000/health && echo "API OK"
curl -sf -o /dev/null http://localhost:3000 && echo "Web OK"
echo "Placeholder deployment complete"
