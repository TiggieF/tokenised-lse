# Stage 6 — FeePool Rewards (Permissionless, On-Chain Volume Leader)

This stage introduces an on-chain **FeePool** that tracks per-epoch trading volume and awards a **fixed 1 TToken reward** to the **highest-volume trader** every **90 seconds**.

> **Important:** Winner selection and volume aggregation are fully **on-chain**.  
> Payout execution requires an **external trigger** (keeper / cron / any caller), but **no privileged role** is needed.

---

## 6.0 Objective

Reward the trader with the **highest total trading volume** (maker + taker) in each **90-second epoch** by minting **1 TToken**.

Key properties:
- On-chain aggregation of volume (no off-chain winner computation).
- Deterministic top trader per epoch.
- Single payout per epoch.
- Permissionless finalization (no admin dependency).

---

## 6.1 Locked conventions

### 6.1.1 Clarifications (to remove ambiguity)

- **Tie-break is strict:** the leader is updated only when `newVolume > topVolume` (not `>=`). Ties **do not** replace the existing leader (first to reach max wins).
- **Zero-volume epochs:** `finalizeEpoch` performs **no mint** when `topVolumeByEpoch[epochId] == 0` (it still marks the epoch as finalized to prevent repeated calls).
- **recordTrade access control:** this plan uses a single-authorized-caller model (`msg.sender == dex`). You can swap to `onlyRole(REPORTER_ROLE)` later if you want multiple reporting contracts.
- **Finalization window:** `finalizeEpoch(epochId)` is valid only when `epochId < currentEpoch()` (never current/future epochs).


- **Reward amount:** `1 TToken` (fixed).
- **Epoch duration:** `90 seconds`.
- **Volume metric:** **quote volume** in TToken wei.
- **Who is counted:** **both maker and taker** on every fill.
- **Source of truth:** DEX calls FeePool on each successful fill.
- **Tie-break rule:** first trader to reach the max volume wins.

---

## 6.2 Architecture overview

### 6.2.1 Data flow

1. A trade fill occurs in the DEX.
2. DEX computes:
   ```text
   quoteVolume = (fillQtyWei * priceCents) / 100
   ```
3. DEX calls:
   ```solidity
   feePool.recordTrade(maker, quoteVolume);
   feePool.recordTrade(taker, quoteVolume);
   ```
4. FeePool updates volume tracking and top trader for the current epoch.
5. After the epoch ends, **any address** may call:
   ```solidity
   finalizeEpoch(epochId)
   ```
6. FeePool mints **1 TToken** to the winning trader (if any).

---

## 6.3 Contract design

### 6.3.1 Contract: `FeePool.sol`

#### Dependencies
- `TToken` (FeePool must have `MINTER_ROLE`).
- DEX address (authorized reporter of trades).

---

### 6.3.2 Constants

```solidity
uint256 public constant EPOCH_DURATION = 90;         // 90 seconds
uint256 public constant REWARD_AMOUNT  = 1e18;       // 1 TToken
```

---

### 6.3.3 Epoch calculation

```solidity
function currentEpoch() public view returns (uint256) {
  return block.timestamp / EPOCH_DURATION;
}
```

Epoch IDs are monotonically increasing and deterministic.

---

### 6.3.4 Storage

```solidity
mapping(uint256 => mapping(address => uint256)) public volumeByEpoch;
mapping(uint256 => address) public topTraderByEpoch;
mapping(uint256 => uint256) public topVolumeByEpoch;
mapping(uint256 => bool) public rewarded;
```

Notes:
- `volumeByEpoch` is write-only on-chain (analytics are off-chain via events).
- Storage grows linearly with number of active traders per epoch.

---

## 6.4 Public API

### 6.4.1 `recordTrade`

```solidity
function recordTrade(address trader, uint256 quoteVolume) external;
```

**Access control**
- Only callable by the DEX:
  ```solidity
  require(msg.sender == dex, "FeePool: only DEX");
  ```

**Validations**
- `trader != address(0)`
- `quoteVolume > 0`

**Effects**
1. `epoch = currentEpoch()`
2. `volumeByEpoch[epoch][trader] += quoteVolume`
3. If:
   ```text
   volumeByEpoch[epoch][trader] > topVolumeByEpoch[epoch]
   ```
   then:
   - update `topVolumeByEpoch[epoch]`
   - update `topTraderByEpoch[epoch]`

**Tie-break**
- Equal volume does **not** replace the existing leader (first wins).

---

### 6.4.2 `finalizeEpoch` (permissionless)

```solidity
function finalizeEpoch(uint256 epochId) external;
```

**Rules**
- `epochId < currentEpoch()` (epoch must be finished).
- `rewarded[epochId] == false` (only once).

**Effects**
- If `topVolumeByEpoch[epochId] == 0`:
  - mark `rewarded[epochId] = true`
  - emit finalization event with no winner
  - return (no mint)
- Else:
  - mint `REWARD_AMOUNT` to `topTraderByEpoch[epochId]`
  - mark `rewarded[epochId] = true`
  - emit finalization event

This prevents repeated calls on empty epochs.

---

## 6.5 Events

```solidity
event TradeRecorded(
  uint256 indexed epochId,
  address indexed trader,
  uint256 volume
);

event EpochFinalized(
  uint256 indexed epochId,
  address indexed winner,
  uint256 reward
);
```

Events are the canonical source for off-chain analytics.

---

## 6.6 Required roles / permissions

- FeePool must hold `MINTER_ROLE` on `TToken`.
- DEX address must be set at deployment (or via admin setter).
- `finalizeEpoch` is permissionless.

---

## 6.7 Integration with DEX (mandatory)

On **every successful fill**, the DEX must call:

```solidity
feePool.recordTrade(maker, quoteVolume);
feePool.recordTrade(taker, quoteVolume);
```

Important:
- Calls must only happen after a fill is finalized.
- Quote volume calculation must match settlement math exactly.

---

## 6.8 Security & correctness notes

- No loops over traders (O(1) per trade).
- No dependence on off-chain winner computation.
- Wash trading is possible in theory; this stage measures **activity**, not economic profit.
- Mitigation (e.g., min trade size or taker-only counting) is explicitly deferred.

---

## 6.9 Tests (required)

Create `test/stage6_FeePool.test.js`.

### Required tests

1. **Top trader selection**
   - Multiple traders, highest cumulative volume wins.

2. **Maker + taker counted**
   - One fill increments both participants.

3. **Epoch isolation**
   - Trades in different epochs tracked separately.

4. **Finalize once**
   - Second call to same epoch reverts.

5. **No-volume epoch**
   - Finalize succeeds with no reward.

6. **Permissionless finalize**
   - Any address can call `finalizeEpoch`.

7. **DEX-only recordTrade**
   - Non-DEX caller reverts.

---

## 6.10 Approval criteria

Stage 6 is complete when:

- FeePool has **MINTER_ROLE** on `TToken` and can mint `REWARD_AMOUNT` successfully.
- Volume is tracked correctly per epoch.
- Top trader is selected deterministically (strict `>` tie-break).
- Reward is minted exactly once per epoch.
- Permissionless finalization works (only past epochs).
- DEX integration is proven in tests.

---

## 6.11 Backend / keeper note (explicit)

An external process (cron, keeper, or script) must periodically call:

```solidity
finalizeEpoch(currentEpoch() - 1)
```

This stage **does not implement the backend**, but the dependency is explicit and intentional.
