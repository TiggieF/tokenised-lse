# Progress Report

This document is a precise, technical handover of what is implemented and what is missing. It lists each module, its behavior, the data contracts, and the parameters used.

## 1) Runtime Topology and Entry Points

### 1.1 Runtime services
- Hardhat local chain on `http://127.0.0.1:8545`.
- Node and Express API server: `scripts/ui/html/server.js`.
- Frontend pages served from `scripts/ui/html/public/` plus the chart page under `scripts/ui/dataFetch/tsla-yahoo/chart.html`.
- Market data providers:
  - Financial Modeling Prep API for quote and stock info.
  - Yahoo Finance REST data as fallback.

### 1.2 Primary UI entry
- `scripts/ui/html/public/index.html` is the shell page with a sidebar and iframe.
- It loads one of the following iframe pages:
  - `/dataFetch/tsla-yahoo/chart.html` for Markets
  - `/portfolio.html`
  - `/ttoken.html`
  - `/trade.html`
  - `/admin.html`

## 2) Frontend Implementation Details

### 2.1 Shell page: `scripts/ui/html/public/index.html`

**DOM ids and roles**
- `wallet-status` is a clickable container that triggers wallet connection.
- `wallet-dot` toggles connected status styling.
- `wallet-account` and `wallet-hint` show connection state.
- `page-frame` is the iframe that loads other pages.
- `.nav-link` elements with `data-page` control navigation.

**Wallet logic**
- Calls `window.ethereum.request({ method: "eth_accounts" })` to read accounts.
- Calls `window.ethereum.request({ method: "eth_requestAccounts" })` to connect.
- Listens to `window.ethereum.on("accountsChanged")` and refreshes the iframe.

**Navigation logic**
- `loadPage(page)` sets `page-frame.src` and `page-frame.title`.
- Supported pages are `markets`, `portfolio`, `ttoken`, `trade`, `admin`.
- The default page is `markets`.

### 2.2 Markets: `scripts/ui/dataFetch/tsla-yahoo/chart.html`

**DOM ids**
- Controls: `controls`, `symbol`, `date`, `range`.
- Chart: `chart`.
- Status: `status`, `status span`.
- Live price panel: `live-symbol-label`, `live-price`, `live-change`, `live-open`, `live-updated`, `live-toggle`.
- Stock info panel: `info-updated`, `info-prev-close`, `info-open`, `info-day-range`, `info-year-range`, `info-volume`, `info-avg-volume`, `info-market-cap`, `info-beta`, `info-pe`, `info-eps`, `info-bid`, `info-ask`.

**Chart rendering**
- Uses `LightweightCharts.createChart` to render candlestick chart.
- Maps API candles to:
  - `time` as UNIX seconds
  - `open`, `high`, `low`, `close`

**Live price polling**
- Live price polling uses `setInterval(loadLivePrice, 10000)`.
- Live updated seconds uses `setInterval(renderLiveUpdated, 1000)`.
- Toggle button `live-toggle` enables and disables polling.

**Market data calls**
- Live price uses `/api/fmp/quote-short?symbol=SYMBOL`.
- Stock info uses `/api/fmp/stock-info?symbol=SYMBOL`.
- Candles use `/api/candles?symbol=SYMBOL&date=YYYY-MM-DD&interval=5&range=1d`.

**Stock info formatting**
- Uses explicit number formatting for price, volume, and ranges.
- Uses US time zone formatting for snapshot timestamp.

### 2.3 Portfolio: `scripts/ui/html/public/portfolio.html`

**DOM ids**
- `portfolio-body` for equity rows.
- `cash-body` for TToken row.
- `portfolio-toggle` for polling enable and disable.

**Wallet integration**
- Connects using `eth_requestAccounts`.
- Listens to `accountsChanged` and reloads balances.

**Data calls**
- `/api/equity/balances?address=WALLET` for equity balances.
- `/api/ttoken/balance?address=WALLET` for TToken.
- `/api/fmp/quote-short?symbol=SYMBOL` for market prices.

**Polling**
- Polling uses `setInterval(refreshPortfolio, 10000)`.
- Button toggles polling and updates label to Enabled or Disabled.

**Row behavior**
- Clicking a row redirects to `sell.html` with `?symbol=SYMBOL`.

