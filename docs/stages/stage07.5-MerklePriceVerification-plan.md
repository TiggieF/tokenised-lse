# Stage 7.5 — Merkle-Committed Price Verification (Oracle Hardening)

Stage 7.5 upgrades the oracle design from a **direct trusted price push** (current `PriceFeed.setPrice(symbol, priceCents)`) to a **commit-and-prove** model using a **Merkle root**.

The goal is to make prices **independently verifiable** against an on-chain commitment, reducing trust in the oracle publisher and preventing selective/partial disclosure of a larger price dataset.

> This stage adds a minimal, dissertation-friendly Merkle oracle that is realistic and easy to reason about:
> - **Off-chain**: compute prices for many symbols and publish a Merkle root.
> - **On-chain**: store the root and verify Merkle proofs for individual symbol prices.

---

## 7.5.0 Objective

Enable contracts (and the frontend) to verify:

> “This `(symbol, priceCents, timestamp)` was part of the committed price snapshot.”

by introducing:
- On-chain `commitRoot(root, timestamp)`
- On-chain `verifyPrice(symbol, priceCents, timestamp, proof)`
- A clean integration point for oracle-assisted orders (Stage 5.6) to optionally require Merkle proofs.

---

## 7.5.1 Locked conventions

- Token units unchanged:
  - `TToken`: 18 decimals
  - `EquityToken`: 18 decimals
- Price units unchanged:
  - `priceCents` (2dp integer)
- A “price snapshot” is defined for many symbols at a single `snapshotTimestamp`.
- Freshness semantics follow your existing `freshnessWindowSeconds` in `PriceFeed`.

---

## 7.5.2 Architecture overview

### 7.5.2.1 Off-chain (publisher) responsibilities
A script (oracle publisher) will:
1. Fetch prices for all listed symbols (e.g., from Finnhub/Yahoo).
2. Create leaves for each symbol:
   ```text
   leaf = keccak256(abi.encode(symbol, priceCents, snapshotTimestamp))
   ```
3. Build a Merkle tree over all leaves and compute `merkleRoot`.
4. Submit one on-chain tx:
   ```solidity
   commitRoot(merkleRoot, snapshotTimestamp)
   ```

### 7.5.2.2 On-chain responsibilities
`PriceFeed` (or a new contract) will:
- store the latest committed root and timestamp
- verify user-supplied Merkle proofs for `(symbol, priceCents, snapshotTimestamp)`
- expose helpers for other contracts (e.g., OrderBookDEX) to validate oracle prices

---

## 7.5.3 Design choice (recommended): extend `PriceFeed.sol`

You have two viable designs:

### Option A (recommended): Extend existing `PriceFeed.sol`
Add Merkle root commitment alongside (or replacing) `setPrice` storage.

Pros:
- minimal new surface area
- keeps all “oracle” logic in one contract
- easiest integration with existing `isFresh` semantics

### Option B: New contract `MerklePriceFeed.sol`
Pros:
- clean separation from the trusted push-oracle
Cons:
- more wiring + more addresses in constructors

This plan assumes **Option A** unless you prefer separate contracts.

---

## 7.5.4 Contract changes (Option A)

### 7.5.4.1 New state
```solidity
bytes32 public latestRoot;
uint256 public latestRootTimestamp;   // snapshot timestamp embedded into leaves
uint256 public latestCommitBlockTime; // optional: block.timestamp when committed
```

### 7.5.4.2 New event
```solidity
event RootCommitted(bytes32 indexed root, uint256 indexed snapshotTimestamp, uint256 commitBlockTime);
```

### 7.5.4.3 New functions
```solidity
function commitRoot(bytes32 root, uint256 snapshotTimestamp) external onlyRole(ORACLE_ROLE);
```

Rules:
- `root != bytes32(0)`
- `snapshotTimestamp > 0`
- `snapshotTimestamp <= block.timestamp` (recommended)
- update `latestRoot`, `latestRootTimestamp`, `latestCommitBlockTime`
- emit `RootCommitted`

---

### 7.5.4.4 Price proof verification
```solidity
function verifyPrice(
  string calldata symbol,
  uint256 priceCents,
  uint256 snapshotTimestamp,
  bytes32[] calldata proof
) external view returns (bool);
```

Rules:
- requires `snapshotTimestamp == latestRootTimestamp`
- requires `latestRoot != 0`
- leaf:
  ```text
  leaf = keccak256(abi.encode(symbol, priceCents, snapshotTimestamp))
  ```
- verify with OpenZeppelin `MerkleProof.verify(proof, latestRoot, leaf)`

---

### 7.5.4.5 Verified price read helper (recommended)
```solidity
function getVerifiedPrice(
  string calldata symbol,
  uint256 priceCents,
  uint256 snapshotTimestamp,
  bytes32[] calldata proof
) external view returns (uint256 verifiedPriceCents, uint256 verifiedTimestamp);
```

Behavior:
- reverts if proof invalid
- returns `(priceCents, snapshotTimestamp)` on success

This is convenient for OrderBookDEX and tests.

---

## 7.5.5 Freshness semantics

We keep your existing freshness window concept.

Two equivalent approaches:

### Approach A (recommended): treat `latestCommitBlockTime` as freshness source
- Fresh if `block.timestamp - latestCommitBlockTime <= freshnessWindowSeconds`

### Approach B: treat `latestRootTimestamp` as freshness source
- Fresh if `block.timestamp - latestRootTimestamp <= freshnessWindowSeconds`

