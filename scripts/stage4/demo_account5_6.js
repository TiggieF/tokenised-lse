// scripts/stage4/demo_account5_6.js
// -----------------------------------------------------------------------------
// Demo: mint TToken + AAPL to accounts #5 and #6, trade via OrderBookDEX,
// and display balances before/after.
// -----------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const ONE_SHARE = 10n ** 18n;
const PRICE = 10_000n; // $100.00 in cents

function quoteAmount(qty, priceCents) {
  return (qty * priceCents) / 100n;
}

async function loadDeployment() {
  const filePath = path.join(__dirname, "..", "..", "deployments", "localhost.json");
  if (!fs.existsSync(filePath)) {
    throw new Error("Missing deployments/localhost.json. Run stage2 + stage4 deploys first.");
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function logBalances(label, ttoken, equity, dexAddr, seller, buyer) {
  console.log(`\n${label}`);
  console.log("Seller equity:", (await equity.balanceOf(seller.address)).toString());
  console.log("Buyer equity:", (await equity.balanceOf(buyer.address)).toString());
  console.log("DEX equity:", (await equity.balanceOf(dexAddr)).toString());
  console.log("Seller TToken:", (await ttoken.balanceOf(seller.address)).toString());
  console.log("Buyer TToken:", (await ttoken.balanceOf(buyer.address)).toString());
  console.log("DEX TToken:", (await ttoken.balanceOf(dexAddr)).toString());
}

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const minter = signers[1];
  const seller = signers[5];
  const buyer = signers[6];

  const deployment = await loadDeployment();
  const dexAddr = deployment.orderBookDex;
  const registryAddr = deployment.listingsRegistry;

  const dex = await ethers.getContractAt("OrderBookDEX", dexAddr);
  const ttokenAddr = await dex.ttoken();
  const ttoken = await ethers.getContractAt("TToken", ttokenAddr);

  const registry = await ethers.getContractAt("ListingsRegistry", registryAddr);
  const equityAddr = await registry.getListing("AAPL");
  if (equityAddr === ethers.ZeroAddress) {
    throw new Error("AAPL not listed. Run scripts/deployStage2.js first.");
  }
  const equity = await ethers.getContractAt("EquityToken", equityAddr);

  const qty = ONE_SHARE;
  const quote = quoteAmount(qty, PRICE);

  await equity.connect(minter).mint(seller.address, qty);
  await ttoken.connect(admin).mint(buyer.address, quote);

  await equity.connect(seller).approve(dexAddr, ethers.MaxUint256);
  await ttoken.connect(buyer).approve(dexAddr, ethers.MaxUint256);

  console.log("OrderBookDEX:", dexAddr);
  console.log("TToken:", ttokenAddr);
  console.log("EquityToken (AAPL):", equityAddr);
  console.log("Seller (acct #5):", seller.address);
  console.log("Buyer (acct #6):", buyer.address);
  console.log("Price (cents):", PRICE.toString());
  console.log("Qty (shares, 18dp):", qty.toString());
  console.log("Quote (TToken wei):", quote.toString());

  await logBalances("Balances before trade", ttoken, equity, dexAddr, seller, buyer);

  const sellTx = await dex.connect(seller).placeLimitOrder(equityAddr, 1, PRICE, qty);
  const sellReceipt = await sellTx.wait();
  console.log("\nSell gas used:", sellReceipt.gasUsed.toString());

  const buyTx = await dex.connect(buyer).placeLimitOrder(equityAddr, 0, PRICE, qty);
  const buyReceipt = await buyTx.wait();
  console.log("Buy gas used:", buyReceipt.gasUsed.toString());

  await logBalances("Balances after trade", ttoken, equity, dexAddr, seller, buyer);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