**Value rules**
- `qty` is parsed as `balanceWei / 1e18`.
- `marketValue = qty * price`.
- `cost price` and `gain or loss` are placeholders shown as `x`.

### 2.4 Trade: `scripts/ui/html/public/trade.html`

**DOM ids**
- Wallet: `trade-wallet`.
- Symbol select: `trade-symbol`.
- Mode tabs: `mode-buy`, `mode-auto`.
- Panels: `buy-panel`, `auto-panel`.
- Inputs: `buy-price`, `auto-price`, `auto-qty`.
- Buttons: `buy-btn`, `auto-buy-btn`.
- Status labels: `buy-status`, `auto-status`.

**Order placement logic**
- `placeLimitOrder(symbol, side, priceCents, qty)` sends `POST /api/orderbook/limit`.
- `priceCents` is parsed from the USD input text.
- `qty` is read from the center quantity value.

**Payload for buy**
```
{
  "symbol": "AAPL",
  "side": "BUY",
  "priceCents": 39500,
  "qty": 1000,
  "from": "0xWALLET"
}
```

**Auto buy**
- Auto buy uses the same endpoint and payload fields.
- It only changes the UI label and uses `auto-price` and `auto-qty` inputs.

### 2.5 Sell: `scripts/ui/html/public/sell.html`

**DOM ids**
- Wallet: `sell-wallet`.
- Symbol fields: `symbol-title`, `symbol-label`.
- Mode tabs: `mode-sell`, `mode-auto`.
- Panels: `sell-panel`, `auto-panel`.
- Inputs: `sell-price`, `auto-price`, `auto-qty`.
- Buttons: `sell-btn`, `auto-sell-btn`.
- Status labels: `sell-status`, `auto-status`.

**Symbol selection**
- Reads `?symbol=SYMBOL` from URL.
- Defaults to AAPL when none is provided.

**Order placement logic**
- Uses `POST /api/orderbook/limit`.
- `priceCents` parsed from USD input.
- `qty` is read from quantity in the Sell panel.

**Payload for sell**
```
{
  "symbol": "AAPL",
  "side": "SELL",
  "priceCents": 42000,
  "qty": 1000,
  "from": "0xWALLET"
}
```

### 2.6 TToken and Equity mint: `scripts/ui/html/public/ttoken.html`

**DOM ids for TToken**
- `amount-input` for mint amount.
- `airdrop-btn` for mint action.
- `status-text` for mint status.
- `ttoken-wallet` for wallet display.
- `import-hint` for MetaMask import message.

**DOM ids for Equity**
- `equity-symbol` for stock selection.
- `equity-minus-btn`, `equity-plus-btn` for quantity control.
- `equity-amount-value` for quantity display.
- `mint-equity-btn` for mint action.
- `equity-status` for status text.
- `equity-wallet` for wallet display.
- `equity-import-hint` for MetaMask import message.

**Stock list used by equity mint**
- AAPL, MSFT, AMZN, NVDA, GOOGL, META, TSLA, BRKB, JPM, V.

**Mint logic**
- TToken uses `POST /api/ttoken/mint`.
- Equity uses `POST /api/equity/create-mint`.
- The Equity section calls create and mint as a single step.

**Payloads**
```
{
  "to": "0xWALLET",
  "amount": 1000
}
```
```
{
  "symbol": "AAPL",
  "name": "Apple",
  "to": "0xWALLET",
  "amount": 1000
}
```

### 2.7 Admin: `scripts/ui/html/public/admin.html`

**DOM ids**
- `open-orders-body` for open order rows.
- `fills-body` for completed trades.

**Data calls**
- `GET /api/orderbook/open`
- `GET /api/orderbook/fills`

**Open order filtering**
- Shows only orders with `active === true` and `remaining > 0`.

**Address display**
- Uses `shortAddress` with first six characters and last four characters.

**Timestamp formatting**
- Uses `Intl.DateTimeFormat` with `America/New_York` time zone.

## 3) Backend Implementation Details

**File**: `scripts/ui/html/server.js`