Approach A is safer if your snapshot timestamps come from the publisher and might lag slightly.
Approach B is “truer” to data time but can fail if there is ingestion delay.

This plan defaults to **Approach A**.

---

## 7.5.6 Integration with OrderBookDEX (minimal and safe)

### 7.5.6.1 What changes
You **do not** reprice limit-order matching (order book remains the execution price source).

This stage only affects *oracle-assisted* paths (Stage 5.6).

### 7.5.6.2 New optional entrypoint (Merkle variant)
Add a new function (or extend existing one) to accept proofs:

```solidity
function buyExactQuoteAtOracleWithProof(
  address equityToken,
  uint256 quoteWei,
  uint256 maxSlippageBps,
  uint256 oraclePriceCents,
  uint256 snapshotTimestamp,
  bytes32[] calldata proof
) external returns (
  uint256 qtyBoughtWei,
  uint256 quoteSpentWei,
  uint256 verifiedPriceCents,
  uint256 oracleMaxPriceCents
);
```

Flow:
1. Resolve `symbol` via `ListingsRegistry.getSymbolByToken(equityToken)`.
2. Verify `(symbol, oraclePriceCents, snapshotTimestamp)` against `PriceFeed.latestRoot` using proof.
3. Enforce freshness (based on root freshness, not per-symbol storage).
4. Compute `oracleMaxPriceCents` using `maxSlippageBps`.
5. Execute the same internal IOC logic as Stage 5.5 with `maxPriceCents = oracleMaxPriceCents`.

This gives a clean story:
- DEX trusts **on-chain commitment + proof**, not a raw `getPrice()` call.

> You may keep the existing `buyExactQuoteAtOracle` (without proof) as a fallback for demos.

---

## 7.5.7 Leaf format and symbol encoding (must be consistent)

To avoid proof mismatches, define leaf construction **exactly once** and reuse it everywhere.

### Recommended leaf
```text
leaf = keccak256(abi.encode(symbol, priceCents, snapshotTimestamp))
```

Notes:
- `symbol` is a Solidity string; `abi.encode` is unambiguous but requires identical UTF-8 bytes off-chain.
- All symbols in your system are uppercase A–Z / 0–9 by registry validation, which avoids unicode ambiguity.

Alternative (more compact):
- use `bytes32 symbolKey = keccak256(bytes(symbol))` in leaves.
This reduces string handling off-chain/on-chain but adds one more hashing step.

This plan defaults to the direct string leaf for clarity.

---

## 7.5.8 Deliverables

### Contracts
- Update `contracts/PriceFeed.sol`:
  - add root commitment state + functions + event
  - add proof verification
  - add root freshness logic
- Update `contracts/OrderBookDEX.sol` (optional but recommended):
  - add `buyExactQuoteAtOracleWithProof` entrypoint
  - reuse internal IOC logic (no double-transfer)

### Scripts
- `scripts/stage7_5/commitRoot.js`
  - builds tree for all listed symbols
  - submits `commitRoot(root, snapshotTimestamp)`
- `scripts/stage7_5/makeProof.js` (optional)
  - prints proof for a given symbol for debugging

### Tests
- `test/stage7_5_MerklePriceFeed.test.js`
- (if integrating into DEX) `test/stage7_5_OracleProofOrders.test.js`

### Docs
- This plan file: `stage07.5-MerklePriceVerification-plan.md`

---

## 7.5.9 Test plan

### A) Root commitment
- ORACLE_ROLE can commit a root
- Non-oracle cannot commit
- Emits `RootCommitted`
- Stores root + timestamps correctly

### B) Proof verification
- Valid proof returns true
- Invalid proof returns false / getVerifiedPrice reverts
- Wrong symbol or wrong price fails
- Wrong snapshot timestamp fails

### C) Freshness
- Freshness true immediately after commit
- After `freshnessWindowSeconds + 1`, freshness false

### D) DEX integration (if enabled)
- `buyExactQuoteAtOracleWithProof` succeeds with valid proof and fresh root
- Reverts on invalid proof
- Reverts on stale root
- Slippage bound gates eligible asks exactly as in Stage 5.6

---

## 7.5.10 Approval criteria

Stage 7.5 is complete when:
- Merkle root can be committed on-chain by ORACLE_ROLE
- Individual prices can be verified via Merkle proofs
- Root freshness is enforced
- (If integrated) DEX oracle-assisted orders can use verified prices
- Tests cover success + failure paths

---

## 7.5.11 Open questions to confirm (defaults provided)

1) **Where do we store Merkle data?**
   - Default: extend existing `PriceFeed.sol` (Option A)
   - Alternative: new `MerklePriceFeed.sol` (Option B)

2) **Freshness source: commit time or snapshot time?**
   - Default: use `latestCommitBlockTime` for freshness (Approach A)
   - Alternative: use `latestRootTimestamp` (Approach B)

3) **Do we require proofs for all oracle-assisted orders?**
   - Default: add a new `...WithProof` entrypoint and keep existing non-proof function for backwards compatibility
   - Alternative: migrate fully to proof-only and deprecate raw `getPrice()` use in DEX

4) **Leaf encoding: string or symbolKey(bytes32)?**
   - Default: `keccak256(abi.encode(symbol, priceCents, snapshotTimestamp))`
   - Alternative: `keccak256(abi.encode(symbolKey, priceCents, snapshotTimestamp))`

If you reply “use defaults”, we can treat the above defaults as locked.
