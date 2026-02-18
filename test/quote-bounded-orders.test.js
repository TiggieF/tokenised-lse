const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_SHARE = 10n ** 18n;

function quoteAmount(qty, priceCents) {
  return (qty * priceCents) / 100n;
}

async function deployStage55Fixture() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const maker1 = signers[1];
  const maker2 = signers[2];
  const taker = signers[3];

  const ttokenFactory = await ethers.getContractFactory("TToken");
  const ttoken = await ttokenFactory.deploy();
  await ttoken.waitForDeployment();

  const registryFactory = await ethers.getContractFactory("ListingsRegistry");
  const registry = await registryFactory.deploy(admin.address);
  await registry.waitForDeployment();

  const priceFeedFactory = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await priceFeedFactory.deploy(admin.address, admin.address);
  await priceFeed.waitForDeployment();

  const equityFactory = await ethers.getContractFactory("EquityToken");
  const equity = await equityFactory.deploy("Acme Equity", "ACME", admin.address, admin.address);
  await equity.waitForDeployment();

  const equityAddress = await equity.getAddress();
  await registry.connect(admin).registerListing("ACME", "Acme Equity", equityAddress);

  const dexFactory = await ethers.getContractFactory("OrderBookDEX");
  const dex = await dexFactory.deploy(
    await ttoken.getAddress(),
    await registry.getAddress(),
    await priceFeed.getAddress()
  );
  await dex.waitForDeployment();

  return { admin, maker1, maker2, taker, ttoken, equity, dex };
}

describe("Stage 5.5 — buyExactQuote", function () {
  it("respects quote budget and refunds leftover", async function () {
    const fixture = await loadFixture(deployStage55Fixture);
    const admin = fixture.admin;
    const maker1 = fixture.maker1;
    const taker = fixture.taker;
    const ttoken = fixture.ttoken;
    const equity = fixture.equity;
    const dex = fixture.dex;

    const price = 10_000n;
    const makerQty = 2n * ONE_SHARE;
    const budget = ONE_SHARE;

    await equity.connect(admin).mint(maker1.address, makerQty);
    await ttoken.connect(admin).mint(taker.address, budget);

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await equity.connect(maker1).approve(dexAddress, makerQty);
    await ttoken.connect(taker).approve(dexAddress, budget);

    await dex.connect(maker1).placeLimitOrder(equityAddress, 1, price, makerQty);

    const takerBefore = await ttoken.balanceOf(taker.address);

    const callResult = await dex.connect(taker).buyExactQuote.staticCall(equityAddress, budget, price);
    const qtyBought = callResult[0];
    const quoteSpent = callResult[1];

    await dex.connect(taker).buyExactQuote(equityAddress, budget, price);

    const takerAfter = await ttoken.balanceOf(taker.address);

    expect(qtyBought).to.be.gt(0);
    expect(quoteSpent).to.be.lte(budget);
    expect(takerAfter).to.equal(takerBefore - quoteSpent);
  });

  it("fills best price then FIFO", async function () {
    const fixture = await loadFixture(deployStage55Fixture);
    const admin = fixture.admin;
    const maker1 = fixture.maker1;
    const maker2 = fixture.maker2;
    const taker = fixture.taker;
    const ttoken = fixture.ttoken;
    const equity = fixture.equity;
    const dex = fixture.dex;

    const budget = quoteAmount(ONE_SHARE, 10_000n);

    await equity.connect(admin).mint(maker1.address, ONE_SHARE);
    await equity.connect(admin).mint(maker2.address, ONE_SHARE);
    await ttoken.connect(admin).mint(taker.address, budget);

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await equity.connect(maker1).approve(dexAddress, ONE_SHARE);
    await equity.connect(maker2).approve(dexAddress, ONE_SHARE);
    await ttoken.connect(taker).approve(dexAddress, budget);

    await dex.connect(maker1).placeLimitOrder(equityAddress, 1, 10_100n, ONE_SHARE);
    await dex.connect(maker2).placeLimitOrder(equityAddress, 1, 10_000n, ONE_SHARE);

    await dex.connect(taker).buyExactQuote(equityAddress, budget, 10_100n);

    const orders = await dex.getSellOrders(equityAddress);
    expect(orders[0].remaining).to.equal(ONE_SHARE);
    expect(orders[1].remaining).to.equal(0);
  });

  it("stops when remaining quote too small to buy", async function () {
    const fixture = await loadFixture(deployStage55Fixture);
    const admin = fixture.admin;
    const maker1 = fixture.maker1;
    const taker = fixture.taker;
    const ttoken = fixture.ttoken;
    const equity = fixture.equity;
    const dex = fixture.dex;

    const price = 99_999n;
    const budget = 1n;

    await equity.connect(admin).mint(maker1.address, ONE_SHARE);
    await ttoken.connect(admin).mint(taker.address, budget);

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await equity.connect(maker1).approve(dexAddress, ONE_SHARE);
    await ttoken.connect(taker).approve(dexAddress, budget);

    await dex.connect(maker1).placeLimitOrder(equityAddress, 1, price, ONE_SHARE);

    await expect(dex.connect(taker).buyExactQuote(equityAddress, budget, price))
      .to.be.revertedWith("orderbook: no fill");
  });

  it("reverts when no eligible sells", async function () {
    const fixture = await loadFixture(deployStage55Fixture);
    const admin = fixture.admin;
    const maker1 = fixture.maker1;
    const taker = fixture.taker;
    const ttoken = fixture.ttoken;
    const equity = fixture.equity;
    const dex = fixture.dex;

    await equity.connect(admin).mint(maker1.address, ONE_SHARE);
    await ttoken.connect(admin).mint(taker.address, ONE_SHARE);

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await equity.connect(maker1).approve(dexAddress, ONE_SHARE);
    await ttoken.connect(taker).approve(dexAddress, ONE_SHARE);

    await dex.connect(maker1).placeLimitOrder(equityAddress, 1, 20_000n, ONE_SHARE);

    await expect(dex.connect(taker).buyExactQuote(equityAddress, ONE_SHARE, 10_000n))
      .to.be.revertedWith("orderbook: no fill");
  });
});