### 3.1 Server configuration
- `STAGE0_PORT` environment variable sets the HTTP port. Default is 3000.
- `FMP_API_KEY` is read from environment or default is a hard coded key.
- `HARDHAT_RPC_URL` is read from environment or default is `http://127.0.0.1:8545`.

### 3.2 Caches
- Candles cache: `candleCache`, TTL 300000 milliseconds.
- Quote cache: `quoteCache`, TTL 5000 milliseconds.
- FMP quote cache: `fmpQuoteCache`, TTL 5000 milliseconds.
- FMP info cache: `fmpInfoCache`, TTL 60000 milliseconds.

### 3.3 FMP and Yahoo helpers
- `fetchFmpJson(url)` fetches JSON and throws on non JSON or HTTP error.
- `getFmpUrl(pathname, params)` builds `https://financialmodelingprep.com/stable/` URL with `apikey`.
- Yahoo helpers used from `scripts/ui/dataFetch/tsla-yahoo/yahoo.js`:
  - `fetchQuote(symbol)`
  - `fetchIntradayCandles(symbol, interval, dateET)`
  - `aggregateCandles(candles, intervalMinutes)`

### 3.4 RPC helper
- `hardhatRpc(method, params)` sends JSON RPC to `HARDHAT_RPC_URL`.
- It supports `eth_call`, `eth_sendTransaction`, `eth_getLogs`, `eth_getBlockByNumber`, `eth_accounts`, and `eth_getCode`.

### 3.5 REST endpoints

#### Market data

**GET /api/stock/:symbol**
- Uses `yahooFinance.quoteSummary` with modules: price, summaryDetail, financialData, majorHoldersBreakdown, institutionOwnership, fundOwnership, insiderHolders, insiderTransactions.
- Fallback uses `fetchQuote` and returns `{ price: quote, stale: true }`.

**GET /api/quote?symbol=SYMBOL**
- Returns Yahoo quote payload.
- If Yahoo fails, uses intraday candles for the trading day and constructs:
  - `regularMarketOpen`, `regularMarketPrice`, `regularMarketChange`, `regularMarketChangePercent`, `regularMarketTime`.

**GET /api/fmp/quote-short?symbol=SYMBOL**
- Primary source: FMP `quote-short`.
- Fallbacks: Yahoo quote, then intraday candle fallback.
- Response:
```
{
  "symbol": "TSLA",
  "price": 400.5,
  "volume": 12345678,
  "stale": false,
  "source": "fmp"
}
```

**GET /api/fmp/stock-info?symbol=SYMBOL**
- Primary source: FMP `quote` and `aftermarket-quote`.
- Fallbacks: Yahoo `quoteSummary`, then candle fallback.
- Response fields include:
  - `previousClose`, `open`, `dayLow`, `dayHigh`, `yearLow`, `yearHigh`
  - `volume`, `avgVolume`, `marketCap`, `beta`, `peTTM`, `epsTTM`
  - `bid`, `bidSize`, `ask`, `askSize`
  - `currency`, `stale`

#### Candles

**GET /api/candles?symbol=SYMBOL&date=YYYY-MM-DD&interval=5&range=1d**
- Uses trading day calculations for range.
- Range mapping:
  - `1d` uses the selected date only.
  - `5d` uses the last five trading dates.
  - `1m` uses trading dates in the last thirty days.
  - `3m` uses trading dates in the last ninety days.
  - `6m` uses trading dates in the last one hundred eighty days.
- Response shape:
```
{
  "symbol": "TSLA",
  "date": "2026-02-06",
  "interval": 5,
  "range": "1d",
  "dates": ["2026-02-06"],
  "candles": [
    {
      "timeSec": 1707229800,
      "open": 411.2,
      "high": 412.1,
      "low": 410.8,
      "close": 411.1,
      "volume": 10230,
      "timeET": "02/06/2026, 09:30"
    }
  ]
}
```

#### Hardhat accounts

**GET /api/hardhat/accounts**
- Calls `eth_accounts` and returns:
```
{
  "accounts": ["0xWALLET0", "0xWALLET1"]
}
```

#### TToken

**GET /api/ttoken-address**
- Returns TToken address from deployments or environment variable.

