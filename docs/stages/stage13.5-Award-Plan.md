# Stage 13.5 — Award Upgrade Plan

## 13.5.0 Goal

- reward highest traders every 1 minute
- count both buy and sell traded quantity
- allow self claim of fixed reward
- allow ties so multiple winners can each claim full reward

## 13.5.1 Chain Changes

Award contract update:

- epoch length: `60` seconds
- reward per winner: `100 * 1e18` TToken
- metric: traded quantity in `qtyWei` (not quote value)

New or updated state:

- `mapping(uint256 => mapping(address => uint256)) qtyByEpochByTrader`
- `mapping(uint256 => uint256) maxQtyByEpoch`
- `mapping(uint256 => mapping(address => bool)) claimedByEpoch`

Recording rule:

- DEX reports fills with `fillQtyWei`
- for each fill:
  - add `fillQtyWei` to maker epoch quantity
  - add `fillQtyWei` to taker epoch quantity
  - update `maxQtyByEpoch` if needed

Winner rule:

- user is winner for epoch if:
  - epoch is closed
  - `qtyByEpochByTrader[epoch][user] > 0`
  - `qtyByEpochByTrader[epoch][user] == maxQtyByEpoch[epoch]`

Claim rule:

- `claimAward(epochId)` mints `100 TToken` to caller if winner and not claimed
- no global finalize required
- each tied winner can claim full `100 TToken`

Events:

- `TradeQtyRecorded(epochId, trader, qtyDeltaWei, qtyTotalWei, maxQtyWei)`
- `AwardClaimed(epochId, trader, rewardWei)`

## 13.5.2 DEX Wiring

- replace quote-volume reporting call with quantity reporting call
- call award recorder for maker and taker on each fill with `fillQtyWei`

## 13.5.3 Backend APIs

- `GET /api/award/status`
  - current epoch id, epoch start/end, seconds remaining, reward amount
- `GET /api/award/leaderboard?epochId=...`
  - quantity ranking for epoch
  - include all tie winners at top
- `GET /api/award/claimable?wallet=0x...`
  - epochs where wallet can claim
- `POST /api/award/claim`
  - body: `wallet`, `epochId`
  - submits on-chain self-claim tx

Notes:

- leaderboard can be assembled from indexer fills
- claim eligibility source of truth must be on-chain contract state

## 13.5.4 Frontend Award Tab

Add or replace Award tab with:

- current epoch card:
  - epoch id
  - countdown (seconds)
  - reward amount (`100 TToken`)
- leaderboard table:
  - wallet
  - quantity traded this epoch
  - rank
  - tie winners highlighted
- claimable rewards table:
  - epoch id
  - your qty
  - max qty
  - claim button
  - claimed status

Refresh cadence:

- poll every 3 to 5 seconds

## 13.5.5 Acceptance Criteria

1. epoch rolls every 60 seconds
2. both buy and sell fills add traded quantity to trader totals
3. single winner can self-claim `100 TToken` for closed epoch
4. tie winners can each self-claim `100 TToken` for same epoch
5. same wallet cannot double-claim same epoch
6. Award tab shows countdown, leaderboard, and claim flow end to end
