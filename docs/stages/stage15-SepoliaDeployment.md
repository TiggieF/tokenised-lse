# Stage 15 — Sepolia Deployment and Hosting

## Objective

Execute testnet deployment and hosting rollout after feature completion and verification.

---

## Scope

- deploy contract suite to Sepolia
- verify contracts on Etherscan
- run backend against Sepolia with JSON indexer storage
- deploy frontend and connect to hosted backend
- execute smoke tests and publish release artifacts

---

## Primary Runbook

Use:

- `docs/deployment-sepolia.md`

This file is the canonical step-by-step deployment plan, including:

- environment setup
- deployment order
- role wiring
- hosting checklist
- rollback and recovery
- evidence collection for report

---

## Acceptance Criteria

1. Sepolia addresses are deployed, verified, and saved.
2. Backend and frontend are live and connected to Sepolia.
3. End-to-end smoke tests pass and are documented.
4. Release artifacts are committed and tagged.

