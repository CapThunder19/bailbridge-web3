# BailBridge — DoraHacks submission

**BLI Legal Tech Hackathon 2 · Ethereum / EVM**

## One-liner

BailBridge flags undertrial cases that need Section 479 BNSS review, makes every party's duty — including the jail superintendent's — visible on a shared append-only log, and lets anyone verify a bail order is genuine and still active.

## Problem

About three in four people in Indian prisons are undertrials (NCRB, *Prison Statistics India 2022*: 4,34,302 of 5,73,220 prisoners). Section 479 of the Bharatiya Nagarik Suraksha Sanhita, 2023 (formerly s.436A CrPC) provides for release on bail once an undertrial has been detained for one-half of the maximum sentence — one-third for a first-time offender — and requires the jail superintendent to apply to the court when that point is reached.

Making this work depends on legal-aid lawyers, NGOs, prisons and courts that keep separate records and do not fully trust each other's. It is hard to tell which cases have crossed the threshold, whether each party has acted, and whether an order in hand is genuine and current.

## Solution

A legal-aid coordination and audit tool for a lawyer or NGO caseworker handling many cases:

1. **Review** — a fully unit-tested s.479 screening engine computes the threshold (one-half or one-third, excluding accused-caused delay), routes multiple-pending-case matters to specialist review under s.479(2), excludes death/life offences, and never says anyone "must be released". Result: *"Threshold reached N days ago — s.479(3) application and legal review required."*
2. **File** — the prison superintendent records the s.479(3) application; the lawyer reviews a DRAFT bail application and registers the exact PDF's hash with a wallet signature.
3. **Verify** — a Demo court issuer attests the order (structured-JSON hash and PDF hash kept separate; the PDF carries a QR to the public verify page). Anyone can drop the PDF on `/verify`: hashed locally, never uploaded; altered files fail; revoked orders show REVOKED.
4. **Acknowledge** — the prison acknowledges receipt of the active order and then release.

A dashboard groups cases by who must act next, led by *"Threshold reached, superintendent application not recorded (N days)"*. A public `/release-clock` shows anonymised progress from contract events.

## Why Web3

The parties do not share a database or fully trust each other. A shared append-only log that none of them can quietly edit proves **who did what, and when**: each milestone is signed by a wallet holding a specific role, documents are checked by hash against the registry by anyone, and salted commitments let a party prove its off-chain record has not changed since anchoring. Nothing personal goes on-chain. The README states plainly what the chain proves and what still depends on trusted actors (the facts entered, who holds which role, the lawyer's review, the court itself).

## Implemented vs simulated

| Implemented and tested | Simulated / prototype |
| --- | --- |
| `BailRegistry` contract (AccessControl, custom errors, events, duplicate prevention, linkage validation, revocation, supersede; 26 tests) | Institutional identities — "Demo court issuer", "Demo district prison" are wallets, not real institutions |
| s.479 screening engine with 20-variant reviewed BNS offence dataset (36 engine tests) | All people and cases are synthetic |
| Express API with password login, httpOnly sessions, server-side role checks, wallet-signer checks on every confirmation | Wallet ↔ account binding is a configured mapping (no signed challenge yet) |
| Salted, versioned commitments; anchoring and threshold flagging by a registrar wallet | Registrar is a single server wallet |
| DRAFT application PDF and order PDF with QR; browser-side hashing; server re-verification against the confirmed tx | Order text is written by the Demo issuer in the app, not issued by a court |
| Public `/verify` and `/release-clock` reading the contract via public RPC | No integration with e-Courts, ICJS or FASTER |
| Order supersession (P1): append-only old → new link, fresh prison receipt required, shown on `/verify` |
| Seed script: 5 demo cases + a revoked order, DB and chain in agreement | Gemini advisory summary is optional; a deterministic summary is used without a key |
| Off-chain mode (no fake tx hashes) | Demo role wallets on Sepolia are test wallets, not institutions |
| End-to-end tests on a real Hardhat node; live-stack browser wallet tests (119 tests in total) | UI not click-tested with MetaMask in an automated browser |

## Tech stack

- **Contracts:** Solidity 0.8.24, OpenZeppelin v5, Hardhat 2, ethers v6
- **Server:** Node 20+, Express, TypeScript, SQLite (better-sqlite3), Zod, ethers v6, pdf-lib, qrcode, optional Gemini
- **Web:** Vite, React, TypeScript, Tailwind, ethers v6 + MetaMask (no wagmi/RainbowKit)
- **Tests:** Hardhat (contracts), Vitest (screening, hashing, API, end-to-end, browser modules)
- **Chain:** Hardhat local for development; deployed on Sepolia for the public demo

## Legal-tech relevance

BailBridge targets a specific, statutory gap: the s.479(3) duty of the jail superintendent and the s.479 threshold itself. Possible value, if piloted with legal-aid organisations and the relevant authorities (not demonstrated here):

- surfacing cases past the threshold for legal-aid review, with the calculation and caveats laid out for a lawyer to check;
- making a missing superintendent application visible instead of silent;
- giving prisons and families a simple way to check that a bail order is the registered, active one;
- an anonymised public view of how long each step takes.

It is designed to complement official systems such as the Supreme Court's FASTER, not replace them.

## Roadmap

- Signed-challenge wallet binding
- Hindi / English interface
- Zero-knowledge proofs of threshold eligibility
- Community release-support escrow for bond amounts
- e-Courts / ICJS / FASTER integration — only with the relevant authorities

## Links

- Repository: `<add repository URL>`
- Demo video (3 min): `<add video URL>`
- Live demo: `<add URL if hosted>`
- Contract on Sepolia: [`0x21f3eefB7F513c68C8677cD4D153126Ad1ce7591`](https://sepolia.etherscan.io/address/0x21f3eefB7F513c68C8677cD4D153126Ad1ce7591) (deployment block 12033500)
