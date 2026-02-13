const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const PRICE = 10_000n; 
const ONE_SHARE = 10n ** 18n;

function quoteAmount(qty, price) {
  return (qty * price) / 100n;
}


async function deployStage4Fixture() {
  const [admin, alice, bob, carol, dave] = await ethers.getSigners();

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

  return { admin, alice, bob, carol, dave, ttoken, equity, dex };
}

describe("Stage 4 — OrderBookDEX", function () {
  it("processes partial fills on buys", async function () {
    const { admin, alice, bob, ttoken, equity, dex } = await loadFixture(deployStage4Fixture);

    const sellQty = 2n * ONE_SHARE;
    const buyQty = 1n * ONE_SHARE;

    await equity.connect(admin).mint(alice.address, sellQty);
    await ttoken.connect(admin).mint(bob.address, quoteAmount(sellQty, PRICE));

    await equity.connect(alice).approve(await dex.getAddress(), sellQty);
    await ttoken.connect(bob).approve(await dex.getAddress(), ethers.MaxUint256);

    await dex.connect(alice).placeLimitOrder(await equity.getAddress(), 1, PRICE, sellQty); 
    await dex.connect(bob).placeLimitOrder(await equity.getAddress(), 0, PRICE, buyQty); 

    const sellOrders = await dex.getSellOrders(await equity.getAddress());
    const buyOrders = await dex.getBuyOrders(await equity.getAddress());

    expect(sellOrders[0].remaining).to.equal(sellQty - buyQty);
    expect(sellOrders[0].active).to.equal(true);
    expect(buyOrders[0].remaining).to.equal(0);
    expect(buyOrders[0].active).to.equal(false);

    const tradeValue = quoteAmount(buyQty, PRICE);
    expect(await equity.balanceOf(bob.address)).to.equal(buyQty);
    expect(await ttoken.balanceOf(alice.address)).to.equal(tradeValue);
  });

  it("enforces price-time priority on sells", async function () {
    const { admin, alice, bob, carol, dave, ttoken, equity, dex } = await loadFixture(
      deployStage4Fixture
    );

    const sellQty = 1n * ONE_SHARE;
    await equity.connect(admin).mint(alice.address, sellQty);
    await equity.connect(admin).mint(bob.address, sellQty);
    await equity.connect(admin).mint(carol.address, sellQty);
    await ttoken.connect(admin).mint(dave.address, quoteAmount(2n * sellQty, 10_100n));

    await equity.connect(alice).approve(await dex.getAddress(), sellQty);
    await equity.connect(bob).approve(await dex.getAddress(), sellQty);
    await equity.connect(carol).approve(await dex.getAddress(), sellQty);
    await ttoken.connect(dave).approve(await dex.getAddress(), ethers.MaxUint256);

    await dex.connect(alice).placeLimitOrder(await equity.getAddress(), 1, 10_100n, sellQty); 
    await dex.connect(bob).placeLimitOrder(await equity.getAddress(), 1, 10_000n, sellQty); 
    await dex.connect(carol).placeLimitOrder(await equity.getAddress(), 1, 10_000n, sellQty); 

    await dex.connect(dave).placeLimitOrder(await equity.getAddress(), 0, 10_100n, 2n * sellQty);

    const sellOrders = await dex.getSellOrders(await equity.getAddress());
    expect(sellOrders[0].remaining).to.equal(sellQty); 
    expect(sellOrders[1].remaining).to.equal(0);
    expect(sellOrders[1].active).to.equal(false);
    expect(sellOrders[2].remaining).to.equal(0);
    expect(sellOrders[2].active).to.equal(false);

    expect(await equity.balanceOf(dave.address)).to.equal(2n * sellQty);
  });

  it("refunds remaining escrow on cancellation (buy)", async function () {
    const { admin, alice, bob, ttoken, equity, dex } = await loadFixture(deployStage4Fixture);

    const buyQty = 2n * ONE_SHARE;
    const sellQty = ONE_SHARE / 2n;

    const buyQuote = quoteAmount(buyQty, PRICE);
    await ttoken.connect(admin).mint(bob.address, buyQuote);
    await equity.connect(admin).mint(alice.address, sellQty);

    await ttoken.connect(bob).approve(await dex.getAddress(), ethers.MaxUint256);
    await equity.connect(alice).approve(await dex.getAddress(), sellQty);

    await dex.connect(bob).placeLimitOrder(await equity.getAddress(), 0, PRICE, buyQty);
    const takerId = (await dex.nextOrderId()) - 1n;

    await dex.connect(alice).placeLimitOrder(await equity.getAddress(), 1, PRICE, sellQty);

    const remaining = buyQty - sellQty;
    const refundQuote = quoteAmount(remaining, PRICE);
    const balanceBefore = await ttoken.balanceOf(bob.address);

    await dex.connect(bob).cancelOrder(takerId);

    const balanceAfter = await ttoken.balanceOf(bob.address);
    expect(balanceAfter - balanceBefore).to.equal(refundQuote);
  });

  it("conserves balances across a trade", async function () {
    const { admin, alice, bob, ttoken, equity, dex } = await loadFixture(deployStage4Fixture);

    const sellQty = ONE_SHARE;
    const buyQty = ONE_SHARE;

    await equity.connect(admin).mint(alice.address, sellQty);
    await ttoken.connect(admin).mint(bob.address, quoteAmount(buyQty, PRICE));

    await equity.connect(alice).approve(await dex.getAddress(), sellQty);
    await ttoken.connect(bob).approve(await dex.getAddress(), ethers.MaxUint256);

    const totalTTokenBefore =
      (await ttoken.balanceOf(alice.address)) +
      (await ttoken.balanceOf(bob.address)) +
      (await ttoken.balanceOf(await dex.getAddress()));

    const totalEquityBefore =
      (await equity.balanceOf(alice.address)) +
      (await equity.balanceOf(bob.address)) +
      (await equity.balanceOf(await dex.getAddress()));

    await dex.connect(alice).placeLimitOrder(await equity.getAddress(), 1, PRICE, sellQty);
    await dex.connect(bob).placeLimitOrder(await equity.getAddress(), 0, PRICE, buyQty);

    const totalTTokenAfter =
      (await ttoken.balanceOf(alice.address)) +
      (await ttoken.balanceOf(bob.address)) +
      (await ttoken.balanceOf(await dex.getAddress()));

    const totalEquityAfter =
      (await equity.balanceOf(alice.address)) +
      (await equity.balanceOf(bob.address)) +
      (await equity.balanceOf(await dex.getAddress()));

    expect(totalTTokenAfter).to.equal(totalTTokenBefore);
    expect(totalEquityAfter).to.equal(totalEquityBefore);
  });
});
