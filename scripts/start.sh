#!/usr/bin/env sh
# Arranque local do HyperRadar (Linux/macOS): Postgres, migrações, build e servidor em 127.0.0.1.
# A lógica está em scripts/local.mjs; aqui só se verifica o Node.js.
set -eu
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "[HyperRadar] Erro: Node.js não encontrado. Instale o Node.js 22 ou superior (https://nodejs.org/)." >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "[HyperRadar] Erro: é necessário o Node.js 22 ou superior (encontrado $(node -v))." >&2
  exit 1
fi

exec node scripts/local.mjs iniciar
