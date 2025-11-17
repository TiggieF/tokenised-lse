# Stage 1 — TGBP Token

## Objective

Implement a capped ERC-20 stable token “TGBP” serving as the base trading currency.

## Deliverables

* `contracts/TGBP.sol`

  * Inherits OpenZeppelin ERC20 and AccessControl
  * Defines roles: DEFAULT_ADMIN_ROLE, MINTER_ROLE
  * Implements `airdropOnce()` mapping to prevent repeat claims
  * Fixed cap set in constructor
* `scripts/stage1/deploy.js`
* `scripts/stage1/instructions.md`
* `test/stage1_TGBP.test.js`

## Tests

* Total supply does not exceed cap
* Only MINTER_ROLE can mint
* Each wallet receives airdrop once
* Transfer and approval functions operate normally

## Approval Criteria

* All tests pass (`npx hardhat test`)
* Gas report acceptable
* Verified in local Hardhat deployment
