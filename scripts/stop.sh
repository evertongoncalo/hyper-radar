#!/usr/bin/env sh
# Paragem local do HyperRadar (Linux/macOS): servidor (encerramento limpo) e Postgres (dados mantidos).
set -eu
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "[HyperRadar] Erro: Node.js não encontrado." >&2
  exit 1
fi

exec node scripts/local.mjs parar
