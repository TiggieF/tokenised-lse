const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_SHARE = 10n ** 18n;
const PRICE = 10_000n;
const REWARD = 100n * 10n ** 18n;

function quoteAmount(qtyWei, priceCents) {
  return (qtyWei * priceCents) / 100n;
}

async function deployAwardFixture() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const minter = signers[1];
  const seller = signers[2];
  const buyer = signers[3];
  const other = signers[4];

  const tokenFactory = await ethers.getContractFactory("TToken");
  const ttoken = await tokenFactory.deploy();
  await ttoken.waitForDeployment();

  const registryFactory = await ethers.getContractFactory("ListingsRegistry");
  const registry = await registryFactory.deploy(admin.address);
  await registry.waitForDeployment();

  const equityFactoryFactory = await ethers.getContractFactory("EquityTokenFactory");
  const equityFactory = await equityFactoryFactory.deploy(
    admin.address,
    await registry.getAddress(),
    minter.address
  );
  await equityFactory.waitForDeployment();

  const listingRole = await registry.LISTING_ROLE();
  await registry.connect(admin).grantRole(listingRole, await equityFactory.getAddress());
  await equityFactory.connect(admin).createEquityToken("AAPL", "Apple Inc");
  const equityAddress = await registry.getListing("AAPL");
  const equity = await ethers.getContractAt("EquityToken", equityAddress);

  const priceFeedFactory = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await priceFeedFactory.deploy(admin.address, admin.address);
  await priceFeed.waitForDeployment();

  const dexFactory = await ethers.getContractFactory("OrderBookDEX");
  const dex = await dexFactory.deploy(await ttoken.getAddress(), await registry.getAddress(), await priceFeed.getAddress());
  await dex.waitForDeployment();

  const awardFactory = await ethers.getContractFactory("Award");
  const award = await awardFactory.deploy(await ttoken.getAddress(), admin.address, await dex.getAddress());
  await award.waitForDeployment();

  await dex.connect(admin).setAward(await award.getAddress());
  const minterRole = await ttoken.MINTER_ROLE();
  await ttoken.connect(admin).grantRole(minterRole, await award.getAddress());

  await equity.connect(minter).mint(seller.address, 5n * ONE_SHARE);
  await ttoken.connect(admin).mint(buyer.address, quoteAmount(5n * ONE_SHARE, PRICE));
  await ttoken.connect(admin).mint(other.address, quoteAmount(5n * ONE_SHARE, PRICE));

  await equity.connect(seller).approve(await dex.getAddress(), ethers.MaxUint256);
  await ttoken.connect(buyer).approve(await dex.getAddress(), ethers.MaxUint256);
  await ttoken.connect(other).approve(await dex.getAddress(), ethers.MaxUint256);

  return { admin, minter, seller, buyer, other, ttoken, equity, dex, award, equityAddress };
}

describe("Award", function () {
  it("uses 60 second epochs and fixed 100 ttoken reward", async function () {
    const { award } = await loadFixture(deployAwardFixture);
    expect(await award.EPOCH_DURATION()).to.equal(60n);
    expect(await award.REWARD_AMOUNT()).to.equal(REWARD);
  });

  it("counts traded quantity for both sides and allows tie winners to self claim", async function () {
    const { seller, buyer, ttoken, dex, award, equityAddress } = await loadFixture(deployAwardFixture);

    const epochDuration = Number(await award.EPOCH_DURATION());
    const now = await time.latest();
    const remainder = now % epochDuration;
    if (remainder !== 1) {
      await time.increase((epochDuration - remainder + 1) % epochDuration);
    }

    const epochId = await award.currentEpoch();

    await dex.connect(seller).placeLimitOrder(equityAddress, 1, PRICE, ONE_SHARE);
    await dex.connect(buyer).placeLimitOrder(equityAddress, 0, PRICE, ONE_SHARE);

    const sellerQty = await award.qtyByEpochByTrader(epochId, seller.address);
    const buyerQty = await award.qtyByEpochByTrader(epochId, buyer.address);
    const maxQty = await award.maxQtyByEpoch(epochId);

    expect(sellerQty).to.equal(ONE_SHARE);
    expect(buyerQty).to.equal(ONE_SHARE);
    expect(maxQty).to.equal(ONE_SHARE);

    await time.increase(epochDuration + 1);

    expect(await award.isWinner(epochId, seller.address)).to.equal(true);
    expect(await award.isWinner(epochId, buyer.address)).to.equal(true);

    await award.connect(seller).claimAward(epochId);
    await award.connect(buyer).claimAward(epochId);

    expect(await ttoken.balanceOf(seller.address)).to.equal(quoteAmount(ONE_SHARE, PRICE) + REWARD);
    expect(await ttoken.balanceOf(buyer.address)).to.equal(quoteAmount(5n * ONE_SHARE, PRICE) - quoteAmount(ONE_SHARE, PRICE) + REWARD);

    await expect(award.connect(seller).claimAward(epochId)).to.be.revertedWith("award: already claimed");
  });

  it("rejects non winners and non dex reporters", async function () {
    const { admin, seller, buyer, other, award } = await loadFixture(deployAwardFixture);

    await award.connect(admin).setDex(admin.address);
    const epochDuration = Number(await award.EPOCH_DURATION());

    const epochId = await award.currentEpoch();
    await award.connect(admin).recordTradeQty(seller.address, 2n * ONE_SHARE);
    await award.connect(admin).recordTradeQty(buyer.address, ONE_SHARE);
    await time.increase(epochDuration + 1);

    expect(await award.isWinner(epochId, seller.address)).to.equal(true);
    expect(await award.isWinner(epochId, buyer.address)).to.equal(false);

    await expect(award.connect(buyer).claimAward(epochId)).to.be.revertedWith("award: not winner");
    await expect(award.connect(other).recordTradeQty(other.address, ONE_SHARE)).to.be.revertedWith("award: only dex");
  });
});
