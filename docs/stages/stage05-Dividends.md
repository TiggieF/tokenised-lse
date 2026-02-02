# Stage 5 — Dividends (Full Plan, Per‑Share, Snapshot‑Based, Mint‑on‑Demand)

This Stage 5 plan updates the dividend system to match the **final locked decisions** in the project:

- **Settlement token:** `TToken` (ERC‑20, **18 decimals**)
- **Equity tokens:** `EquityToken` (ERC‑20, **18 decimals**)
- **Dividend style:** **Per‑share** (Style B) — admin declares `divPerShareWei` (TToken per 1.00 share)
- **Snapshot mechanism:** **ERC20Snapshot** on EquityToken
- **Distribution model:** **Pull‑based claims** (users claim); double‑claim protection required
- **Minting model:** **Mint‑on‑demand** — Dividends mints TToken at claim time
- **Minimum dividend:** **0.01 TToken per share** (i.e., `divPerShareWei >= 1e16`)
- **Eligibility:** dividends are allowed **only for EquityTokens** (not arbitrary ERC‑20s)
- **Admin:** only `DEFAULT_ADMIN_ROLE` in `Dividends.sol` can declare dividends

---

## 5.0 Objective

Enable a trusted admin to declare dividends for an equity token using an on‑chain **snapshot** and distribute rewards in **TToken** proportionally to each holder’s snapshot balance.

Key properties:
- Snapshot makes dividends **time‑consistent** (no gaming by buying after declaration).
- Per‑share declaration matches real-world “$X per share” language.
- Mint‑on‑demand avoids pre‑funding but requires strict cap/invariant checks.

---

## 5.1 Required dependencies / prerequisites

### 5.1.1 EquityToken must support ERC20Snapshot
Update `EquityToken.sol` to inherit from OpenZeppelin `ERC20Snapshot` (or equivalent) so it provides:

- `function snapshot() external returns (uint256 snapshotId)`
- `function balanceOfAt(address account, uint256 snapshotId) external view returns (uint256)`
- `function totalSupplyAt(uint256 snapshotId) external view returns (uint256)`

**Access control for snapshots**
Snapshots should not be callable by everyone (to avoid spam). Add:

- `SNAPSHOT_ROLE` on `EquityToken`
- `snapshot()` is `onlyRole(SNAPSHOT_ROLE)`

> Important: when `Dividends.sol` calls `equityToken.snapshot()`, the caller is **the Dividends contract**, not the admin EOA.
> Therefore, each EquityToken must grant `SNAPSHOT_ROLE` to the Dividends contract address.

### 5.1.2 Dividends contract must be allowed to mint TToken
Because Stage 5 uses mint‑on‑demand, `Dividends.sol` must be granted:

- `MINTER_ROLE` on `TToken`

Otherwise `claimDividend` will revert.

### 5.1.3 Restricting “only EquityTokens”
To enforce “only EquityTokens” cleanly, add a reverse mapping to `ListingsRegistry.sol`:

- `mapping(address => bool) public isTokenListed;`
- (optional) `mapping(address => string) public tokenToSymbol;`

On `registerListing(symbol, name, tokenAddr)`:
- set `isTokenListed[tokenAddr] = true`
- set `tokenToSymbol[tokenAddr] = symbol` (optional)

Then `Dividends.sol` can enforce:
- `require(registry.isTokenListed(equityToken), "Dividends: not an equity token");`

---

## 5.2 Dividend definition (Style B per share)

### 5.2.1 Inputs declared by admin
Admin declares for a given equity token:

- `divPerShareWei`: dividend amount in **TToken wei** per **1.00 share**

**Minimum rule**
- `divPerShareWei >= 0.01 * 1e18 = 1e16`

### 5.2.2 Claim formula
Let:
- `bal = equityToken.balanceOfAt(user, snapshotId)` (18dp equity units)
- `div = divPerShareWei` (18dp TToken units per 1.00 share)
- 1.00 share = `1e18` equity units

Then the user’s entitlement is:

- `entitlementWei = (bal * div) / 1e18`

### 5.2.3 Rounding and “dust” policy (locked = 5A)
Solidity division floors. This creates rounding dust.

**Policy (5A): leave dust unminted**
- No special handling of dust.
- Dust is simply never minted, because minting happens only on claims.
- This is safe and avoids unfair “last claimer gets dust” logic.

---

## 5.3 Contract deliverables