**GET /api/ttoken/balance?address=0xWALLET**
- Calls ERC20 `balanceOf` on the TToken contract.
- Returns:
```
{
  "address": "0xWALLET",
  "ttokenAddress": "0xTTOKEN",
  "balanceWei": "1000000000000000000000"
}
```

**POST /api/ttoken/mint**
- Body fields: `to`, `amount`.
- Amount is converted to `BigInt` and multiplied by `10^18`.
- Transaction sender is `deployments.admin`.
- Returns `{ "txHash": "0xTX" }`.

#### Equity tokens

**GET /api/registry/listings**
- Uses `ListingsRegistry.getAllSymbols` and `getListing`.
- Returns:
```
{
  "listings": [
    { "symbol": "AAPL", "tokenAddress": "0xTOKEN" }
  ]
}
```

**GET /api/equity/address?symbol=SYMBOL**
- Returns `{ "tokenAddress": "0xTOKEN" }`.

**GET /api/equity/balances?address=0xWALLET**
- Iterates all symbols from registry and calls `balanceOf` on each token.
- Returns:
```
{
  "balances": [
    { "symbol": "AAPL", "tokenAddress": "0xTOKEN", "balanceWei": "1000000000000000000000" }
  ]
}
```

**POST /api/equity/create**
- Body fields: `symbol`, `name`.
- Calls `EquityTokenFactory.createEquityToken`.
- Returns `{ "txHash": "0xTX" }`.

**POST /api/equity/mint**
- Body fields: `symbol`, `to`, `amount`.
- Resolves token from registry, then calls `EquityToken.mint`.
- Returns `{ "txHash": "0xTX", "tokenAddress": "0xTOKEN" }`.

**POST /api/equity/create-mint**
- Body fields: `symbol`, `name`, `to`, `amount`.
- Creates token if missing, then mints.
- Returns:
```
{
  "createTx": "0xTX",
  "mintTx": "0xTX",
  "tokenAddress": "0xTOKEN"
}
```

#### Order book

**POST /api/orderbook/limit**
- Body fields: `symbol`, `side`, `priceCents`, `qty`, `from`.
- Resolves equity token from registry.
- Converts qty to `qtyWei = qty * 10^18`.
- For BUY side:
  - `quoteWei = qtyWei * priceCents / 100`.
  - Approves TToken to OrderBookDEX.
- For SELL side:
  - Approves equity token to OrderBookDEX.
- Calls `OrderBookDEX.placeLimitOrder`.
- Returns `{ "txHash": "0xTX" }`.

**GET /api/orderbook/open**
- Iterates all symbols.
- Reads buy orders and sell orders.
- Returns:
```
{
  "orders": [
    {
      "id": 1,
      "side": "BUY",
      "symbol": "AAPL",
      "priceCents": 42000,
      "qty": "1000000000000000000000",
      "remaining": "500000000000000000000",
      "trader": "0xWALLET",
      "active": true
    }
  ]
}
```

**GET /api/orderbook/fills**
- Reads `OrderFilled` logs from `0x0` to latest block.
- Resolves symbol using `ListingsRegistry.getSymbolByToken`.
- Resolves maker and taker addresses by scanning buy and sell orders.
- Resolves block timestamp from `eth_getBlockByNumber`.
- Returns:
```
{
  "fills": [
    {
      "makerId": 1,
      "takerId": 2,
      "makerTrader": "0xWALLET",
      "takerTrader": "0xWALLET",
      "symbol": "AAPL",
      "priceCents": 42000,
      "qty": "1000000000000000000000",
      "blockNumber": 50,
      "txHash": "0xTX",
      "timestampMs": 1700000000000
    }
  ]
}
```

## 4) Data Fetch Module

**File**: `scripts/ui/dataFetch/tsla-yahoo/yahoo.js`

- Builds Yahoo query URLs for quote and chart data.
- Uses time zone conversion for ET session boundaries.
- `fetchQuote(symbol)` returns a Yahoo v7 quote object with:
  - `regularMarketPrice`, `regularMarketChange`, `regularMarketChangePercent`, `regularMarketOpen`, `regularMarketTime`, `preMarketPrice`, `preMarketChange`, `preMarketChangePercent`, `preMarketTime`.
