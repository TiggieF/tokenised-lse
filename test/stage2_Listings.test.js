const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

async function deployStage2Fixture() {
  const [admin, otherUser, minter] = await ethers.getSigners();

  const ListingsRegistry = await ethers.getContractFactory("ListingsRegistry");
  const registry = await ListingsRegistry.deploy(admin.address);
  await registry.waitForDeployment();

  const EquityTokenFactory = await ethers.getContractFactory("EquityTokenFactory");
  const factory = await EquityTokenFactory.deploy(
    admin.address,
    await registry.getAddress(),
    minter.address
  );
  await factory.waitForDeployment();

  const listingRole = await registry.LISTING_ROLE();
  await registry.connect(admin).grantRole(listingRole, await factory.getAddress());

  return { admin, otherUser, minter, registry, factory };
}

describe("Stage 2 — Listings & Factory", function () {
  it("deploys and registers a new equity token per symbol", async function () {
    const { admin, minter, registry, factory } = await loadFixture(deployStage2Fixture);
    const symbol = "ACME";
    const name = "Acme Industries";

    const tx = await factory.connect(admin).createEquityToken(symbol, name);
    await tx.wait();

    const tokenAddress = await registry.getListing(symbol);
    expect(tokenAddress).to.not.equal(ethers.ZeroAddress);

    await expect(tx)
      .to.emit(registry, "StockListed")
      .withArgs(symbol, tokenAddress);

    const token = await ethers.getContractAt("EquityToken", tokenAddress);
    expect(await token.name()).to.equal(name);
    expect(await token.symbol()).to.equal(symbol);

    const adminRole = await token.DEFAULT_ADMIN_ROLE();
    const minterRole = await token.MINTER_ROLE();

    expect(await token.hasRole(adminRole, admin.address)).to.equal(true);
    expect(await token.hasRole(minterRole, minter.address)).to.equal(true);
  });

  it("prevents duplicate symbols", async function () {
    const { admin, factory } = await loadFixture(deployStage2Fixture);
    const symbol = "ACME";
    const name = "Acme Industries";

    await factory.connect(admin).createEquityToken(symbol, name);

    await expect(factory.connect(admin).createEquityToken(symbol, "Other Name"))
      .to.be.revertedWith("ListingsRegistry: symbol already listed");
  });

  it("registry resolves addresses", async function () {
    const { admin, registry, factory } = await loadFixture(deployStage2Fixture);
    const symbol = "LSE";
    const name = "London Stock Exchange";

    await factory.connect(admin).createEquityToken(symbol, name);
    const tokenAddress = await registry.getListing(symbol);

    expect(tokenAddress).to.not.equal(ethers.ZeroAddress);
  });

  it("returns full listing info and listed state", async function () {
    const { admin, registry, factory } = await loadFixture(deployStage2Fixture);
    const symbol = "LSE";
    const name = "London Stock Exchange";

    await factory.connect(admin).createEquityToken(symbol, name);

    const [tokenAddress, storedSymbol, storedName] = await registry.getListingFull(symbol);
    expect(tokenAddress).to.not.equal(ethers.ZeroAddress);
    expect(storedSymbol).to.equal(symbol);
    expect(storedName).to.equal(name);
    expect(await registry.isListed(symbol)).to.equal(true);

    const [missingToken, missingSymbol, missingName] = await registry.getListingFull("MISSING1");
    expect(missingToken).to.equal(ethers.ZeroAddress);
    expect(missingSymbol).to.equal("");
    expect(missingName).to.equal("");
    expect(await registry.isListed("MISSING1")).to.equal(false);
  });

  it("enforces access control", async function () {
    const { admin, otherUser, registry, factory } = await loadFixture(deployStage2Fixture);

    await expect(factory.connect(otherUser).createEquityToken("ACME", "Acme"))
      .to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount")
      .withArgs(otherUser.address, await factory.DEFAULT_ADMIN_ROLE());

    await expect(
      registry.connect(otherUser).registerListing("SYM", "Name", admin.address)
    )
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
      .withArgs(otherUser.address, await registry.LISTING_ROLE());
  });

  it("rejects symbols with lowercase letters", async function () {
    const { admin, factory } = await loadFixture(deployStage2Fixture);

    await expect(factory.connect(admin).createEquityToken("Acme", "Acme Corp"))
      .to.be.revertedWith("ListingsRegistry: symbol must be A-Z or 0-9");
  });

  it("allows digits in symbols", async function () {
    const { admin, registry, factory } = await loadFixture(deployStage2Fixture);

    await factory.connect(admin).createEquityToken("ACME1", "Acme One");
    const tokenAddress = await registry.getListing("ACME1");
    expect(tokenAddress).to.not.equal(ethers.ZeroAddress);
  });
});
