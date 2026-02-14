const { ethers } = require("ethers");

const wallet = ethers.Wallet.createRandom();
const privateKey = wallet.privateKey;
const address = wallet.address;

console.log("Private Key:", privateKey);
console.log("Address:", address);
