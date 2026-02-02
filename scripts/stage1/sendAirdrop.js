// scripts/stage1/sendAirdrop.js
// -----------------------------------------------------------------------------
// Claims the one-time TToken airdrop for the wallet whose private key is
// supplied via AIRDROP_PRIVATE_KEY. Pass the deployed token address through
// TTOKEN_ADDRESS. Designed for localhost/Hardhat, but works on any network.
// -----------------------------------------------------------------------------

const { ethers } = require("hardhat");

async function main() {
  const tokenAddress = process.env.TTOKEN_ADDRESS;
  const privateKey = process.env.AIRDROP_PRIVATE_KEY;

  if (!tokenAddress) {
    throw new Error("Missing TTOKEN_ADDRESS env var (token contract address).");
  }

  if (!privateKey) {
    throw new Error("Missing AIRDROP_PRIVATE_KEY env var (wallet private key).");
  }

  const wallet = new ethers.Wallet(privateKey, ethers.provider);
  console.log("Requesting airdrop for:", wallet.address);

  const token = await ethers.getContractAt("TToken", tokenAddress, wallet);
  const claimed = await token.hasClaimedAirdrop(wallet.address);
  if (claimed) {
    console.log("Wallet has already claimed the TToken airdrop.");
    return;
  }

  const tx = await token.airdropOnce();
  console.log("Transaction sent:", tx.hash);
  const receipt = await tx.wait();
  console.log(`Airdrop confirmed in block ${receipt.blockNumber}`);
  const balance = await token.balanceOf(wallet.address);
  console.log(`New TToken balance: ${ethers.formatUnits(balance, 18)} TTK`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
