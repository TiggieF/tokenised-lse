#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f ".env.sepolia" ]]; then
  echo ".env.sepolia not found. Create it first."
  exit 1
fi

set -a
. ./.env.sepolia
set +a

if [[ -z "${SEPOLIA_RPC_URL:-}" ]]; then
  echo "SEPOLIA_RPC_URL is missing in .env.sepolia"
  exit 1
fi

CHAIN_ID_JSON="$(curl -s -X POST "$SEPOLIA_RPC_URL" -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' || true)"
if [[ "$CHAIN_ID_JSON" != *"0xaa36a7"* ]]; then
  echo "RPC is not Sepolia (expected chainId 0xaa36a7). Response: $CHAIN_ID_JSON"
  exit 1
fi

echo "[1/6] Installing dependencies"
npm install

echo "[2/6] Compiling contracts"
npm run compile

echo "[3/6] Deploying contracts to Sepolia"
npm run deploy:sepolia

echo "[4/6] Seeding on-chain prices"
npm run seed:prices:sepolia

echo "[5/6] Starting UI/backend server on :3000"
mkdir -p logs
if lsof -tiTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  kill "$(lsof -tiTCP:3000 -sTCP:LISTEN | head -n1)" || true
  sleep 1
fi

nohup bash -lc 'set -a; . ./.env.sepolia; set +a; DEFAULT_NETWORK=sepolia node scripts/ui/html/server.js > logs/ui-sepolia.log 2>&1' >/dev/null 2>&1 &
UI_PID=$!
sleep 4

cleanup_on_fail() {
  if [[ -n "${UI_PID:-}" ]] && kill -0 "$UI_PID" >/dev/null 2>&1; then
    kill "$UI_PID" >/dev/null 2>&1 || true
  fi
}

echo "[6/6] Running smoke checks"
for endpoint in \
  "http://127.0.0.1:3000/api/admin/symbols/status" \
  "http://127.0.0.1:3000/api/leveraged/products" \
  "http://127.0.0.1:3000/api/leveraged/quote?mode=MINT&productSymbol=AAPL5L&ttokenInWei=1000000000000000000"
do
  BODY="$(curl -s "$endpoint" || true)"
  if [[ -z "$BODY" ]]; then
    echo "Smoke check failed: empty response from $endpoint"
    cleanup_on_fail
    exit 1
  fi
  if [[ "$BODY" == *"\"error\""* ]]; then
    echo "Smoke check failed at $endpoint"
    echo "$BODY"
    cleanup_on_fail
    exit 1
  fi
done

echo "Sepolia bootstrap complete."
echo "Server PID: $UI_PID"
echo "Logs: $ROOT_DIR/logs/ui-sepolia.log"
echo "Open: http://localhost:3000"
