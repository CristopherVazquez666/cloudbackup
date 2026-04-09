#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

cd "$ROOT_DIR"

echo "Construyendo imagen local de desarrollo..."
docker build -f Dockerfile.dev -t bovedix-local .

echo "Reiniciando contenedor local previo si existe..."
docker rm -f bovedix-local >/dev/null 2>&1 || true

echo "Levantando Bovedix en localhost:3000..."
docker run \
  --name bovedix-local \
  --init \
  -it \
  -p 3000:3000 \
  --env-file .env.local \
  -e NODE_ENV=development \
  -v "$ROOT_DIR:/app" \
  -v bovedix_node_modules:/app/node_modules \
  -v bovedix_dev_data:/app/data \
  bovedix-local \
  npm run dev
