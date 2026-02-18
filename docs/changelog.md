# Changelog

### v1.0.0 — Project Initialization

* Created repository **tokenised-lse/**
* Defined core folder structure (contracts, backend, frontend, docs)
* Added documentation framework under `/docs`
* Confirmed Ethereum + Hardhat architecture and TToken currency design

### v1.1.0 — Core Contracts Draft

* Added base contracts: `TToken.sol`, `EquityToken.sol`, `EquityTokenFactory.sol`
* Implemented AccessControl and ERC-20 compliance
* Established role permissions and capped supply

### v1.2.0 — Admin Backend Setup

* Created backend server (`server.js`) with Express
* Implemented admin routes for listing, pricing, and dividends
* Integrated Finnhub API connection

### v1.3.0 — Frontend Framework

* Added static HTML/JS frontend
* Implemented wallet connection and trading dashboard layout
* Integrated Chart.js and data refresh logic

### v1.4.0 — Testing & Tooling

* Added Hardhat gas reporter and solidity-coverage
* Wrote unit tests for Stage 1 and Stage 2
* Established per-stage test suite under `/test`

### v1.5.0 — Documentation Finalization

* Added all product and architecture docs
* Expanded UI and trading specifications
* Linked roadmap and glossary
