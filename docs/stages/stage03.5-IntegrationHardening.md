# Stage 3.5 — “Integration Hardening” (18dp Standard + Ops + Test Gaps)

This stage is a **bridge between Stage 3 (PriceFeed)** and **Stage 4 (OrderBookDEX)**.  
Its purpose is to **eliminate integration ambiguity** (decimals, naming, scripts, views, roles) and to add the missing operational tooling and tests that make Stage 4 development fast and low-risk.

You requested:
- **Option 1:** keep **18 decimals** across all ERC-20s.
- Settlement token remains **TToken** (not TGBP).
- Add **2A** (enhanced ListingsRegistry views).
- Explain **2C** (why it matters + how to implement).
- Implement **3** (deployment/admin scripts).
- Implement **5** (test gaps / extra tests).
- Produce an updated Stage 4 plan compatible with **18dp**.

---

## 3.5.0 — Global conventions (LOCK THESE)

### Token decimals
- **TToken**: `decimals = 18`
- **EquityToken**: `decimals = 18`

This matches what you already coded (Stage 1 airdrop uses `* 1e18`).

### Price units
Keep the PriceFeed value as an **integer in “cents”** (2dp).  
Name is up to you, but be consistent:
- If you’re treating the quote currency as “dollars”, `priceCents` is fine.
- If you want it to behave like “pence”, rename to `pricePence` across PriceFeed and scripts.

**Stage 3.5 outcome:** Choose one and apply consistently in:
- PriceFeed field names
- Events
- Script conversions
- Docs and dissertation wording

> **Recommended:** keep `priceCents` (because your contract already uses it), and treat it as “2dp quote currency units”.

### Quantity units
- Equity quantities are **ERC-20 base units (18dp)**.
- Example: `1 share` is represented as `1e18` units.

---

## 3.5.1 — 2A: ListingsRegistry “full listing” views (ADD THIS)

### Why you need this
Right now, `getListing(symbol)` only returns the token address or `0x0`.  
For:
- CLI scripts,
- front-end discovery,
- debugging,
- order book display,
you need **name + symbol + token address** reliably.

### Minimal additions (recommended)
Add one or more of:

#### A) Return the full struct
```solidity
function getListingFull(string calldata symbol)
  external view
  returns (address token, string memory sym, string memory name);
```

- If not listed, return `(address(0), "", "")` or revert with a clear error.
- Prefer returning `sym` exactly as stored (uppercase).

#### B) Add a boolean exists check
```solidity
function isListed(string calldata symbol) external view returns (bool);
```

#### C) (Optional but powerful) Enumerate all listings
If you store only a mapping, you can’t enumerate on-chain without extra storage.  
If you want this for Stage 8 UI, add:
- `bytes32[] listingKeys` or `string[] listedSymbols` (append on register)
- `getAllSymbols()` / `getSymbols(uint256 offset, uint256 limit)`

**Stage 3.5 acceptance for 2A:**
- Tests cover that the “full view” returns correct `token/symbol/name` for a listed stock.
- Non-listed symbol behavior is defined and tested.

---

## 3.5.2 — 2C: PriceFeed “freshness window” configurability (WHAT IT’S FOR)

### What 2C is
Your current `isFresh(symbol)` uses a hardcoded 60 seconds freshness window.

**2C = making the freshness window a configurable parameter** so you can:
- Run local tests with short windows (60s),
- Run demos with longer windows (e.g., 15 minutes),
- Avoid magic constants in your dissertation write-up.

### Why it matters (practically)
Once Stage 4 and beyond exist:
- You may show “fresh price required to trade” (even if not enforced on-chain in Stage 4).
- You will likely have a backend updater cadence that’s not exactly 60 seconds.
- A fixed 60s window will cause unnecessary false “stale” readings in demos.

### Minimal implementation
Add state + setter:

