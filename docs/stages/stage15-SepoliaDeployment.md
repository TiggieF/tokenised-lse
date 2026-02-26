# Stage 15 — Sepolia Deployment and Hosting

## Objective

Execute production-style testnet rollout with:

- contracts on Sepolia
- backend on Render Web Service
- frontend on Render Static Site
- runtime state in Render Postgres only (no production JSON runtime state)

---

## Scope

- deploy contract suite to Sepolia
- verify contracts on Etherscan
- run backend on Render against Sepolia with Postgres runtime storage
- deploy frontend on Render and connect to hosted backend
- execute smoke tests and publish release artifacts

---

## Target Runtime Architecture

1. Chain
- network: `Sepolia`
- chain id: `11155111`
- contract address source: `deployments/sepolia.json`

2. Backend
- platform: Render Web Service
- runtime: Node.js
- responsibilities:
  - chain reads and writes
  - indexer sync to Postgres projections
  - APIs for markets, trade, sell, portfolio, transactions, award, gas, admin, dividends
- storage mode: Postgres only in production

3. Frontend
- platform: Render Static Site
- consumes backend base URL from environment
- wallet expected network: Sepolia

4. Database
- platform: Render Postgres
- stores previous runtime JSON domains:
  - indexer state and projections
  - autotrade state
  - admin session controls
  - merkle dividend artifacts
  - gas reports

---

## Final Output Structure (Monorepo Target)

```text
tokenised-lse/
  apps/
    backend/
      src/
        index.js
        config/
          env.js
          network.js
          contracts.js
        chain/
          rpcClient.js
          contracts/
            interfaces.js
            calls.js
            tx.js
        modules/
          indexer/
            syncLoop.js
            events/
              orderbook.js
              transfers.js
              leveraged.js
            projector.js
          autotrade/
            engine.js
            rulesService.js
          portfolio/
            summaryService.js
          dividends/
            snapshotService.js
            merkleService.js
          award/
            epochService.js
          market/
            fmpService.js
            yahooFallback.js
          gas/
            gasPackService.js
            walletGasService.js
        db/
          client.js
          migrations/
          repositories/
            indexerStateRepo.js
            ordersRepo.js
            fillsRepo.js
            cancellationsRepo.js
            transfersRepo.js
            cashflowsRepo.js
            leveragedRepo.js
            autotradeRulesRepo.js
            symbolStatusRepo.js
            awardSessionRepo.js
            merkleEpochRepo.js
            merkleClaimsRepo.js
            gasReportsRepo.js
        api/
          routes/
            health.routes.js
            contracts.routes.js
            market.routes.js
            orderbook.routes.js
            portfolio.routes.js
            txs.routes.js
            dividends.routes.js
            leveraged.routes.js
            award.routes.js
            autotrade.routes.js
            gas.routes.js
            admin.routes.js
          middleware/
            errorHandler.js
            walletValidation.js
      package.json
    frontend/
      public/
      src/
        pages/
          markets/
          portfolio/
          transactions/
          trade/
          sell/
          ttoken/
          award/
          gas/
          admin/
        components/
        services/
          apiClient.js
          wallet.js
          formatters.js
        state/
          session/
          live-updates/
          selected-wallet/
      package.json
  contracts/
  deployments/
    localhost.json
    sepolia.json
  scripts/
    deploy/
      localhost/
      sepolia/
    ops/
      smoke/
  docs/
    deployment-sepolia.md
    architecture.md
```

---

## Render Frontend Hosting (Exact Setup)

Use one Render **Static Site** for frontend.

1. Service root
- choose frontend app root (target folder after refactor: `apps/frontend`)

2. Build
- build command:
  - `npm ci && npm run build`
- publish directory:
  - `dist` (or your frontend output folder)

3. Environment variables
- set:
  - `VITE_API_BASE_URL=https://<your-backend-service>.onrender.com`

4. Routing
- if SPA routing is used, add rewrite rule:
  - source: `/*`
  - destination: `/index.html`
  - action: rewrite

5. Wallet/network behavior
- frontend must prompt or enforce Sepolia network
- backend API URL must point to Render backend URL

6. Post-deploy checks
- page shell loads
- wallet connect works
- page APIs hit Render backend successfully
- CORS allows frontend domain

---

## Acceptance Criteria

1. Sepolia addresses are deployed, verified, and saved in `deployments/sepolia.json`.
2. Backend is live on Render and uses Postgres as runtime source of truth.
3. Frontend is live on Render and points to backend via `VITE_API_BASE_URL`.
4. End-to-end smoke tests pass on Sepolia and are documented.
5. Release artifacts are committed and tagged.

---

## Primary Runbook

Use:

- `docs/deployment-sepolia.md`

This is the canonical deployment checklist with:

- environment setup
- deployment order
- role wiring
- hosting checklist
- rollback and recovery
- evidence collection
- persistent storage guidance for backend runtime state
