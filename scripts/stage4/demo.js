







const { ethers } = require("hardhat");

const DEFAULT_PRICE = 10_000n; 
const ONE_SHARE = 10n ** 18n;

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const seller = signers[1];
  const buyer = signers[2];
  const equityMinterIndex = Number.parseInt(process.env.EQUITY_MINTER_INDEX || "0", 10);
  const equityMinter = signers[equityMinterIndex] || admin;

  const dexAddress = process.env.DEX_ADDRESS;
  const ttokenAddress = process.env.TTOKEN_ADDRESS;
  const equityAddress = process.env.EQUITY_TOKEN_ADDRESS;
  const price = process.env.PRICE ? BigInt(process.env.PRICE) : DEFAULT_PRICE;
  const qty = process.env.QTY ? BigInt(process.env.QTY) : ONE_SHARE;

  if (!dexAddress) {
    throw new Error("Set DEX_ADDRESS env var");
  }
  if (!ttokenAddress) {
    throw new Error("Set TTOKEN_ADDRESS env var");
  }

  const ttoken = await ethers.getContractAt("TToken", ttokenAddress);
  const dex = await ethers.getContractAt("OrderBookDEX", dexAddress);

  let equity;
  if (equityAddress) {
    equity = await ethers.getContractAt("EquityToken", equityAddress);
  } else {
    const EquityToken = await ethers.getContractFactory("EquityToken");
    equity = await EquityToken.deploy("Acme Equity", "ACME", admin.address, admin.address);
    await equity.waitForDeployment();
    console.log("EquityToken deployed to:", await equity.getAddress());
  }

  const tradeValue = (qty * price) / 100n;

  await equity.connect(equityMinter).mint(seller.address, qty);
  await ttoken.connect(admin).mint(buyer.address, tradeValue);

  await equity.connect(seller).approve(dexAddress, ethers.MaxUint256);
  await ttoken.connect(buyer).approve(dexAddress, ethers.MaxUint256);

  await dex.connect(seller).placeLimitOrder(await equity.getAddress(), 1, price, qty);
  await dex.connect(buyer).placeLimitOrder(await equity.getAddress(), 0, price, qty);

  console.log("Trade executed.");
  console.log("Seller equity balance:", (await equity.balanceOf(seller.address)).toString());
  console.log("Buyer equity balance:", (await equity.balanceOf(buyer.address)).toString());
  console.log("Buyer TToken balance:", (await ttoken.balanceOf(buyer.address)).toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
