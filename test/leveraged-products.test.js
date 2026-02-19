const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE = 10n ** 18n;

async function deployLeveragedProductsFixture() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const alice = signers[1];

  const ttokenFactory = await ethers.getContractFactory("TToken");
  const ttoken = await ttokenFactory.deploy();
  await ttoken.waitForDeployment();

  const registryFactory = await ethers.getContractFactory("ListingsRegistry");
  const registry = await registryFactory.deploy(admin.address);
  await registry.waitForDeployment();

  const equityFactory = await ethers.getContractFactory("EquityToken");
  const equity = await equityFactory.deploy("Tesla Inc", "TSLA", admin.address, admin.address);
  await equity.waitForDeployment();
  await registry.connect(admin).registerListing("TSLA", "Tesla Inc", await equity.getAddress());

  const priceFeedFactory = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await priceFeedFactory.deploy(admin.address, admin.address);
  await priceFeed.waitForDeployment();
  await priceFeed.connect(admin).setPrice("TSLA", 10000);

  const leveragedFactoryFactory = await ethers.getContractFactory("LeveragedTokenFactory");
  const leveragedFactory = await leveragedFactoryFactory.deploy(admin.address, await registry.getAddress());
  await leveragedFactory.waitForDeployment();

  const leveragedRouterFactory = await ethers.getContractFactory("LeveragedProductRouter");
  const leveragedRouter = await leveragedRouterFactory.deploy(
    admin.address,
    await ttoken.getAddress(),
    await priceFeed.getAddress(),
    await leveragedFactory.getAddress()
  );
  await leveragedRouter.waitForDeployment();
  await leveragedFactory.connect(admin).setRouter(await leveragedRouter.getAddress());

  const minterRole = await ttoken.MINTER_ROLE();
  await ttoken.connect(admin).grantRole(minterRole, admin.address);
  await ttoken.connect(admin).mint(alice.address, 20_000n * ONE);

  return {
    admin,
    alice,
    ttoken,
    registry,
    equity,
    priceFeed,
    leveragedFactory,
    leveragedRouter,
  };
}

describe("Leveraged Products", function () {
  it("creates a 5x long product for listed base symbol", async function () {
    const fixture = await loadFixture(deployLeveragedProductsFixture);
    const admin = fixture.admin;
    const leveragedFactory = fixture.leveragedFactory;

    await leveragedFactory.connect(admin).createLongProduct("TSLA", 5);

    const tokenAddress = await leveragedFactory.getProduct("TSLA", 5);
    expect(tokenAddress).to.not.equal(ethers.ZeroAddress);

    const bySymbol = await leveragedFactory.getProductBySymbol("TSLA5L");
    expect(bySymbol).to.equal(tokenAddress);
  });

  it("rejects unsupported leverage", async function () {
    const fixture = await loadFixture(deployLeveragedProductsFixture);
    const admin = fixture.admin;
    const leveragedFactory = fixture.leveragedFactory;

    await expect(
      leveragedFactory.connect(admin).createLongProduct("TSLA", 4)
    ).to.be.revertedWith("leveragedfactory: leverage not allowed");
  });

  it("mints and fully unwinds with burn to zero user balance", async function () {
    const fixture = await loadFixture(deployLeveragedProductsFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const ttoken = fixture.ttoken;
    const leveragedFactory = fixture.leveragedFactory;
    const leveragedRouter = fixture.leveragedRouter;

    await leveragedFactory.connect(admin).createLongProduct("TSLA", 5);
    const productTokenAddress = await leveragedFactory.getProductBySymbol("TSLA5L");
    const leveragedToken = await ethers.getContractAt("LeveragedToken", productTokenAddress);

    const ttokenInWei = 1_000n * ONE;
    await ttoken.connect(alice).approve(await leveragedRouter.getAddress(), ttokenInWei);
    await leveragedRouter.connect(alice).mintLong(productTokenAddress, ttokenInWei, 0);

    const productBalance = await leveragedToken.balanceOf(alice.address);
    expect(productBalance).to.equal(5_000n * ONE);

    const ttokenBeforeUnwind = await ttoken.balanceOf(alice.address);
    await leveragedRouter.connect(alice).unwindLong(productTokenAddress, productBalance, 0);
    const ttokenAfterUnwind = await ttoken.balanceOf(alice.address);
    const finalProductBalance = await leveragedToken.balanceOf(alice.address);

    expect(finalProductBalance).to.equal(0n);
    expect(ttokenAfterUnwind).to.be.greaterThan(ttokenBeforeUnwind);
  });
});
