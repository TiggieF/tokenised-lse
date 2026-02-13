const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_SHARE = 10n ** 18n;

function quoteAmount(qty, priceCents) {
  return (qty * priceCents) / 100n;
}

async function deployStage55Fixture() {
  const [admin, maker1, maker2, taker] = await ethers.getSigners();

  const TToken = await ethers.getContractFactory("TToken");
  const ttoken = await TToken.deploy();
  await ttoken.waitForDeployment();

  const ListingsRegistry = await ethers.getContractFactory("ListingsRegistry");
  const registry = await ListingsRegistry.deploy(admin.address);
  await registry.waitForDeployment();

  const PriceFeed = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await PriceFeed.deploy(admin.address, admin.address);
  await priceFeed.waitForDeployment();

  const EquityToken = await ethers.getContractFactory("EquityToken");
  const equity = await EquityToken.deploy("Acme Equity", "ACME", admin.address, admin.address);
  await equity.waitForDeployment();

  await registry.connect(admin).registerListing("ACME", "Acme Equity", await equity.getAddress());

  const OrderBookDEX = await ethers.getContractFactory("OrderBookDEX");
  const dex = await OrderBookDEX.deploy(
    await ttoken.getAddress(),
    await registry.getAddress(),
    await priceFeed.getAddress()
  );
  await dex.waitForDeployment();

  return { admin, maker1, maker2, taker, ttoken, equity, dex };
}

describe("Stage 5.5 — buyExactQuote", function () {
  it("respects quote budget and refunds leftover", async function () {
    const { admin, maker1, taker, ttoken, equity, dex } = await loadFixture(deployStage55Fixture);

    const price = 10_000n;
    const makerQty = 2n * ONE_SHARE;
    const budget = ONE_SHARE; 

    await equity.connect(admin).mint(maker1.address, makerQty);
    await ttoken.connect(admin).mint(taker.address, budget);

    await equity.connect(maker1).approve(await dex.getAddress(), makerQty);
    await ttoken.connect(taker).approve(await dex.getAddress(), budget);

    await dex.connect(maker1).placeLimitOrder(await equity.getAddress(), 1, price, makerQty);

    const takerBefore = await ttoken.balanceOf(taker.address);
    const [qtyBought, quoteSpent] = await dex
      .connect(taker)
      .buyExactQuote.staticCall(await equity.getAddress(), budget, price);
    await dex.connect(taker).buyExactQuote(await equity.getAddress(), budget, price);

    expect(qtyBought).to.be.gt(0);
    expect(quoteSpent).to.be.lte(budget);
    const takerAfter = await ttoken.balanceOf(taker.address);
    expect(takerAfter).to.equal(takerBefore - quoteSpent);
  });

  it("fills best price then FIFO", async function () {
    const { admin, maker1, maker2, taker, ttoken, equity, dex } = await loadFixture(
      deployStage55Fixture
    );

    const budget = quoteAmount(ONE_SHARE, 10_000n);

    await equity.connect(admin).mint(maker1.address, ONE_SHARE);
    await equity.connect(admin).mint(maker2.address, ONE_SHARE);
    await ttoken.connect(admin).mint(taker.address, budget);

    await equity.connect(maker1).approve(await dex.getAddress(), ONE_SHARE);
    await equity.connect(maker2).approve(await dex.getAddress(), ONE_SHARE);
    await ttoken.connect(taker).approve(await dex.getAddress(), budget);

    await dex.connect(maker1).placeLimitOrder(await equity.getAddress(), 1, 10_100n, ONE_SHARE);
    await dex.connect(maker2).placeLimitOrder(await equity.getAddress(), 1, 10_000n, ONE_SHARE);

    await dex.connect(taker).buyExactQuote(await equity.getAddress(), budget, 10_100n);

    const orders = await dex.getSellOrders(await equity.getAddress());
    expect(orders[0].remaining).to.equal(ONE_SHARE); 
    expect(orders[1].remaining).to.equal(0);
  });

  it("stops when remaining quote too small to buy", async function () {
    const { admin, maker1, taker, ttoken, equity, dex } = await loadFixture(deployStage55Fixture);

    const price = 99_999n; 
    const budget = 1n; 

    await equity.connect(admin).mint(maker1.address, ONE_SHARE);
    await ttoken.connect(admin).mint(taker.address, budget);

    await equity.connect(maker1).approve(await dex.getAddress(), ONE_SHARE);
    await ttoken.connect(taker).approve(await dex.getAddress(), budget);

    await dex.connect(maker1).placeLimitOrder(await equity.getAddress(), 1, price, ONE_SHARE);

    await expect(
      dex.connect(taker).buyExactQuote(await equity.getAddress(), budget, price)
    ).to.be.revertedWith("orderbook: no fill");
  });

  it("reverts when no eligible sells", async function () {
    const { admin, maker1, taker, ttoken, equity, dex } = await loadFixture(deployStage55Fixture);

    await equity.connect(admin).mint(maker1.address, ONE_SHARE);
    await ttoken.connect(admin).mint(taker.address, ONE_SHARE);

    await equity.connect(maker1).approve(await dex.getAddress(), ONE_SHARE);
    await ttoken.connect(taker).approve(await dex.getAddress(), ONE_SHARE);

    await dex.connect(maker1).placeLimitOrder(await equity.getAddress(), 1, 20_000n, ONE_SHARE);

    await expect(
      dex.connect(taker).buyExactQuote(await equity.getAddress(), ONE_SHARE, 10_000n)
    ).to.be.revertedWith("orderbook: no fill");
  });
});
