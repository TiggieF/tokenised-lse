# Tokenised LSE Manual

This manual explains the core smart contracts, their key variables, and how the
system works end-to-end. It also includes the original Stage 1 local setup for
TToken.

---

## 1. System Overview (How It Works)

- **TToken (Stage 1)** is the stable settlement token (USD-pegged in your model).
- **ListingsRegistry + EquityTokenFactory (Stage 2)** create and record a new
  ERC-20 equity token for each company listing (symbols are A–Z/0–9 only).
- **EquityToken (Stage 2)** represents a single company’s equity.
- **PriceFeed (Stage 3)** stores the latest USD-cent price per symbol with a
  timestamp, updated by a backend oracle wallet.

Typical flow:
1) Admin lists a company via the backend → `EquityTokenFactory.createEquityToken`.
2) Factory deploys the company token and registers it in `ListingsRegistry`.
3) Backend oracle pushes live prices to `PriceFeed`.
4) Frontend reads registry + price feed to display balances and prices.

Note: Price updates can also be triggered on demand (e.g. when a user clicks
“Buy”), but the backend must still write the price on-chain before the trade.

## 2. Contract Variables and Roles

### TToken.sol
- `MINTER_ROLE`: AccessControl role for minting.
- `MAX_SUPPLY`: Hard cap for total supply.
- `AIRDROP_AMOUNT`: One-time airdrop size per wallet.
- `_airdropClaimed`: Mapping of wallet → claimed status.
- `AirdropClaimed`: Event emitted on successful airdrop.

### EquityToken.sol
- `MINTER_ROLE`: AccessControl role for minting equity tokens.
- `name`/`symbol` (ERC-20 metadata): Company name and ticker symbol.

### ListingsRegistry.sol
- `LISTING_ROLE`: Role allowed to register listings (factory holds this).
- `_listings`: Mapping of symbol hash → `Listing` struct.
- `Listing.token`: Equity token address.
- `Listing.symbol`: Stored symbol string.
- `Listing.name`: Stored company name.
- `StockListed`: Event emitted when a new listing is registered.

### EquityTokenFactory.sol
- `registry`: Registry contract used for symbol → token mapping.
- `defaultMinter`: Backend wallet that receives `MINTER_ROLE` on new tokens.

### PriceFeed.sol
- `ORACLE_ROLE`: Role allowed to update prices.
- `_prices`: Mapping of symbol hash → `PriceEntry`.
- `PriceEntry.priceCents`: Latest price in USD cents.
- `PriceEntry.timestamp`: Last update time (unix seconds).
- `PriceUpdated`: Event emitted on each price update.

## 3. Local Stage 1 (TToken) Walkthrough

### You need:

* Node.js installed
* Hardhat installed (via your project)
* MetaMask browser extension
* Your Conda environment: `tokenised-lse`

Your project folder:

```
~/Desktop/tokenised-lse
```

---

## 3.1 Start Hardhat Local Network

Open Terminal:

```bash
cd ~/Desktop/tokenised-lse
conda activate tokenised-lse
npx hardhat node
```

You will see accounts printed:

```
Account #19: 0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199
Private Key: 0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e
```

➡️ **Keep this terminal open. It is your blockchain.**

---

## 3.2 Deploy TToken Contract

Open a new Terminal tab:

```bash
cd ~/Desktop/tokenised-lse
conda activate tokenised-lse
npx hardhat run --network localhost scripts/stage1/deploy.js
```

You will see:

```
TToken deployed to: 0x5FbDB2315678afecb367f032d93F642f64180aa3
```

➡️ **Copy this contract address.**

---

## 3.3 Configure MetaMask (Local Hardhat Network)

In MetaMask:

1. Settings → Networks → Add Network → "Add network manually"
2. Fill in:

   * **Network Name:** Hardhat Localnet
   * **RPC URL:** `http://127.0.0.1:8545`
   * **Chain ID:** `31337`
   * **Symbol:** `ETH`

Save.

---

## 3.4 Import Your Hardhat Test Wallet

In MetaMask:

* Click Account Icon → **Import Account**
* Paste private key:

```
0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e
```

Your wallet address:

```
0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199
```

You will see **10,000 ETH (test)**.

---

## 3.5 Add TToken Token to MetaMask

In MetaMask → **Assets → Import Tokens → Custom Token**

Enter:

* **Token Contract Address:** *(your deployed address)*

```
0x5FbDB2315678afecb367f032d93F642f64180aa3
```

* **Symbol:** `TToken`
* **Decimals:** `18`

Click **Add Token**.

MetaMask will now track the TToken balance.

---

## 3.6 Airdrop TToken to Your Wallet

Open a new Terminal tab:

```bash
npx hardhat console --network localhost
```

Then paste the following:

```js
const TToken = await ethers.getContractAt(
  "TToken",
  "0x5FbDB2315678afecb367f032d93F642f64180aa3" 
);

const wallet19 = new ethers.Wallet(
  "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e",
  ethers.provider
);

const me = await wallet19.getAddress();
const TT19 = TToken.connect(wallet19);

await (await TT19.airdropOnce()).wait();
```

Expected output: a transaction receipt.

---

## 3.7 Verify Your Token Balance

In the same console:

```js
ethers.formatUnits(await TToken.balanceOf(me), 18);
```

Expected result:

```
'1000000.0'
```

Now check MetaMask → **You will see 1,000,000 TToken**.

---

## 4. Notes

### 1. Restarting Hardhat resets everything

Whenever you run:

```bash
npx hardhat node
```

The blockchain resets.

* You must redeploy the contract.
* You must re-add the new contract address to MetaMask.
* Airdrop again.

### 2. Local ETH is not real

The 10,000 ETH is test ETH only valid on localhost.

### 3. Using multiple wallets

You can import any Hardhat account into MetaMask using its private key.

---
