#!/bin/bash
# =============================================================================
# deploy.sh — Sobe o gam-puppeteer-service no servidor
# Rode este script UMA VEZ do seu PC para fazer o deploy inicial.
# Para atualizações de código, rode novamente.
# =============================================================================

SERVER="root@143.198.183.17"
REMOTE_DIR="/opt/gam-puppeteer-service"

set -e
echo "==> Deploy: gam-puppeteer-service"

# 1. Cria diretório no servidor
ssh "$SERVER" "mkdir -p $REMOTE_DIR"

# 2. Copia o código (exclui node_modules e browser-data)
echo "--> Enviando código..."
rsync -avz --exclude='node_modules' --exclude='browser-data' \
  "$(dirname "$0")/../" \
  "$SERVER:$REMOTE_DIR/src/"

# 3. (Opcional) Copia o browser-data local → servidor para manter sessão do Google
# Descomente se quiser transferir a sessão atual:
# echo "--> Enviando browser-data (sessão do Chrome)..."
# rsync -avz "$(dirname "$0")/../../gam-config-puppeteer/browser-data/" \
#   "$SERVER:$REMOTE_DIR/browser-data/"

# 4. Sobe o container no servidor
echo "--> Subindo Docker..."
ssh "$SERVER" "cd $REMOTE_DIR/src && docker compose -f gam-puppeteer-service/docker-compose.yml up -d --build"

echo ""
echo "==> Deploy concluído!"
echo "    Health: http://143.198.183.17:3002/health (ou via Nginx: /gam-puppeteer/health)"
