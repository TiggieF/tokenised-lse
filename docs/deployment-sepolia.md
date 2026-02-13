# Sepolia Deployment Plan

## 1. Objective

Deploy the blockchain app stack to Sepolia with:

- deployed and verified contracts
- backend API connected to Sepolia
- hosted frontend connected to backend
- reproducible release process and smoke tests

---

## 2. Target Architecture

1. Contracts:
- network: Sepolia (`chainId 11155111`)
- deployment artifact: `deployments/sepolia.json`

2. Backend:
- Node/Express API
- reads/writes contract state through Sepolia RPC
- runs indexer in JSON-storage mode

3. Frontend:
- static hosting
- uses hosted backend API URL
- supports wallet connection on Sepolia

---

## 3. Prerequisites

1. Wallet and funds:
- deployer private key with Sepolia ETH
- optional operator key for periodic backend tasks

2. RPC provider:
- Alchemy/Infura/QuickNode Sepolia HTTPS endpoint
- optional WebSocket endpoint for faster indexing

3. Explorer API key:
- Etherscan API key for contract verification

4. Hosting targets:
- backend: Render/Railway/Fly.io/VM
- frontend: Vercel/Netlify/Cloudflare Pages

---

## 4. Environment Files

Create `.env.sepolia` (do not commit secrets):

```bash
NODE_ENV=production
CHAIN_ID=11155111
RPC_URL_HTTPS=https://sepolia.YOUR_RPC_PROVIDER
RPC_URL_WSS=wss://sepolia.YOUR_RPC_PROVIDER
DEPLOYER_PRIVATE_KEY=0x...
OPERATOR_PRIVATE_KEY=0x...
ETHERSCAN_API_KEY=...

# Backend
PORT=8080
CORS_ORIGIN=https://YOUR_FRONTEND_DOMAIN
INDEXER_DATA_DIR=./data/indexer

# App behavior
INDEXER_START_BLOCK=0
DEFAULT_NETWORK=sepolia
SYMBOLS_FILE=./scripts/ui/data/symbols/nasdaq.json
```

Commit `.env.sepolia.example` with placeholders only.

---

## 5. Deployment Sequence

## 5.1 Contract deployment (Sepolia)

1. Compile:
- `npm run compile`

2. Deploy in stage order:
- `TToken`
- `ListingsRegistry`
- `EquityTokenFactory`
- `PriceFeed` (if still used by components)
- `OrderBookDEX`
- `Dividends`
- `Award`
- `PortfolioAggregator`
- `LeveragedTokenFactory`
- `LeveragedProductRouter`

3. Persist addresses and ABIs:
- write `deployments/sepolia.json`
- include deployed block numbers

4. Grant/assign required roles and references:
- registry listing role to factory
- DEX references (ttoken, registry, feeds where relevant)
- award contract wired to DEX if used
- router permissions for leveraged mint/burn

## 5.2 Contract verification

1. Verify each contract on Sepolia Etherscan.
2. Save verification links in release notes.

---

## 6. Backend Release Plan

## 6.1 Build/runtime configuration

1. Load `deployments/sepolia.json` at startup.
2. Fail fast if required addresses are missing.
3. Start indexer with configured `INDEXER_START_BLOCK`.

## 6.2 Hosting process

1. Provision service.
2. Set environment variables.
3. Deploy backend branch/tag.
4. Health-check endpoints:
- `/health`
- `/api/contracts`
- `/api/market/status`

## 6.3 Operational tasks

1. Ensure indexer process starts and writes JSON snapshots.
2. Confirm admin NASDAQ symbol list endpoint works from local file.
3. Enable basic logs for tx submission failures and RPC errors.

---

## 7. Frontend Release Plan

1. Set production API base URL.
2. Build static assets.
3. Deploy to hosting platform.
4. Validate wallet network prompt points to Sepolia.
5. Confirm pages:
- chart / trade / sell
- portfolio
- transactions
- admin

---

## 8. Post-Deployment Smoke Test (Mandatory)

Run with two Sepolia wallets:

1. Wallet A claims TToken airdrop.
2. Admin lists one NASDAQ symbol from local list.
3. Wallet A places a buy order; Wallet B places matching sell.
4. Confirm fill appears in transactions (wallet-scoped).
5. Cancel an open order from transactions page.
6. Mint and unwind one leveraged product (`3x` or `5x` long).
7. Confirm portfolio values and transaction records update.
8. Freeze symbol and verify trading disabled.
9. Delist symbol and verify it is not tradable.

Capture tx hashes and screenshots for report evidence.

---

## 9. Rollback and Recovery

1. Keep previous backend release artifact and env snapshot.
2. If deployment fails:
- rollback backend image/version
- keep frontend on maintenance banner if needed

3. If contract deployment failed mid-sequence:
- mark invalid deployment artifact
- redeploy full suite to clean `sepolia-vN` release tag
- update backend to latest valid addresses only

---

## 10. Release Artifacts Checklist

1. `deployments/sepolia.json` complete
2. `docs/sepolia-addresses.md` with explorer links
3. `.env.sepolia.example` committed
4. smoke test report committed (`docs/sepolia-smoke-test.md`)
5. final release tag created in git

---

## 11. Suggested Stage Placement

Recommended order:

1. Complete Stage 10 to 13 features
2. Complete Stage 14 invariant/fuzz validation
3. Execute this Sepolia deployment plan as Stage 15

