const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const MAX_SUPPLY = 3n * 10n ** 50n;
const AIRDROP_AMOUNT = ethers.parseEther("1000000");

async function deployTTokenFixture() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const otherUser = signers[1];
  const anotherUser = signers[2];

  const tokenFactory = await ethers.getContractFactory("TToken");
  const token = await tokenFactory.deploy();
  await token.waitForDeployment();

  return { token, admin, otherUser, anotherUser };
}

describe("TToken token", function () {
  describe("Deployment", function () {
    it("assigns deployer as admin and minter", async function () {
      const fixture = await loadFixture(deployTTokenFixture);
      const token = fixture.token;
      const admin = fixture.admin;

      const adminRole = await token.DEFAULT_ADMIN_ROLE();
      const minterRole = await token.MINTER_ROLE();

      const hasAdminRole = await token.hasRole(adminRole, admin.address);
      const hasMinterRole = await token.hasRole(minterRole, admin.address);

      expect(hasAdminRole).to.equal(true);
      expect(hasMinterRole).to.equal(true);
    });

    it("starts with zero supply", async function () {
      const fixture = await loadFixture(deployTTokenFixture);
      const token = fixture.token;

      const totalSupply = await token.totalSupply();
      expect(totalSupply).to.equal(0);
    });
  });

  describe("Minting controls", function () {
    it("allows minter to mint within the cap", async function () {
      const fixture = await loadFixture(deployTTokenFixture);
      const token = fixture.token;
      const admin = fixture.admin;
      const otherUser = fixture.otherUser;

      const amount = ethers.parseEther("2500000");

      await expect(token.connect(admin).mint(otherUser.address, amount))
        .to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, otherUser.address, amount);

      const totalSupply = await token.totalSupply();
      const balance = await token.balanceOf(otherUser.address);

      expect(totalSupply).to.equal(amount);
      expect(balance).to.equal(amount);
    });

    it("reverts when non-minter attempts to mint", async function () {
      const fixture = await loadFixture(deployTTokenFixture);
      const token = fixture.token;
      const otherUser = fixture.otherUser;

      const amount = ethers.parseEther("1");
      const minterRole = await token.MINTER_ROLE();

      await expect(token.connect(otherUser).mint(otherUser.address, amount))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(otherUser.address, minterRole);
    });

    it("enforces the global cap", async function () {
      const fixture = await loadFixture(deployTTokenFixture);
      const token = fixture.token;
      const admin = fixture.admin;

      const nearCap = MAX_SUPPLY - AIRDROP_AMOUNT + 1n;
      await token.connect(admin).mint(admin.address, nearCap);

      await expect(token.connect(admin).mint(admin.address, AIRDROP_AMOUNT))
        .to.be.revertedWith("ttoken: cap exceeded");
    });
  });

  describe("Airdrop", function () {
    it("mints the defined airdrop amount once per wallet", async function () {
      const fixture = await loadFixture(deployTTokenFixture);
      const token = fixture.token;
      const otherUser = fixture.otherUser;

      await expect(token.connect(otherUser).airdropOnce())
        .to.emit(token, "AirdropClaimed")
        .withArgs(otherUser.address, AIRDROP_AMOUNT);

      const balance = await token.balanceOf(otherUser.address);
      const totalSupply = await token.totalSupply();

      expect(balance).to.equal(AIRDROP_AMOUNT);
      expect(totalSupply).to.equal(AIRDROP_AMOUNT);

      await expect(token.connect(otherUser).airdropOnce())
        .to.be.revertedWith("ttoken: airdrop already claimed");
    });

    it("prevents airdrop when cap would be exceeded", async function () {
      const fixture = await loadFixture(deployTTokenFixture);
      const token = fixture.token;
      const admin = fixture.admin;
      const otherUser = fixture.otherUser;

      const nearCap = MAX_SUPPLY - AIRDROP_AMOUNT + 1n;
      await token.connect(admin).mint(admin.address, nearCap);

      await expect(token.connect(otherUser).airdropOnce())
        .to.be.revertedWith("ttoken: cap exceeded");
    });

    it("exposes helper to check claim status", async function () {
      const fixture = await loadFixture(deployTTokenFixture);
      const token = fixture.token;
      const otherUser = fixture.otherUser;

      const before = await token.hasClaimedAirdrop(otherUser.address);
      expect(before).to.equal(false);

      await token.connect(otherUser).airdropOnce();

      const after = await token.hasClaimedAirdrop(otherUser.address);
      expect(after).to.equal(true);
    });
  });

  describe("Standard ERC-20 flows", function () {
    it("supports transfer and allowances", async function () {
      const fixture = await loadFixture(deployTTokenFixture);
      const token = fixture.token;
      const admin = fixture.admin;
      const otherUser = fixture.otherUser;
      const anotherUser = fixture.anotherUser;

      const mintAmount = ethers.parseEther("10");
      await token.connect(admin).mint(admin.address, mintAmount);

      await expect(token.connect(admin).transfer(otherUser.address, mintAmount))
        .to.emit(token, "Transfer")
        .withArgs(admin.address, otherUser.address, mintAmount);

      await expect(token.connect(otherUser).approve(anotherUser.address, mintAmount))
        .to.emit(token, "Approval")
        .withArgs(otherUser.address, anotherUser.address, mintAmount);

      await expect(token.connect(anotherUser).transferFrom(otherUser.address, anotherUser.address, mintAmount))
        .to.emit(token, "Transfer")
        .withArgs(otherUser.address, anotherUser.address, mintAmount);

      const finalBalance = await token.balanceOf(anotherUser.address);
      const allowance = await token.allowance(otherUser.address, anotherUser.address);

      expect(finalBalance).to.equal(mintAmount);
      expect(allowance).to.equal(0);
    });
  });
});
