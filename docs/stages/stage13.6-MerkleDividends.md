# Stage 13.6 — Merkle Dividends (Dual Mode)

## 13.6.0 Purpose

Scale dividend claiming without removing current snapshot dividends.

This stage adds a second dividend lane:

- snapshot lane (existing `Dividends.sol`)
- merkle lane (new `DividendsMerkle.sol`)

Both lanes must run in the same deployment so migration risk is low and features stay backward compatible.

---

## 13.6.1 Scope

In scope:

- deploy a new Merkle dividend contract
- declare dividend epochs by Merkle root
- claim by proof
- preserve existing snapshot dividend APIs and UI
- display claimable rows from both lanes in Portfolio

Out of scope:

- removing or rewriting `Dividends.sol`
- trustless off-chain root generation inside smart contracts
- batch claim aggregation contract

---

## 13.6.2 Contract Design

## 13.6.2.1 New contract

- `contracts/DividendsMerkle.sol`

Roles:

- `DEFAULT_ADMIN_ROLE`: declare epochs and admin ops

External dependencies:

- `TToken` mint permission via `MINTER_ROLE`
- `ListingsRegistry` listing validation for equity token
- `OpenZeppelin MerkleProof`

## 13.6.2.2 State model

Per epoch:

- `bytes32 merkleRoot`
- `address equityToken`
- `uint256 declaredAt`
- `uint256 totalEntitledWei`
- `uint256 totalClaimedWei`
- `string claimsUri` (optional metadata pointer)

Claim tracking:

- `mapping(uint256 => mapping(uint256 => uint256)) claimedBitMap`
  - first key: `epochId`
  - second key: bitmap bucket index (`leafIndex / 256`)
  - bit position: `leafIndex % 256`

Counters:

- `uint256 public merkleEpochCount`

## 13.6.2.3 Leaf schema

Leaf hash must be:

- `keccak256(abi.encode(epochId, equityToken, account, amountWei, leafIndex))`

This prevents cross-epoch and cross-token proof reuse.

## 13.6.2.4 Functions

Declare:

- `declareMerkleDividend(address equityToken, bytes32 merkleRoot, uint256 totalEntitledWei, string calldata claimsUri)`

Claim:

- `claim(uint256 epochId, address account, uint256 amountWei, uint256 leafIndex, bytes32[] calldata proof)`

Read helpers:

- `isClaimed(uint256 epochId, uint256 leafIndex) view returns (bool)`
- `previewLeaf(uint256 epochId, address account, uint256 amountWei, uint256 leafIndex, bytes32[] calldata proof) view returns (bool valid, bool claimed)`
- `getEpoch(uint256 epochId) view returns (...)`

## 13.6.2.5 Events

- `MerkleDividendDeclared(uint256 indexed epochId, address indexed equityToken, bytes32 merkleRoot, uint256 totalEntitledWei, string claimsUri)`
- `MerkleDividendClaimed(uint256 indexed epochId, address indexed account, uint256 amountWei, uint256 leafIndex)`

---

## 13.6.3 Backend API Plan

Add endpoints in `scripts/ui/html/server.js`.

Declare:

- `POST /api/dividends/merkle/declare`
  - body:
    - `symbol`
    - `merkleRoot`
    - `totalEntitledWei`
    - `claimsUri` optional

Epoch list:

- `GET /api/dividends/merkle/epochs?symbol=AAPL`

Claimable query:

- `GET /api/dividends/merkle/claimable?wallet=0x...`
  - reads local claim artifact + on-chain claimed bit
  - returns rows with:
    - `epochId`
    - `symbol`
    - `claimType: "MERKLE"`
    - `amountWei`
    - `leafIndex`
    - `proof[]`
    - `claimed`
    - `canClaim`

Claim:

- `POST /api/dividends/merkle/claim`
  - body:
    - `wallet`
    - `epochId`
    - `account`
    - `amountWei`
    - `leafIndex`
    - `proof[]`

Compatibility requirement:

- Keep existing endpoints unchanged:
  - `/api/dividends/declare`
  - `/api/dividends/claim`
  - `/api/dividends/claimables`

---

## 13.6.4 Off-chain Merkle Artifacts

Directory:

- `cache/dividends-merkle/`

Files:

- `epoch-<id>-claims.json`
  - array rows: `account`, `amountWei`, `leafIndex`, `proof[]`, `symbol`
- `epoch-<id>-tree.json`
  - metadata: `epochId`, `symbol`, `token`, `root`, `claimsUri`, `totalEntitledWei`

Operational rule:

- backend validates provided root matches `epoch-<id>-tree.json` before returning claim payloads

---

## 13.6.5 Frontend Plan

Admin page (`scripts/ui/html/public/admin.html`):

- add "Merkle Dividends" panel:
  - symbol selector
  - merkle root input
  - total entitled input
  - claims URI input
  - declare button
  - status text

Portfolio page (`scripts/ui/html/public/portfolio.html`):

- merge snapshot claimables and merkle claimables in one table
- each row shows claim type badge: `SNAPSHOT` or `MERKLE`
- claim button dispatch:
  - snapshot row -> existing `/api/dividends/claim`
  - merkle row -> `/api/dividends/merkle/claim`

---

## 13.6.6 Failure Modes and Guards

- invalid root format -> reject declare
- root not matching stored tree artifact -> reject claimable serving
- invalid proof -> on-chain revert
- duplicate claim leaf -> on-chain revert
- wrong epoch/token/account/amount/index -> invalid proof
- claim amount that exceeds total entitlement accounting -> impossible if root built correctly, but still check `totalClaimedWei <= totalEntitledWei` on update

---

## 13.6.7 Tests

New suite:

- `test/dividends-merkle.test.js`

Required tests:

1. valid proof claim mints expected amount
2. double claim for same leaf reverts
3. wrong amount fails proof
4. wrong index fails proof
5. wrong epoch or token fails proof
6. total claimed tracking updates correctly

Regression:

- `test/dividends.test.js` must pass unchanged

---

## 13.6.8 Acceptance Criteria

1. Snapshot and Merkle dividends both work in one system run
2. Admin can declare Merkle epoch and users can claim with proof
3. Portfolio shows both claim types and claims route correctly
4. Existing snapshot behavior remains unchanged
5. All dividend-related test suites pass
