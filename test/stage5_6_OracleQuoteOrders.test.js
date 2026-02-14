const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_SHARE = 10n ** 18n;

function quoteAmount(qty, priceCents) {
  return (qty * priceCents) / 100n;
}

async function deployStage56Fixture() {
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
  const equity = await equityFactory.deploy("Acme Equity", "AAPL", admin.address, admin.address);
  await equity.waitForDeployment();

  const equityAddress = await equity.getAddress();
  await registry.connect(admin).registerListing("AAPL", "Acme Equity", equityAddress);

  const dexFactory = await ethers.getContractFactory("OrderBookDEX");
  const dex = await dexFactory.deploy(
    await ttoken.getAddress(),
    await registry.getAddress(),
    await priceFeed.getAddress()
  );
  await dex.waitForDeployment();

  return { admin, maker1, maker2, taker, ttoken, registry, priceFeed, equity, dex };
}

describe("Stage 5.6 — buyExactQuoteAtOracle", function () {
  it("uses oracle max bound to filter asks", async function () {
    const fixture = await loadFixture(deployStage56Fixture);
    const admin = fixture.admin;
    const maker1 = fixture.maker1;
    const maker2 = fixture.maker2;
    const taker = fixture.taker;
    const ttoken = fixture.ttoken;
    const priceFeed = fixture.priceFeed;
    const equity = fixture.equity;
    const dex = fixture.dex;

    await priceFeed.connect(admin).setPrice("AAPL", 10_000);

    await equity.connect(admin).mint(maker1.address, ONE_SHARE);
    await equity.connect(admin).mint(maker2.address, ONE_SHARE);
    await ttoken.connect(admin).mint(taker.address, quoteAmount(ONE_SHARE, 10_000n));

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await equity.connect(maker1).approve(dexAddress, ONE_SHARE);
    await equity.connect(maker2).approve(dexAddress, ONE_SHARE);
    await ttoken.connect(taker).approve(dexAddress, ethers.MaxUint256);

    await dex.connect(maker1).placeLimitOrder(equityAddress, 1, 9_990n, ONE_SHARE);
    await dex.connect(maker2).placeLimitOrder(equityAddress, 1, 10_010n, ONE_SHARE);

    const budget = quoteAmount(ONE_SHARE, 10_000n);
    await dex.connect(taker).buyExactQuoteAtOracle(equityAddress, budget, 0);

    const orders = await dex.getSellOrders(equityAddress);
    expect(orders[0].remaining).to.equal(0);
    expect(orders[1].remaining).to.equal(ONE_SHARE);
  });

  it("expands eligibility with slippage", async function () {
    const fixture = await loadFixture(deployStage56Fixture);
    const admin = fixture.admin;
    const maker1 = fixture.maker1;
    const taker = fixture.taker;
    const ttoken = fixture.ttoken;
    const priceFeed = fixture.priceFeed;
    const equity = fixture.equity;
    const dex = fixture.dex;

    await priceFeed.connect(admin).setPrice("AAPL", 10_000);

    await equity.connect(admin).mint(maker1.address, ONE_SHARE);
    await ttoken.connect(admin).mint(taker.address, quoteAmount(ONE_SHARE, 10_150n));

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await equity.connect(maker1).approve(dexAddress, ONE_SHARE);
    await ttoken.connect(taker).approve(dexAddress, ethers.MaxUint256);

    await dex.connect(maker1).placeLimitOrder(equityAddress, 1, 10_150n, ONE_SHARE);

    const budget = quoteAmount(ONE_SHARE, 10_150n);
    await dex.connect(taker).buyExactQuoteAtOracle(equityAddress, budget, 200);

    const orders = await dex.getSellOrders(equityAddress);
    expect(orders[0].remaining).to.equal(0);
  });

  it("reverts when stale", async function () {
    const fixture = await loadFixture(deployStage56Fixture);
    const admin = fixture.admin;
    const taker = fixture.taker;
    const ttoken = fixture.ttoken;
    const priceFeed = fixture.priceFeed;
    const equity = fixture.equity;
    const dex = fixture.dex;

    await priceFeed.connect(admin).setPrice("AAPL", 10_000);
    await time.increase(61);

    const budget = quoteAmount(ONE_SHARE, 10_000n);
    await ttoken.connect(admin).mint(taker.address, budget);

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await ttoken.connect(taker).approve(dexAddress, ethers.MaxUint256);

    await expect(dex.connect(taker).buyExactQuoteAtOracle(equityAddress, budget, 0))
      .to.be.revertedWith("orderbook: stale price");
  });

  it("reverts for unknown token", async function () {
    const fixture = await loadFixture(deployStage56Fixture);
    const admin = fixture.admin;
    const taker = fixture.taker;
    const ttoken = fixture.ttoken;
    const priceFeed = fixture.priceFeed;
    const dex = fixture.dex;

    await priceFeed.connect(admin).setPrice("AAPL", 10_000);

    const budget = quoteAmount(ONE_SHARE, 10_000n);
    await ttoken.connect(admin).mint(taker.address, budget);

    const dexAddress = await dex.getAddress();
    await ttoken.connect(taker).approve(dexAddress, ethers.MaxUint256);

    const unknownToken = ethers.Wallet.createRandom().address;

    await expect(dex.connect(taker).buyExactQuoteAtOracle(unknownToken, budget, 0))
      .to.be.revertedWith("orderbook: unknown token");
  });

  it("emits OracleQuoteBuyExecuted", async function () {
    const fixture = await loadFixture(deployStage56Fixture);
    const admin = fixture.admin;
    const maker1 = fixture.maker1;
    const taker = fixture.taker;
    const ttoken = fixture.ttoken;
    const priceFeed = fixture.priceFeed;
    const equity = fixture.equity;
    const dex = fixture.dex;

    await priceFeed.connect(admin).setPrice("AAPL", 10_000);

    await equity.connect(admin).mint(maker1.address, ONE_SHARE);
    await ttoken.connect(admin).mint(taker.address, quoteAmount(ONE_SHARE, 10_000n));

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await equity.connect(maker1).approve(dexAddress, ONE_SHARE);
    await ttoken.connect(taker).approve(dexAddress, ethers.MaxUint256);

    await dex.connect(maker1).placeLimitOrder(equityAddress, 1, 10_000n, ONE_SHARE);

    const budget = quoteAmount(ONE_SHARE, 10_000n);

    await expect(dex.connect(taker).buyExactQuoteAtOracle(equityAddress, budget, 0))
      .to.emit(dex, "OracleQuoteBuyExecuted");
  });
});