### 5.3.1 `Dividends.sol` (primary deliverable)

#### Constructor dependencies
- `TToken ttoken`
- `ListingsRegistry registry`
- `address admin` (wallet that holds DEFAULT_ADMIN_ROLE)

#### Roles
- `DEFAULT_ADMIN_ROLE` — **can declare dividends** and perform config changes.

---

## 5.4 Storage design

### 5.4.1 Epoch model
Dividends occur in discrete **epochs** per equity token.

- `epochId` increases by 1 each time a dividend is declared for that equity token.
- Users claim by `(equityToken, epochId)`.

### 5.4.2 Data structures (recommended)

```solidity
struct DividendEpoch {
  uint256 snapshotId;
  uint256 divPerShareWei;
  uint256 declaredAt;
  uint256 totalClaimedWei;
}

mapping(address => uint256) public epochCount; // equityToken => latest epochId
mapping(address => mapping(uint256 => DividendEpoch)) public epochs;

mapping(address => mapping(uint256 => mapping(address => bool))) public claimed;
```

---

## 5.5 Public API (functions)

### 5.5.1 `declareDividendPerShare`
```solidity
function declareDividendPerShare(address equityToken, uint256 divPerShareWei)
  external
  onlyRole(DEFAULT_ADMIN_ROLE)
  returns (uint256 epochId, uint256 snapshotId);
```

**Validations**
- `equityToken != address(0)`
- `registry.isTokenListed(equityToken) == true`
- `divPerShareWei >= 1e16`

**Effects**
1. `snapshotId = EquityToken(equityToken).snapshot()`
2. `epochId = ++epochCount[equityToken]`
3. store epoch data (`snapshotId`, `divPerShareWei`, `declaredAt`, `totalClaimedWei=0`)
4. emit `DividendDeclared`

### 5.5.2 `claimDividend`
```solidity
function claimDividend(address equityToken, uint256 epochId)
  external
  nonReentrant
  returns (uint256 mintedWei);
```

**Validations**
- epoch exists
- not claimed
- `balanceOfAt > 0`
- entitlement > 0

**Effects (CEI)**
1. mark claimed
2. update `totalClaimedWei`
3. `ttoken.mint(msg.sender, entitlementWei)`
4. emit `DividendClaimed`

### 5.5.3 View helpers (optional but recommended)
- `previewClaim(equityToken, epochId, user)`
- `isClaimed(equityToken, epochId, user)`
- `getEpoch(equityToken, epochId)`

---

## 5.6 Events

```solidity
event DividendDeclared(
  address indexed equityToken,
  uint256 indexed epochId,
  uint256 snapshotId,
  uint256 divPerShareWei
);

event DividendClaimed(
  address indexed equityToken,
  uint256 indexed epochId,
  address indexed account,
  uint256 amountWei
);
```

---

## 5.7 Security requirements

- `claimDividend` is `nonReentrant`
- `claimed` set before mint
- Access control enforced on declare
- Dividends has `MINTER_ROLE` on TToken
- Dividends has `SNAPSHOT_ROLE` on EquityToken

---

## 5.8 Tests (Stage 5 test plan)

Create: `test/stage5_Dividends.test.js`

### Setup
- Deploy TToken
- Deploy ListingsRegistry + Factory
- Create equity token (snapshot-enabled)
- Deploy Dividends(ttoken, registry, admin)
- Grant roles:
  - TToken: MINTER_ROLE -> Dividends
  - EquityToken: SNAPSHOT_ROLE -> Dividends
- Allocate equity balances to users

### Tests
1. **Minimum per-share enforced**
   - `divPerShareWei < 1e16` reverts
2. **Snapshot correctness**
   - balances after declare change, but claim uses snapshot balances
3. **Per-share proportionality**
   - exact entitlement matches `(bal * divPerShareWei) / 1e18`
4. **Prevent double claim**
   - second claim reverts
5. **Zero-balance gracefully**
   - holder with 0 at snapshot cannot claim
6. **Only EquityTokens**
   - non-listed token declare reverts
7. **Role enforcement**
   - non-admin declare reverts
   - missing roles cause expected reverts

---

## 5.9 Notes on “auto-claim”

True on-chain “push” distribution to all holders is not feasible because you cannot iterate all holders within gas limits.
Operational auto-claim can be done via an off-chain bot submitting `claimDividend` transactions, but the contract remains pull-based and must prevent double claims.

---
