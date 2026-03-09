# Merkle Dividends Deep Dive (Implementation Truth)

## Summary

This document describes how Merkle dividends work in the current repository implementation, end-to-end:

- on-chain contract behavior
- backend tree/claims generation and persistence
- API contracts used by admin and portfolio UIs
- operational dependencies and failure modes

Scope is code truth from:

- `contracts/DividendsMerkle.sol`
- `scripts/ui/html/server.js`
- `scripts/ui/html/public/admin.html`
- `scripts/ui/html/public/portfolio.html`
- `test/dividends-merkle.test.js`

## Purpose and Dual-Lane Model

The system supports two dividend lanes at the same time:

1. Snapshot lane (`Dividends.sol`):
- Admin declares dividend-per-share.
- Contract snapshots balances and users claim from snapshot math.

2. Merkle lane (`DividendsMerkle.sol`):
- Admin declares an epoch by Merkle root and total entitlement.
- Users claim with `(epochId, account, amountWei, leafIndex, proof)`.

Why both coexist:

- snapshot lane provides direct on-chain calculation flow
- Merkle lane scales claim reads/writes by moving entitlement list/proofs off-chain
- migration risk is lower because existing snapshot flows remain available

Portfolio claimables are merged from both lanes in:

- `GET /api/dividends/claimables`

## On-Chain Contract Spec (`DividendsMerkle.sol`)

### Storage Model

Contract state:

- `ITTokenMintableMerkle public immutable ttoken`
- `IListingsRegistryMerkle public immutable registry`
- `uint256 public merkleEpochCount`
- `mapping(uint256 => MerkleEpoch) private merkleEpochs`
- `mapping(uint256 => mapping(uint256 => uint256)) private claimedBitMap`

`MerkleEpoch` fields:

- `address equityToken`
- `bytes32 merkleRoot`
- `uint256 declaredAt`
- `uint256 totalEntitledWei`
- `uint256 totalClaimedWei`
- `bytes32 contentHash`
- `string claimsUri`

Claim tracking:

- bitmap bucket = `leafIndex / 256`
- bit position = `leafIndex % 256`
- claimed iff bit is set

### Roles and Guards

- `declareMerkleDividend(...)` requires `DEFAULT_ADMIN_ROLE`.
- `claim(...)` requires:
  - `account != address(0)`
  - `msg.sender == account`
  - `amountWei > 0`
  - epoch exists
  - leaf not already claimed
  - proof verifies against epoch root
- `claim(...)` is `nonReentrant`.

### Leaf Schema and Proof Convention

Leaf hash is exactly:

`keccak256(abi.encode(epochId, equityToken, account, amountWei, leafIndex))`

Proof verification is positional left-right (not sorted-pair):

- if `index` even: hash `(current, sibling)`
- if `index` odd: hash `(sibling, current)`
- `index = index / 2` each level

This means off-chain tree/proof generation must preserve the same ordering rules.

### Accounting Invariant

On each successful claim:

- `totalClaimedWei` increases by `amountWei`
- invariant enforced:
  - `totalClaimedWei <= totalEntitledWei`

Minted amount is `amountWei` TToken units (18 decimals).

### Events

- `MerkleDividendDeclared(epochId, equityToken, merkleRoot, totalEntitledWei, contentHash, claimsUri)`
- `MerkleDividendClaimed(epochId, account, amountWei, leafIndex)`

Operational meaning:

- declared event marks canonical epoch root and total budget
- claimed event is per-leaf settlement signal

## Backend Flow (`scripts/ui/html/server.js`)

### Artifact Files and Location

Merkle artifacts are stored under:

- `DIVIDENDS_MERKLE_DIR = path.join(PERSISTENT_DATA_ROOT_DIR, "dividends-merkle")`

Files:

- `epoch-<id>-tree.json`
- `epoch-<id>-claims.json`
- holder scan cache: `MERKLE_HOLDER_SCAN_STATE_FILE`