- `fetchIntradayCandles(symbol, interval, dateET)`:
  - Computes 09:30 and 16:01 ET window in UNIX seconds.
  - Maps each candle to `{ timeSec, timeET, open, high, low, close, volume, _ymdET }`.
  - Filters candles to the exact date.
- `aggregateCandles(candles, intervalMinutes)`:
  - Buckets candles into custom interval sizes.

## 5) Solidity Contracts

### 5.1 TToken (`contracts/TToken.sol`)
- ERC20 with 18 decimals.
- Constants: `MAX_SUPPLY`, `AIRDROP_AMOUNT`.
- Key functions: `mint`, `airdropOnce`, `hasClaimedAirdrop`, `mintWithCap`.

### 5.2 ListingsRegistry (`contracts/ListingsRegistry.sol`)
- Storage mapping from symbol to token.
- Admin role for listing creation.
- Key functions: `registerListing`, `getListing`, `getSymbolByToken`, `getAllSymbols`, `getListingFull`, `getSymbols`, `isListed`.

### 5.3 EquityToken and EquityTokenFactory
- EquityToken is an ERC20 with snapshots.
- Factory creates tokens and registers them in the registry.
- Key functions: `EquityToken.mint`, `EquityToken.snapshot`, `EquityTokenFactory.createEquityToken`.

### 5.4 OrderBookDEX (`contracts/OrderBookDEX.sol`)
- Escrow based order book with buy and sell arrays.
- Uses `price` in cents and `qty` in 18 decimals.
- Stores orders in `buyOrders` and `sellOrders`.
- Functions used by backend: `placeLimitOrder`, `getBuyOrders`, `getSellOrders`.
- Emits `OrderPlaced` and `OrderFilled` events used by the admin UI.

### 5.5 PriceFeed (`contracts/PriceFeed.sol`)
- Stores price by symbol and a timestamp.
- Supports freshness check.

### 5.6 Dividends (`contracts/Dividends.sol`)
- Deployed and stored in deployments file.
- Not wired in API or UI.

### 5.7 Award (`contracts/Award.sol`)
- Deployed and stored in deployments file.
- Not wired in API or UI.

### 5.8 PortfolioAggregator (`contracts/PortfolioAggregator.sol`)
- Provides helper methods to read holdings and totals.
- Not wired in API or UI.

## 6) Deploy Scripts

### 6.1 Stage 1: TToken
**File**: `scripts/deploy-ttoken.js`
- Deploys TToken.
- Writes `deployments/localhost.json` with `ttoken`.

### 6.2 Stage 2: Registry, Factory, PriceFeed
**File**: `scripts/deploy-listings.js`
- Deploys `ListingsRegistry`, `EquityTokenFactory`, `PriceFeed`.
- Grants factory role on registry.
- Optionally creates default listings.
- Writes: `listingsRegistry`, `equityTokenFactory`, `priceFeed`, `admin`, `defaultMinter`.

### 6.3 Stage 4: OrderBookDEX
**File**: `scripts/deploy-orderbook.js`
- Reads `ttoken`, `listingsRegistry`, `priceFeed` from deployments.
- Deploys `OrderBookDEX` and writes `orderBookDex`.

### 6.4 Stage 5: Dividends
**File**: `scripts/deploy-dividends.js`
- Reads `ttoken` and `listingsRegistry` from deployments.
- Deploys `Dividends` and writes `dividends`.

## 7) Missing Components

### 7.1 Portfolio economics
- Cost basis and gain or loss are placeholders.
- No realized or unrealized profit calculation.

### 7.2 Trading automation
- Auto buy and auto sell are UI only.
- No scheduler or on chain automation.

### 7.3 Dividends
- No API endpoints for dividends.
- No UI for declaring or claiming dividends.

### 7.4 Order lifecycle features
- No cancel order UI.
- No pagination for order book and fills.

### 7.5 Security
- No authentication for admin operations.

### 7.6 Indexing
- No off chain indexing service.

### 7.7 Data persistence
- No database for orders, user preferences, or analytics.

### 7.8 Monitoring and tests
- No automated tests for API or UI.
- No monitoring dashboards for backend or chain.

## 8) Files Removed

- `scripts/ui/html/stockinformation/` was removed.
- `scripts/ui/dataFetch/tsla-yahoo/QFChart-main/` was removed.
