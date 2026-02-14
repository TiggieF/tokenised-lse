# Stage 1 Script Usage — TToken

Use this guide to deploy and test the Stage 1 **TToken** contract from the `scripts/stage1` folder. Every command assumes you start from the project root (`tokenised-lse`).

## Prerequisites

- Install dependencies: `npm install`
- Ensure Hardhat is available via `npx hardhat`
- Recommended terminal layout:
  1. **Terminal A** – runs the local Hardhat node and stays open.
  2. **Terminal B** – runs compile/deploy/test commands.
  3. **Terminal C (optional)** – attaches a console session for token distribution.

## Terminal A — start the local blockchain

```bash
cd tokenised-lse
npx hardhat node
```

Leave this process running so the other terminals can connect to `localhost:8545`.

## Terminal B — compile and deploy TTokens

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

## Distributing TToken (airdrop)

You can hand out the onboarding airdrop either from the Hardhat console or via the helper script. The default wallet used in the manual (Hardhat Account #19: `0x8626…1199`, private key `0xdf57…3656e`) works for both methods.
### Option 1 — Hardhat console

```bash
npx hardhat console --network localhost
```

Inside the console, paste:

```js
const tokenAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; 
const token = await ethers.getContractAt("TToken", tokenAddress);

const wallet = new ethers.Wallet("<0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e>",ethers.provider);

const recipient = await wallet.getAddress();
await (await token.connect(wallet).airdropOnce()).wait();
```

Replace the placeholder values with the deployed address and the wallet that should receive the one-time TToken airdrop. Each wallet can run `airdropOnce()` only once.


### Option 2 — `sendAirdrop.js` helper

If you already imported the Hardhat default “Account #19” (`0x8626…1199`) into MetaMask and have its private key (`0xdf57…3656e`), set the env vars, then run the script:

```bash
export TTOKEN_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3 
export AIRDROP_PRIVATE_KEY=0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e
npx hardhat run scripts/stage1/sendAirdrop.js --network localhost
```

The script checks whether the wallet has already claimed the TToken airdrop and, if not, submits the `airdropOnce()` transaction for you.

## Testing the TTokens contract

1. **Execute the Stage 1 test suite only:**
   ```bash
   npx hardhat test test/stage1_TToken.test.js
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
