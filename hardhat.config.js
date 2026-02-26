require("@nomicfoundation/hardhat-toolbox");

const sepoliaRpcUrl = process.env.SEPOLIA_RPC_URL || process.env.RPC_URL || "";
const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || "";
const minterPrivateKey = process.env.MINTER_PRIVATE_KEY || "";

const sepoliaAccounts = [];
if (deployerPrivateKey) {
  sepoliaAccounts.push(deployerPrivateKey);
}
if (minterPrivateKey && minterPrivateKey.toLowerCase() !== deployerPrivateKey.toLowerCase()) {
  sepoliaAccounts.push(minterPrivateKey);
}

const config = {
  solidity: "0.8.20",
  networks: {
    hardhat: {
      chainId: 31338,
    },
    sepolia: {
      url: sepoliaRpcUrl,
      chainId: 11155111,
      accounts: sepoliaAccounts,
    },
  },
  mocha: {
    timeout: 200000,
  },
};

module.exports = config;
