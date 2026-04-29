#!/bin/bash
set -euo pipefail
docker rm -f api-test 2>/dev/null || true
cat > /tmp/api-server.py <<'PYEOF'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "service": "voiceforge-api-stub"}).encode())
        elif self.path.startswith("/api/v1/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"message": "VoiceForge API placeholder", "path": self.path}).encode())
        else:
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "not found"}).encode())

server = HTTPServer(("0.0.0.0", 4000), Handler)
server.serve_forever()
PYEOF

docker run -d --name api-test --restart unless-stopped \
  -p 127.0.0.1:4000:4000 \
  -v /tmp/api-server.py:/app/server.py:ro \
  python:3-alpine python /app/server.py

sleep 2
curl -sf http://127.0.0.1:4000/health && echo " API_HEALTH_OK"
