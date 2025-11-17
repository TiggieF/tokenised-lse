# Stage 1 Script Usage — TGBP

Use this guide to deploy and test the Stage 1 TGBP token from the `scripts/stage1` folder. The commands assume you are in the project root (`tokenised-lse`).

## Prerequisites

- Install dependencies: `npm install`
- Ensure Hardhat is available via `npx hardhat`
- Have a local Hardhat node running (recommended for quick iteration):
  - In a separate terminal: `npx hardhat node`

## Deploying TGBP

1. **Compile contracts (once per code change):**
   ```bash
   npx hardhat compile
   ```
2. **Run the Stage 1 deployment script against your chosen network:**
   ```bash
   npx hardhat run scripts/stage1/deploy.js --network localhost
   ```
3. **What to look for:**
   - The console logs the deployer address and its balance.
   - After deployment, note the printed token address.
   - Confirm `MAX_SUPPLY` and `AIRDROP_AMOUNT` outputs match expectations.

## Testing the TGBP contract

1. **Execute the Stage 1 test suite only:**
   ```bash
   npx hardhat test test/stage1_TGBP.test.js
   ```
2. **Full test run (if you want everything):**
   ```bash
   npx hardhat test
   ```
3. **Validation goals:**
   - Total supply never exceeds the cap.
   - Only `MINTER_ROLE` can mint.
   - `airdropOnce` can be claimed once per wallet.
   - Standard ERC-20 transfers and approvals behave normally.

## Feedback checklist

- Did deployment succeed on your target network?
- Are the max supply and airdrop values correct in the logs?
- Do all tests pass locally?
- Any confusing steps or missing details? Tell us so we can refine the flow.