```solidity
uint256 public freshnessWindowSeconds; // e.g., 60 by default

constructor(address admin, address oracle) {
  freshnessWindowSeconds = 60;
}

function setFreshnessWindow(uint256 secs) external onlyRole(DEFAULT_ADMIN_ROLE) {
  require(secs > 0, "PriceFeed: window must be > 0");
  freshnessWindowSeconds = secs;
}

function isFresh(string calldata symbol) external view returns (bool) {
  PriceEntry memory p = _prices[_symbolKey(symbol)];
  if (p.timestamp == 0) return false;
  return (block.timestamp - p.timestamp) <= freshnessWindowSeconds;
}
```

**Stage 3.5 acceptance for 2C:**
- Test that admin can set the window.
- Test that non-admin cannot.
- Test isFresh works for a custom window.

> Note: Stage 4 does *not* need to enforce freshness; this is for better system hygiene and later-stage integration.

---

## 3.5.3 — Stage 3 scripts and tooling (DO “3”)

You identified these missing pieces, and they are worth doing now because Stage 4 will depend on them daily.

### 3.5.3a — Stage 2 deployment script (must-have)
Create: `scripts/deploy-listings.js`

**Responsibilities**
- Deploy `ListingsRegistry(admin)`
- Deploy `EquityTokenFactory(admin, registryAddress, defaultMinter)`
- Optionally create 1–3 listings (e.g., AAPL, TSLA) using the factory
- Print addresses + verify registry entries with `getListingFull`

**Outputs**
- Save addresses to a JSON file: `deployments/local.json` (or network-named)
- Print readable summary

### 3.5.3b — PriceFeed admin/oracle management (must-have)
Create: `scripts/priceFeedAdmin.js`

**Commands (suggested)**
- `grantOracle(address)`
- `revokeOracle(address)`
- `setFreshnessWindow(secs)`
- `readPrice(symbol)`
- `readPrices(symbols[])`

This script will remove “manual role fiddling” from your workflow.

### 3.5.3c — Batch quote updater wrapper (optional but nice)
You already have `updatePriceFromFinnhub.js`. Consider:
- a batch updater: `updatePricesBatch.js`
- reads symbols list from a file or env
- updates multiple symbols per run

---

## 3.5.4 — Tests to add (DO “5”)

You requested “do 5” (testing gaps). Here’s the exact set that improves Stage 4 readiness.

### 3.5.4a — ListingsRegistry tests (2A)
Add to `listings-factory.test.js`:
- `getListingFull` returns `(token, symbol, name)`
- `isListed(symbol)` returns true/false correctly
- Behavior for missing symbols is defined (either returns 0/empty or reverts)

### 3.5.4b — PriceFeed tests (2C)
Add to `pricefeed.test.js`:
- `freshnessWindowSeconds` default is 60
- admin can set window
- non-admin cannot
- isFresh respects window:
  - set to 10 seconds, advance 11 seconds => false

### 3.5.4c — “Unit convention” sanity tests (high value)
Add basic tests to confirm your system assumptions with 18dp:
- TToken has `decimals == 18`
- EquityToken has `decimals == 18`
- A known `qty` and `price` conversion helper (in JS) produces expected quote amounts for Stage 4 math (see Stage 4 doc).

These tests are small but prevent catastrophic integration mistakes later.

---

## 3.5.5 — Stage 3.5 acceptance checklist

✅ **Conventions locked**
- All ERC-20 amounts are **18dp**
- Price feed values are **2dp integers** (cents/pence)
- Documented conversion formula for quote amounts

✅ **2A implemented**
- ListingsRegistry exposes full listing info

✅ **2C implemented**
- PriceFeed freshness window configurable

✅ **Scripts added**
- Stage 2 deploy script
- PriceFeed admin/oracle script
- (optional) batch updater script

✅ **Tests added**
- 2A tests in Stage 2 test suite
- 2C tests in Stage 3 test suite
- unit sanity tests (18dp + price conversion)

---

## 3.5.6 — Stage 4 dependency note

**Stage 4 will depend on these Stage 3.5 outputs:**
- A reliable way to fetch token addresses (ListingsRegistry full view)
- Clear unit conventions for escrow and settlement math (18dp + 2dp price)
- Scripts to deploy a consistent environment quickly
