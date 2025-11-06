# Stage 6 — FeePool Rewards

## Objective

Reward highest trading volume participant each 3-minute epoch.

## Deliverables

* `FeePool.sol`

  * Tracks trader volumes per epoch
  * `finalizeEpoch()` identifies top trader
  * Sends 3 TGBP to winner
* Integration: DEX reports volume to FeePool on fills

## Tests

* Correct trader identified as top
* Reward distributed once per epoch
* Epoch reset logic validated

## Approval Criteria

* Accurate volume tracking
* Top trader rewarded correctly
