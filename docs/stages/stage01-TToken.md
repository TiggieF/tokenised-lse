# Stage 1 — TToken Token

## Objective

Implement a capped ERC-20 stable token “TToken” serving as the base trading currency.

## Deliverables

* `contracts/TToken.sol`

  * Inherits OpenZeppelin ERC20 and AccessControl
  * Defines roles: DEFAULT_ADMIN_ROLE, MINTER_ROLE
  * Implements `airdropOnce()` mapping to prevent repeat claims
  * Fixed cap set in constructor
* `scripts/deploy-ttoken.js`
* `scripts/stage1/instructions.md`
* `test/ttoken.test.js`

## Tests

* Total supply does not exceed cap
* Only MINTER_ROLE can mint
* Each wallet receives airdrop once
* Transfer and approval functions operate normally

## Approval Criteria

* All tests pass (`npx hardhat test`)
* Gas report acceptable
* Verified in local Hardhat deployment
