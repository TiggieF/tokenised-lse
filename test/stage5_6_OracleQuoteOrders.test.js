const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_SHARE = 10n ** 18n;

function quoteAmount(qty, priceCents) {
  return (qty * priceCents) / 100n;
}

async function deployStage56Fixture() {
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
  const equity = await EquityToken.deploy("Acme Equity", "AAPL", admin.address, admin.address);
  await equity.waitForDeployment();

  await registry.connect(admin).registerListing("AAPL", "Acme Equity", await equity.getAddress());

  const OrderBookDEX = await ethers.getContractFactory("OrderBookDEX");
  const dex = await OrderBookDEX.deploy(
    await ttoken.getAddress(),
    await registry.getAddress(),
    await priceFeed.getAddress()
  );
  await dex.waitForDeployment();

  return { admin, maker1, maker2, taker, ttoken, registry, priceFeed, equity, dex };
}

describe("Stage 5.6 — buyExactQuoteAtOracle", function () {
  it("uses oracle max bound to filter asks", async function () {
    const { admin, maker1, maker2, taker, ttoken, priceFeed, equity, dex } =
      await loadFixture(deployStage56Fixture);

    await priceFeed.connect(admin).setPrice("AAPL", 10_000);

    await equity.connect(admin).mint(maker1.address, ONE_SHARE);
    await equity.connect(admin).mint(maker2.address, ONE_SHARE);
    await ttoken.connect(admin).mint(taker.address, quoteAmount(ONE_SHARE, 10_000n));

    await equity.connect(maker1).approve(await dex.getAddress(), ONE_SHARE);
    await equity.connect(maker2).approve(await dex.getAddress(), ONE_SHARE);
    await ttoken.connect(taker).approve(await dex.getAddress(), ethers.MaxUint256);

    await dex.connect(maker1).placeLimitOrder(await equity.getAddress(), 1, 9_990n, ONE_SHARE);
    await dex.connect(maker2).placeLimitOrder(await equity.getAddress(), 1, 10_010n, ONE_SHARE);

    await dex.connect(taker).buyExactQuoteAtOracle(await equity.getAddress(), quoteAmount(ONE_SHARE, 10_000n), 0);

    const orders = await dex.getSellOrders(await equity.getAddress());
    expect(orders[0].remaining).to.equal(0);
    expect(orders[1].remaining).to.equal(ONE_SHARE);
  });

  it("expands eligibility with slippage", async function () {
    const { admin, maker1, taker, ttoken, priceFeed, equity, dex } =
      await loadFixture(deployStage56Fixture);

    await priceFeed.connect(admin).setPrice("AAPL", 10_000);

    await equity.connect(admin).mint(maker1.address, ONE_SHARE);
    await ttoken.connect(admin).mint(taker.address, quoteAmount(ONE_SHARE, 10_150n));

    await equity.connect(maker1).approve(await dex.getAddress(), ONE_SHARE);
    await ttoken.connect(taker).approve(await dex.getAddress(), ethers.MaxUint256);

    await dex.connect(maker1).placeLimitOrder(await equity.getAddress(), 1, 10_150n, ONE_SHARE);

    await dex.connect(taker).buyExactQuoteAtOracle(await equity.getAddress(), quoteAmount(ONE_SHARE, 10_150n), 200);

    const orders = await dex.getSellOrders(await equity.getAddress());
    expect(orders[0].remaining).to.equal(0);
  });

  it("reverts when stale", async function () {
    const { admin, taker, ttoken, priceFeed, equity, dex } = await loadFixture(
      deployStage56Fixture
    );

    await priceFeed.connect(admin).setPrice("AAPL", 10_000);
    await time.increase(61);

    await ttoken.connect(admin).mint(taker.address, quoteAmount(ONE_SHARE, 10_000n));
    await ttoken.connect(taker).approve(await dex.getAddress(), ethers.MaxUint256);

    await expect(
      dex.connect(taker).buyExactQuoteAtOracle(await equity.getAddress(), quoteAmount(ONE_SHARE, 10_000n), 0)
    ).to.be.revertedWith("orderbook: stale price");
  });

  it("reverts for unknown token", async function () {
    const { admin, taker, ttoken, priceFeed, dex } = await loadFixture(deployStage56Fixture);

    await priceFeed.connect(admin).setPrice("AAPL", 10_000);
    await ttoken.connect(admin).mint(taker.address, quoteAmount(ONE_SHARE, 10_000n));
    await ttoken.connect(taker).approve(await dex.getAddress(), ethers.MaxUint256);

    await expect(
      dex.connect(taker).buyExactQuoteAtOracle(ethers.Wallet.createRandom().address, quoteAmount(ONE_SHARE, 10_000n), 0)
    ).to.be.revertedWith("orderbook: unknown token");
  });

  it("emits OracleQuoteBuyExecuted", async function () {
    const { admin, maker1, taker, ttoken, priceFeed, equity, dex } =
      await loadFixture(deployStage56Fixture);

    await priceFeed.connect(admin).setPrice("AAPL", 10_000);
    await equity.connect(admin).mint(maker1.address, ONE_SHARE);
    await ttoken.connect(admin).mint(taker.address, quoteAmount(ONE_SHARE, 10_000n));

    await equity.connect(maker1).approve(await dex.getAddress(), ONE_SHARE);
    await ttoken.connect(taker).approve(await dex.getAddress(), ethers.MaxUint256);

    await dex.connect(maker1).placeLimitOrder(await equity.getAddress(), 1, 10_000n, ONE_SHARE);

    await expect(
      dex.connect(taker).buyExactQuoteAtOracle(await equity.getAddress(), quoteAmount(ONE_SHARE, 10_000n), 0)
    ).to.emit(dex, "OracleQuoteBuyExecuted");
  });
});
