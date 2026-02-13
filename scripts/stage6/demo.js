





const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const ONE_SHARE = 10n ** 18n;
const PRICE = 10_000n; 

function quoteAmount(qty, priceCents) {
  return (qty * priceCents) / 100n;
}

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const minter = signers[1];
  const trader5 = signers[5];
  const trader6 = signers[6];
  const trader7 = signers[7];

  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "deployments", "localhost.json"), "utf8")
  );

  const dexAddr = deployment.orderBookDex;
  const registryAddr = deployment.listingsRegistry;

  const dex = await ethers.getContractAt("OrderBookDEX", dexAddr);
  const ttoken = await ethers.getContractAt("TToken", await dex.ttoken());
  const registry = await ethers.getContractAt("ListingsRegistry", registryAddr);
  const equityAddr = await registry.getListing("AAPL");
  const equity = await ethers.getContractAt("EquityToken", equityAddr);

  const Award = await ethers.getContractFactory("Award");
  const award = await Award.deploy(await ttoken.getAddress(), admin.address, dexAddr);
  await award.waitForDeployment();

  const minterRole = await ttoken.MINTER_ROLE();
  await ttoken.connect(admin).grantRole(minterRole, await award.getAddress());

  await dex.connect(admin).setAward(await award.getAddress());

  const qty = ONE_SHARE;
  const quote = quoteAmount(qty, PRICE);

  await equity.connect(minter).mint(trader5.address, 3n * qty);
  await equity.connect(minter).mint(trader6.address, 1n * qty);
  await equity.connect(minter).mint(trader7.address, 1n * qty);

  await ttoken.connect(admin).mint(trader5.address, 3n * quote);
  await ttoken.connect(admin).mint(trader6.address, 2n * quote);
  await ttoken.connect(admin).mint(trader7.address, 2n * quote);

  await equity.connect(trader5).approve(dexAddr, ethers.MaxUint256);
  await equity.connect(trader6).approve(dexAddr, ethers.MaxUint256);
  await equity.connect(trader7).approve(dexAddr, ethers.MaxUint256);
  await ttoken.connect(trader5).approve(dexAddr, ethers.MaxUint256);
  await ttoken.connect(trader6).approve(dexAddr, ethers.MaxUint256);
  await ttoken.connect(trader7).approve(dexAddr, ethers.MaxUint256);

  console.log("DEX:", dexAddr);
  console.log("Award:", await award.getAddress());
  console.log("Epoch duration (sec):", (await award.EPOCH_DURATION()).toString());
  console.log("Reward (wei):", (await award.REWARD_AMOUNT()).toString());

  const epoch = await award.currentEpoch();

  
  await dex.connect(trader5).placeLimitOrder(equityAddr, 1, PRICE, qty);
  await dex.connect(trader6).placeLimitOrder(equityAddr, 0, PRICE, qty);

  await dex.connect(trader5).placeLimitOrder(equityAddr, 1, PRICE, qty);
  await dex.connect(trader7).placeLimitOrder(equityAddr, 0, PRICE, qty);

  await dex.connect(trader5).placeLimitOrder(equityAddr, 1, PRICE, qty);
  await dex.connect(trader6).placeLimitOrder(equityAddr, 0, PRICE, qty);

  
  await ethers.provider.send("evm_increaseTime", [11]);
  await ethers.provider.send("evm_mine", []);

  await award.finalizeEpoch(epoch);

  console.log("Top trader:", await award.topTraderByEpoch(epoch));
  console.log("Trader5 reward balance:", (await ttoken.balanceOf(trader5.address)).toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
