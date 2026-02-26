const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const PRICE = 10_000n;
const ONE_SHARE = 10n ** 18n;

function quoteAmount(qty, price) {
  return (qty * price) / 100n;
}

async function deployOrderBookFixture() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const alice = signers[1];
  const bob = signers[2];
  const carol = signers[3];
  const dave = signers[4];

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

  return { admin, alice, bob, carol, dave, ttoken, equity, dex };
}

const describeLocal = network.name === "hardhat" ? describe : describe.skip;

describeLocal("OrderBookDEX", function () {
  it("processes partial fills on buys", async function () {
    const fixture = await loadFixture(deployOrderBookFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const bob = fixture.bob;
    const ttoken = fixture.ttoken;
    const equity = fixture.equity;
    const dex = fixture.dex;

    const sellQty = 2n * ONE_SHARE;
    const buyQty = ONE_SHARE;

    await equity.connect(admin).mint(alice.address, sellQty);
    await ttoken.connect(admin).mint(bob.address, quoteAmount(sellQty, PRICE));

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await equity.connect(alice).approve(dexAddress, sellQty);
    await ttoken.connect(bob).approve(dexAddress, ethers.MaxUint256);

    await dex.connect(alice).placeLimitOrder(equityAddress, 1, PRICE, sellQty);
    await dex.connect(bob).placeLimitOrder(equityAddress, 0, PRICE, buyQty);

    const sellOrders = await dex.getSellOrders(equityAddress);
    const buyOrders = await dex.getBuyOrders(equityAddress);

    expect(sellOrders[0].remaining).to.equal(sellQty - buyQty);
    expect(sellOrders[0].active).to.equal(true);
    expect(buyOrders[0].remaining).to.equal(0);
    expect(buyOrders[0].active).to.equal(false);

    const tradeValue = quoteAmount(buyQty, PRICE);
    const buyerEquity = await equity.balanceOf(bob.address);
    const sellerCash = await ttoken.balanceOf(alice.address);

    expect(buyerEquity).to.equal(buyQty);
    expect(sellerCash).to.equal(tradeValue);
  });

  it("enforces price-time priority on sells", async function () {
    const fixture = await loadFixture(deployOrderBookFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const bob = fixture.bob;
    const carol = fixture.carol;
    const dave = fixture.dave;
    const ttoken = fixture.ttoken;
    const equity = fixture.equity;
    const dex = fixture.dex;

    const sellQty = ONE_SHARE;
    const totalBuyerCash = quoteAmount(2n * sellQty, 10_100n);

    await equity.connect(admin).mint(alice.address, sellQty);
    await equity.connect(admin).mint(bob.address, sellQty);
    await equity.connect(admin).mint(carol.address, sellQty);
    await ttoken.connect(admin).mint(dave.address, totalBuyerCash);

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await equity.connect(alice).approve(dexAddress, sellQty);
    await equity.connect(bob).approve(dexAddress, sellQty);
    await equity.connect(carol).approve(dexAddress, sellQty);
    await ttoken.connect(dave).approve(dexAddress, ethers.MaxUint256);

    await dex.connect(alice).placeLimitOrder(equityAddress, 1, 10_100n, sellQty);
    await dex.connect(bob).placeLimitOrder(equityAddress, 1, 10_000n, sellQty);
    await dex.connect(carol).placeLimitOrder(equityAddress, 1, 10_000n, sellQty);

    await dex.connect(dave).placeLimitOrder(equityAddress, 0, 10_100n, 2n * sellQty);

    const sellOrders = await dex.getSellOrders(equityAddress);
    expect(sellOrders[0].remaining).to.equal(sellQty);
    expect(sellOrders[1].remaining).to.equal(0);
    expect(sellOrders[1].active).to.equal(false);
    expect(sellOrders[2].remaining).to.equal(0);
    expect(sellOrders[2].active).to.equal(false);

    const daveEquity = await equity.balanceOf(dave.address);
    expect(daveEquity).to.equal(2n * sellQty);
  });

  it("refunds remaining escrow on cancellation (buy)", async function () {
    const fixture = await loadFixture(deployOrderBookFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const bob = fixture.bob;
    const ttoken = fixture.ttoken;
    const equity = fixture.equity;
    const dex = fixture.dex;

    const buyQty = 2n * ONE_SHARE;
    const sellQty = ONE_SHARE / 2n;

    const buyQuote = quoteAmount(buyQty, PRICE);
    await ttoken.connect(admin).mint(bob.address, buyQuote);
    await equity.connect(admin).mint(alice.address, sellQty);

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await ttoken.connect(bob).approve(dexAddress, ethers.MaxUint256);
    await equity.connect(alice).approve(dexAddress, sellQty);

    await dex.connect(bob).placeLimitOrder(equityAddress, 0, PRICE, buyQty);
    const nextOrderId = await dex.nextOrderId();
    const takerId = nextOrderId - 1n;

    await dex.connect(alice).placeLimitOrder(equityAddress, 1, PRICE, sellQty);

    const remaining = buyQty - sellQty;
    const refundQuote = quoteAmount(remaining, PRICE);

    const balanceBefore = await ttoken.balanceOf(bob.address);
    await dex.connect(bob).cancelOrder(takerId);
    const balanceAfter = await ttoken.balanceOf(bob.address);

    expect(balanceAfter - balanceBefore).to.equal(refundQuote);
  });

  it("conserves balances across a trade", async function () {
    const fixture = await loadFixture(deployOrderBookFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const bob = fixture.bob;
    const ttoken = fixture.ttoken;
    const equity = fixture.equity;
    const dex = fixture.dex;

    const sellQty = ONE_SHARE;
    const buyQty = ONE_SHARE;

    await equity.connect(admin).mint(alice.address, sellQty);
    await ttoken.connect(admin).mint(bob.address, quoteAmount(buyQty, PRICE));

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await equity.connect(alice).approve(dexAddress, sellQty);
    await ttoken.connect(bob).approve(dexAddress, ethers.MaxUint256);

    const totalTTokenBefore =
      (await ttoken.balanceOf(alice.address)) +
      (await ttoken.balanceOf(bob.address)) +
      (await ttoken.balanceOf(dexAddress));

    const totalEquityBefore =
      (await equity.balanceOf(alice.address)) +
      (await equity.balanceOf(bob.address)) +
      (await equity.balanceOf(dexAddress));

    await dex.connect(alice).placeLimitOrder(equityAddress, 1, PRICE, sellQty);
    await dex.connect(bob).placeLimitOrder(equityAddress, 0, PRICE, buyQty);

    const totalTTokenAfter =
      (await ttoken.balanceOf(alice.address)) +
      (await ttoken.balanceOf(bob.address)) +
      (await ttoken.balanceOf(dexAddress));

    const totalEquityAfter =
      (await equity.balanceOf(alice.address)) +
      (await equity.balanceOf(bob.address)) +
      (await equity.balanceOf(dexAddress));

    expect(totalTTokenAfter).to.equal(totalTTokenBefore);
    expect(totalEquityAfter).to.equal(totalEquityBefore);
  });

  it("blocks self matching orders", async function () {
    const fixture = await loadFixture(deployOrderBookFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const ttoken = fixture.ttoken;
    const equity = fixture.equity;
    const dex = fixture.dex;

    const qty = ONE_SHARE;
    const quote = quoteAmount(qty, PRICE);

    await equity.connect(admin).mint(alice.address, qty);
    await ttoken.connect(admin).mint(alice.address, quote);

    const dexAddress = await dex.getAddress();
    const equityAddress = await equity.getAddress();

    await equity.connect(alice).approve(dexAddress, ethers.MaxUint256);
    await ttoken.connect(alice).approve(dexAddress, ethers.MaxUint256);

    await dex.connect(alice).placeLimitOrder(equityAddress, 1, PRICE, qty);
    await dex.connect(alice).placeLimitOrder(equityAddress, 0, PRICE, qty);

    const sellOrders = await dex.getSellOrders(equityAddress);
    const buyOrders = await dex.getBuyOrders(equityAddress);

    expect(sellOrders[0].remaining).to.equal(qty);
    expect(sellOrders[0].active).to.equal(true);
    expect(buyOrders[0].remaining).to.equal(qty);
    expect(buyOrders[0].active).to.equal(true);
  });
});