Helpers:

- `readMerkleTree`, `writeMerkleTree`
- `readMerkleClaims`, `writeMerkleClaims`
- `readMerkleHolderScanState`, `writeMerkleHolderScanState`

### Declare Path 1: Manual Root

Endpoint:

- `POST /api/dividends/merkle/declare`

Input behavior:

- required: `symbol`, `merkleRoot`, `totalEntitledWei`
- optional: `contentHash` (defaults `0x00..00`), `claimsUri`, `claims[]`

Validations:

- `merkleRoot` and `contentHash` must be 32-byte hex
- `totalEntitledWei > 0`
- symbol must resolve to listed token
- `dividendsMerkle` deployment must exist
- ensures `MINTER_ROLE` on TToken for dividends merkle contract (grants if missing)

Execution:

- encodes and sends `declareMerkleDividend(...)`
- reads `merkleEpochCount` to get created epoch id
- writes `epoch-<id>-tree.json`
- optionally normalizes and writes `epoch-<id>-claims.json` when `claims[]` passed

### Declare Path 2: Auto Build + Declare

Endpoint:

- `POST /api/dividends/merkle/declare-auto`

Required input:

- `symbol`
- `divPerShare` (human decimal, converted with 18 decimals)

Execution pipeline:

1. Resolve listed token for symbol.
2. Call equity token `snapshot()` and parse snapshot id from receipt logs.
3. Build holder candidate set by scanning ERC-20 `Transfer` logs via `collectHolderCandidatesFromChain(...)`.
4. Read `balanceOfAt(account, snapshotId)` for candidates (concurrent reads).
5. Compute each holder amount:
   - `amountWei = (balanceWei * divPerShareWei) / 1e18`
6. Keep only rows with positive amount, sort by lowercased address, assign sequential `leafIndex`.
7. Build leaf hashes using:
   - `merkleLeafHash(nextEpochId, tokenAddress, account, amountWei, leafIndex)`
8. Build tree levels with `buildMerkleLevelsLeftRight(...)`.
9. Build proofs with `buildMerkleProofLeftRight(...)`.
10. Compute `contentHash = keccak256(utf8(JSON payload))`.
11. Ensure TToken `MINTER_ROLE` on merkle contract (grant if needed).
12. Send on-chain `declareMerkleDividend(...)`.
13. Persist tree and claims artifacts.
14. Update holder scan cache (`nonZeroHolders`) for faster future scans.

Rate-limit handling:

- RPC throttle/non-JSON cases can return HTTP 429 with retry message.

### Claimable Assembly and Wallet Filtering

Merkle-only claimables endpoint:

- `GET /api/dividends/merkle/claimable?wallet=0x...`
- walks all merkle epochs
- reads local `epoch-<id>-claims.json`
- keeps only rows for wallet
- checks chain claimed bit via `isClaimed(epochId, leafIndex)`
- returns rows including proof and canClaim metadata

Merged claimables endpoint:

- `GET /api/dividends/claimables?wallet=0x...`

This endpoint merges:

- snapshot claimables from `Dividends.sol`
- merkle claimables from local artifacts + `isClaimed`

It also supports coalescing/cache and degraded fallback metadata:

- `source`
- `degraded`
- `warnings[]`

### Claim Submission

Endpoint:

- `POST /api/dividends/merkle/claim`

Required fields:

- `wallet`
- `account` (must equal wallet)
- `epochId > 0`
- `amountWei > 0`
- `leafIndex >= 0`
- `proof[]`

Modes:

1. Prepared transaction mode (`clientSign: true`):
- backend returns tx payloads (`to`, `data`) for client wallet signing/submission

2. Direct send mode:
- backend sends `eth_sendTransaction` with claim call

## Frontend Behavior (Admin + Portfolio)

### Admin (`public/admin.html`)

Merkle panel:

- Symbol selector
- TToken-per-share input
- `Auto Declare Merkle` button
- `View Latest Tree` button

Calls:

- auto declare -> `POST /api/dividends/merkle/declare-auto`
- view tree -> `GET /api/dividends/merkle/epochs` then `GET /api/dividends/merkle/tree`

### Portfolio (`public/portfolio.html`)

Claimable dividends render from merged endpoint:

- `GET /api/dividends/claimables?wallet=...`

UI behavior:

- row tagged `(M)` when `claimType === "MERKLE"`
- claim action routes:
  - Merkle -> `POST /api/dividends/merkle/claim`
  - Snapshot -> `POST /api/dividends/claim`

Important dependency:

- Merkle rows require local claims artifacts to exist on backend storage.
- If on-chain epochs exist but local claims files are missing, those wallet rows are not reconstructable by this UI path.

## Operational Dependencies and Persistence

Merkle claim UX depends on persisted files under:

- `PERSISTENT_DATA_DIR/dividends-merkle`

Stateless implications:

- on-chain epoch/root still exists
- but backend may not show per-wallet merkle rows if `epoch-*-claims.json` files are absent
- restarts/redeploys without persistent storage can therefore hide claimables until artifacts are rebuilt/reimported

Recommended runtime posture:

- persistent disk for `PERSISTENT_DATA_DIR`
- regular backup of `dividends-merkle` alongside indexer state

## Public Interface Reference

### 1) `POST /api/dividends/merkle/declare`

Request (JSON):

- `symbol` string (required)
- `merkleRoot` 32-byte hex (required)
- `totalEntitledWei` decimal string (required, > 0)
- `contentHash` 32-byte hex (optional, default zero hash)
- `claimsUri` string (optional)
- `claims` array (optional): `{ account, amountWei, leafIndex, proof[] }`

Success:

- `txHash`
- `epochId`
- `symbol`
- `tokenAddress`
- `merkleRoot`
- `totalEntitledWei`
- `contentHash`
- `claimsUri`
- `claimCount`

Common errors:

- 400 missing/invalid input, not deployed
- 404 symbol not listed
- 429 RPC rate limit
- 500 RPC/chain errors

### 2) `POST /api/dividends/merkle/declare-auto`

Request:

- `symbol` string (required)
- `divPerShare` decimal string (required, > 0)
- `claimsUri` string (optional)

Success:

- `txHash` (declare tx)
- `epochId`
- `symbol`
- `tokenAddress`
- `snapshotId`
- `snapshotTxHash`
- `divPerShareWei`
- `merkleRoot`
- `totalEntitledWei`
- `contentHash`
- `claimCount`
- `levelSizes[]`

Common errors:

- 400 missing input / no eligible holders / not deployed
- 404 symbol not listed
- 429 RPC rate limit
- 500 snapshot/proof/build errors

### 3) `GET /api/dividends/merkle/epochs`

Query:

- `symbol` optional (uppercased internally)

Success:

- `symbol`
- `epochs[]` with:
  - `epochId`
  - `symbol`
  - `tokenAddress`
  - `merkleRoot`
  - `declaredAt`
  - `totalEntitledWei`
  - `totalClaimedWei`
  - `contentHash`
  - `claimsUri`

### 4) `GET /api/dividends/merkle/tree`

Query:

- `epochId` required (> 0)

Success:

- tree metadata (`symbol`, `tokenAddress`, `snapshotId`, `merkleRoot`, `totalEntitledWei`, `contentHash`, `claimsUri`)
- `claimCount`
- `levelSizes[]`
- `levels[]` preview nodes (hash + short hash)

### 5) `GET /api/dividends/merkle/claimable`

Query:

- `wallet` required

Success:

- `wallet`
- `claimables[]` rows containing:
  - `claimType: "MERKLE"`
  - `epochId`
  - `symbol`
  - `tokenAddress`
  - `claimableWei`
  - `amountWei`
  - `leafIndex`
  - `proof[]`
  - `claimed`
  - `canClaim`
  - `merkleRoot`
  - `contentHash`
  - `claimsUri`

