# System Architecture – Tokenised LSE DEX

## 1. High-Level Layers  
- **Blockchain Layer**: Solidity contracts on EVM (Hardhat local → Sepolia testnet)  
- **Backend Layer**: Node.js + Express (admin relay, API endpoints, caches)  
- **Frontend Layer**: HTML + JS + Chart.js/Recharts (UI for wallet connect, trading, analytics)  
- **Data / Networks**: Finnhub API for stock data, Ethereum RPC for blockchain interaction  

## 2. Smart Contracts Overview  
| Contract | Purpose | Key Roles |
|----------|---------|-----------|
| `TToken.sol` | Base stable token used for trading and rewards | DEFAULT_ADMIN_ROLE, MINTER_ROLE |
| `EquityToken.sol` | ERC-20 token representing a company’s shares | Controlled via Factory |
| `EquityTokenFactory.sol` | Deploys new EquityTokens and assigns roles | LISTER_ROLE |
| `ListingsRegistry.sol` | Maintains mapping symbol → token address | LISTER_ROLE |
| `PriceFeed.sol` | Stores last price (pence) + timestamp for each symbol | ORACLE_ROLE |
| `OrderBookDEX.sol` | On-chain limit order book engine | Trades TToken ↔ EquityTokens, partial fills |
| `Dividends.sol` | Snapshot-based payouts in TToken to stock holders | DIVIDEND_ROLE |
| `FeePool.sol` | Tracks trading volumes; pays 3 TToken per epoch to top trader | REWARD_MANAGER_ROLE |
| `PortfolioAggregator.sol` | View functions returning user holdings & total platform value | Read-only |

## 3. Backend Architecture  
- Runs as privileged relay: uses `ADMIN_PRIVATE_KEY` in `.env` to sign admin transactions.  
- Provides REST endpoints:  
  - `/admin/listStock` → via EquityTokenFactory & ListingsRegistry  
  - `/admin/updatePrice` → via PriceFeed (pulls from Finnhub API)  
  - `/admin/declareDividend` → via Dividends contract  
  - `/admin/finalizeEpoch` → via FeePool  
- Maintains a lightweight SQLite (or future PostgreSQL) for caching user wallet connect status, optional holdings cache, and admin logs.

## 4. Frontend Architecture  
- Wallet Connect flow (via MetaMask/Coinbase Wallet).  
- Pages: Dashboard, Market List, Stock Detail (Summary, Holders, Profile), Trade Panel, Admin Panel.  
- Data sources:  
  - On-chain: token balances, orders, price feed contract  
  - Off-chain: Finnhub/Yahoo data for holders & profile  
- Real-time updates: Poll or subscribe to contract events for price updates, trades and epochs.

## 5. Data & Flow  
1. Admin sets up a token: deploy EquityToken → register symbol.  
2. Admin updates price: fetches from Finnhub → PriceFeed.setPrice(symbol, pricePence, ts).  
3. User connects wallet: Link address → receives 1 000 000 TToken airdrop if first time.  
4. User places limit order: OrderBookDEX.placeLimit(symbol, pricePence, qty, isBuy).  
   - Matching engine executes trade(s), partial fills allowed.  
   - Fee computed, fee routed to FeePool.  
5. FeePool accumulates volume data for each 3-minute epoch.  
6. After epoch ends, `finalizeEpoch()` identifies top trader → transfers 3 TToken reward.  
7. Admin declares dividend: Dividends.declare(symbol, totalTToken, claimUntil); users claim pro-rata.  
8. User views portfolio: PortfolioAggregator.getUserPortfolio(address) → Frontend displays pie & line charts.  
9. UI indicates Fresh/Stale: Fresh if price timestamp ≤60 s during market hours; otherwise Stale.

## 6. Deployment & Environment  
- Development: Hardhat local node, Node.js backend, static frontend served from local.  
- Testnet: Sepolia (or Base-Sepolia) RPC endpoint; verification via Hardhat “verify”.  
- Environment variables (via `.env`):  



- Conda environment recommended for Node.js + development tools (see `instructions.md`).

ADMIN_PRIVATE_KEY=
RPC_URL=
FINNHUB_API_KEY=d4699t1r01qj716fvnmgd4699t1r01qj716fvnn0

## 7. Security & Constraints  
- Access control: Only correct roles can perform sensitive functions.  
- Reentrancy & gas: Use `ReentrancyGuard`, gas-efficient structs.  
- Asset conservation: TToken + EquityToken balances before/after trades must balance ± fee.  
- Barriers: Codex or devs **must not implement features outside the defined stages** (see PRD barrier).

## 8. Interface Diagram (textual)  
[Frontend (browser)]
↕ ethers.js
[Backend (Node.js) ] ← REST → [Admin actions]
↕ RPC (Hardhat/Sepolia)
[EVM Blockchain with Contracts]

- Also: Finnhub API → Backend → PriceFeed  
- Blockchain events → Frontend updates

## 9. Barrier to Codex  
**DO NOT** proceed with features outside those listed in the Stage Development Plan.  
Any request for new functionality must be captured and added as a new stage or deferred.  
Contract logic, UI flows, backend routes must adhere exactly to approved stage deliverables.
