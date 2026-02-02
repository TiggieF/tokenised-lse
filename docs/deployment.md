# Deployment Manual – Tokenised LSE DEX

This document explains, in one clear process, how to **set up, deploy, and run** the entire Tokenised LSE DEX project on your local system using Hardhat, Conda, and Coinbase Wallet.

---

## 1. Environment Setup

### 1.1 Install Conda
If you don’t already have Conda:
- Download and install **Miniconda** or **Anaconda** from  
  [https://docs.conda.io/en/latest/miniconda.html](https://docs.conda.io/en/latest/miniconda.html)
- After installation, open a terminal or “Anaconda Prompt”.

### 1.2 Create and activate the project environment
```bash
conda create -n tokenised-lse python=3.10 nodejs=18
conda activate tokenised-lse
1.3 Verify installation
bash
Copy code
node -v
npm -v
npx hardhat --version
If these return versions successfully, your environment is ready.

2. Clone and Configure the Repository
2.1 Clone the repository
bash
Copy code
git clone <your-github-repo-url>
cd tokenised-lse
npm install
2.2 Create the .env file
In the project root, create a new file called .env and add the following lines:

ini
Copy code
ADMIN_PRIVATE_KEY=0x550795f44ce5492cd1943f3668edb2699b7a55ea44712e9fe81706e648b05360
RPC_URL=http://127.0.0.1:8545
FINNHUB_API_KEY=d4699t1r01qj716fvnmgd4699t1r01qj716fvnn0
⚠️ Important:

The ADMIN_PRIVATE_KEY above is your admin wallet key (used for stock listings, price updates, and dividends).

Never publish this key publicly outside your local setup.

The RPC_URL is set to Hardhat’s local network (no testnet ETH needed).

The FINNHUB_API_KEY is your working stock data key.

3. Start the Local Blockchain
Start your Hardhat network (this runs a full EVM node locally):

bash
Copy code
npx hardhat node
This will print 20 pre-funded accounts with private keys.
Your Coinbase Wallet can connect to http://127.0.0.1:8545 if configured as a custom RPC network.

4. Deploy Smart Contracts
With the network running, open a new terminal tab in the same folder and run:

bash
Copy code
npx hardhat run scripts/deploy_all.js --network localhost
This script deploys, in order:

TToken.sol

EquityTokenFactory.sol

ListingsRegistry.sol

PriceFeed.sol

OrderBookDEX.sol

Dividends.sol

FeePool.sol

PortfolioAggregator.sol

4.1 Expected output
You should see console logs similar to:

vbnet
Copy code
Deploying TToken...
TToken deployed to: 0x1234...
EquityTokenFactory deployed to: 0xabcd...
Deployment complete ✅
Copy these contract addresses — the frontend will read them from the backend or JSON output.

5. Launch Backend Server
bash
Copy code
cd backend
node server.js
The backend:

Connects to your local Hardhat blockchain (RPC_URL)

Uses ADMIN_PRIVATE_KEY for admin actions (listings, dividends)

Fetches live stock data via your Finnhub key (d4699t1r01qj716fvnmgd4699t1r01qj716fvnn0)

Provides REST routes for frontend (price, holders, profile)

6. Launch Frontend
bash
Copy code
cd frontend
npm run dev
Then open your browser at:

arduino
Copy code
http://localhost:3000
You should see the Tokenised LSE dashboard.

7. Connect Wallet and Verify Functionality
7.1 Connect Wallet
Open Coinbase Wallet (or MetaMask)

Add a Custom RPC network:

yaml
Copy code
Network Name: Hardhat Local
RPC URL: http://127.0.0.1:8545
Chain ID: 31337
Currency Symbol: ETH
Connect to the site via WalletConnect or browser extension.

7.2 Verify TToken Airdrop
On first connect, your wallet receives 1,000,000 TToken automatically from the backend.

7.3 Try a Trade
Admin lists the top 10 companies (through admin dashboard or backend API).

You can place buy/sell limit orders in the Market section.

Partial fills will remain active until fully executed or cancelled.

8. Testing and Validation
8.1 Automated Tests
bash
Copy code
npx hardhat test
8.2 Manual Verification
Check:

Each listed stock token appears under “Market”.

PriceFeed updates show “Fresh” (timestamp < 60s).

FeePool rewards 3 TToken every 3 minutes to top trader.

Dividend declaration and claim function as expected.

9. Shutdown & Cleanup
9.1 Stop services
Use Ctrl + C in each terminal window (frontend, backend, node).

9.2 Deactivate environment
bash
Copy code
conda deactivate
9.3 Optional environment removal
bash
Copy code
conda remove --name tokenised-lse --all
10. Deployment Summary
Component	Command	Description
Hardhat node	npx hardhat node	Starts local blockchain
Contracts	npx hardhat run scripts/deploy_all.js --network localhost	Deploys all contracts
Backend	node server.js	API & admin logic
Frontend	npm run dev	User interface
Wallet	Coinbase / MetaMask	Connect to local node
API Key	d4699t1r01qj716fvnmgd4699t1r01qj716fvnn0	Finnhub market data