### 6) `POST /api/dividends/merkle/claim`

Request:

- `wallet` required
- `account` required and must equal wallet
- `epochId` required (> 0)
- `amountWei` required (> 0)
- `leafIndex` required (>= 0)
- `proof[]` required for valid claim
- `clientSign` optional

Success:

- direct mode: `txHash`, wallet/account/epoch info
- clientSign mode: `{ clientSign: true, txs: [...] }`

Common errors:

- 400 invalid wallet/account/epoch/amount/index
- 400 contract not deployed
- 500 on-chain revert or RPC failure

### 7) `GET /api/dividends/claimables` (merged lane)

Query:

- `wallet` required
- `noCache` optional (`1` or `true`)

Success:

- `wallet`
- `claimables[]` mixed snapshot/merkle rows
- `source`
- `degraded`
- `warnings[]`

Common behavior:

- can return degraded payload with last-known fallback on upstream failures

## Failure Modes and Troubleshooting

### Typical Failure Modes

1. RPC saturation/rate limit:
- declare-auto or merkle epochs calls fail/slow
- HTTP 429 from backend wrapper

2. Missing minter role:
- declare/claim revert when merkle contract cannot mint TToken

3. Invalid proof tuple:
- wrong `amountWei`, `leafIndex`, epoch, token, or account causes invalid proof revert

4. Missing artifacts:
- on-chain epochs exist but local `epoch-*-claims.json` absent, so wallet claimables are missing in UI

5. Stateless restart drift:
- `dividends-merkle` files lost, UI cannot rebuild exact wallet proof rows from chain alone

### Diagnosis Commands

Set environment:

```bash
export BASE="http://127.0.0.1:3000"
export WALLET="0xYourWallet"
export SYMBOL="AAPL"
```

Check deployed merkle epochs:

```bash
curl -sS "$BASE/api/dividends/merkle/epochs?symbol=$SYMBOL" | jq
```

Check latest tree payload (replace `EPOCH_ID`):

```bash
curl -sS "$BASE/api/dividends/merkle/tree?epochId=EPOCH_ID" | jq
```

Check wallet merkle-only claimables:

```bash
curl -sS "$BASE/api/dividends/merkle/claimable?wallet=$WALLET" | jq
```

Check merged claimables lane + degraded metadata:

```bash
curl -sS "$BASE/api/dividends/claimables?wallet=$WALLET&noCache=true" | jq '{source,degraded,warnings,count:(.claimables|length),claimables}'
```

Check local artifact presence on host:

```bash
ls -la "$PERSISTENT_DATA_DIR/dividends-merkle"
```

## Verification and Test Evidence

`test/dividends-merkle.test.js` guarantees:

1. Valid proof claim works and updates `totalClaimedWei`.
2. Double claim of same leaf index is rejected.
3. Wrong amount and wrong index are rejected as invalid proof.
4. Wrong epoch is rejected (`epoch not found`).

Recommended deployed smoke checklist:

1. Call `/api/dividends/merkle/declare-auto` for a listed symbol with non-zero holders.
2. Verify `/api/dividends/merkle/epochs` includes new epoch/root.
3. Verify `/api/dividends/merkle/tree` shows non-empty levels/proofs metadata.
4. Verify target wallet appears in `/api/dividends/merkle/claimable`.
5. Execute claim from portfolio and confirm claim row clears after refresh.
6. Restart backend, re-check artifact directory and claimables endpoint consistency.

## Notes on Units and Conventions

- All on-chain token amounts are represented as 18-decimal Wei strings in API payloads.
- `epochId` and `leafIndex` are integer identifiers and part of the leaf hash domain.
- Any off-chain generator must use the same ABI encoding and left-right proof ordering; otherwise claims will fail.
