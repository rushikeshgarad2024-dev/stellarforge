# StellarForge

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Contracts CI](https://github.com/0xLizTech/stellarforge/actions/workflows/contracts-ci.yml/badge.svg)](https://github.com/0xLizTech/stellarforge/actions/workflows/contracts-ci.yml)
[![SDK CI](https://github.com/0xLizTech/stellarforge/actions/workflows/sdk-ci.yml/badge.svg)](https://github.com/0xLizTech/stellarforge/actions/workflows/sdk-ci.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> **Institutional-grade Real World Asset tokenization on Stellar/Soroban.**
> Mint, transfer, fraction, and govern tokenized real-world assets — with built-in compliance, yield tranching, and cross-chain interoperability.

---

## What is StellarForge?

StellarForge is an open-source, permissionless protocol for **Real World Asset (RWA) tokenization** built on the [Stellar](https://stellar.org) blockchain and [Soroban](https://soroban.stellar.org) smart contract platform. It provides the primitive contracts, TypeScript SDK, and composable modules that institutions, fintech builders, and individual issuers need to bring real-world value on-chain — legally, securely, and at scale.

### Why Stellar?

| Concern | Stellar's answer |
|---|---|
| Transaction cost | ~$0.00001 per operation |
| Settlement speed | 3–5 second finality |
| Compliance tooling | Native DEX, federation, memo fields |
| Environmental footprint | Proof-of-Agreement; minimal energy use |
| Ecosystem | 10+ year track record, regulated corridors |

---

## Protocol Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         StellarForge Protocol                         │
├───────────────┬──────────────┬───────────────┬───────────────────────┤
│  RWA Asset    │  Registry    │  Compliance   │  Governance           │
│  Contract     │  Contract    │  Engine       │  Contract             │
│               │              │               │                       │
│  • Mint/Burn  │  • Asset     │  • KYC/AML    │  • Proposals          │
│  • Transfer   │    Registry  │    records    │  • Voting             │
│  • Allowances │  • Lookup    │  • Jurisdiction│  • Execution hooks   │
│  • Metadata   │  • Active    │  • Expiry     │  (Phase 3+)           │
│  • Pause/     │    flags     │    management │                       │
│    Unpause    │              │               │                       │
└───────────────┴──────────────┴───────────────┴───────────────────────┘
         │                                               │
         │              TypeScript SDK                   │
         └───────────────────────────────────────────────┘
                  @stellarforge-protocol/sdk  ·  npm package
```

**Planned modules** (see [ROADMAP.md](ROADMAP.md)):
- Fractionalization vault
- Yield tranching engine
- Decentralized insurance pool
- Privacy layer (ZK proofs)
- Cross-chain bridge (IBC / LayerZero)
- Governance token + DAO

---

## Repository Structure

```
stellarforge/
├── contracts/
│   ├── common/             # Shared storage/TTL policy (library, not deployed)
│   ├── rwa-asset/          # Core tokenization contract (Soroban/Rust)
│   ├── registry/           # Global asset registry
│   ├── compliance/         # KYC/AML compliance engine
│   ├── governance/         # On-chain governance
│   └── oracle-adapter/     # SEP-40 NAV price feed (Phase 2)
├── sdk/
│   ├── src/
│   │   ├── client.ts       # Contract interaction clients
│   │   ├── types.ts        # Shared TypeScript types
│   │   └── utils.ts        # Address, amount, hashing utilities
│   └── tests/
├── docs/
│   ├── prd/                # Product Requirements Document
│   └── architecture/       # Architecture decision records (ADRs)
├── scripts/                # Deployment & maintenance scripts
├── .github/workflows/      # CI pipelines
├── Cargo.toml              # Workspace manifest
├── Makefile                # Developer shortcuts
├── ROADMAP.md
└── CONTRIBUTING.md
```

---

## Quick Start

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust | ≥ 1.81 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| wasm32 target | any | `rustup target add wasm32v1-none` |
| stellar-cli | ≥ 27.0 | `cargo install --locked stellar-cli` |
| Node.js | ≥ 22 | [nodejs.org](https://nodejs.org) |
| npm | ≥ 10 | bundled with Node |

### 1. Clone the repository

```bash
git clone https://github.com/0xLizTech/stellarforge.git
cd stellarforge
```

### 2. Build all contracts

```bash
make build
```

Compiled `.wasm` files appear in `target/wasm32v1-none/release/`.

### 3. Run contract tests

```bash
make test
```

### 4. Build & test the TypeScript SDK

```bash
make sdk-build
make sdk-test
```

### 5. Deploy to testnet

```bash
# Fund a test account first
stellar keys generate mykey --network testnet
stellar keys fund mykey --network testnet

# Deploy
STELLAR_ACCOUNT=mykey make deploy-testnet
```

### 6. Use the SDK

```typescript
import { RwaAssetClient, toStroops, TESTNET_CONFIG } from "@stellarforge-protocol/sdk";

const client = new RwaAssetClient({
  ...TESTNET_CONFIG,
  contracts: {
    rwaAsset: "C...", // your deployed contract ID
  },
});

const supply = await client.totalSupply();
const meta   = await client.metadata();
console.log(`${meta.symbol} — total supply: ${supply}`);
```

Writes come in two forms. `build*Tx` returns a prepared but unsigned transaction
for a wallet to sign, so no secret ever reaches the SDK:

```typescript
const tx = await client.buildTransferTx(from, to, toStroops("100", meta.decimals));
const signedXdr = await freighter.signTransaction(tx.toXdr(), { networkPassphrase });
```

The bare method signs with `signerSecret` and submits, for server-side use:

```typescript
const client = new RwaAssetClient({ ...TESTNET_CONFIG, contracts, signerSecret });
const { hash, ledger } = await client.transfer(from, to, toStroops("100", meta.decimals));
```

A bare write waits for the transaction to settle, for up to its 180-second
validity window plus 30 seconds. If it has not settled by then, the error type
says whether retrying is safe:

- `TransactionExpiredError`: the window closed without the transaction being
  included. It can never land, so rebuild and resubmit.
- `TransactionOutcomeUnknownError`: it may still land. Look up `err.hash`
  before retrying, or the write may execute twice.

Both assume the authorizing address also sources the transaction, so its
signature satisfies the contract's `require_auth`. For a fee payer separate
from the authorizer, the SDK's sponsored writes build the transaction and the
authorization entries to sign; the SDK README shows the flow.

---

## Contract Reference (Phase 1)

### RwaAsset

| Function | Auth | Description |
|---|---|---|
| `__constructor(admin, metadata)` | admin | Runs at deploy; not callable afterwards |
| `mint(issuer, to, amount)` | issuer | Create new tokens |
| `burn(from, amount)` | from | Destroy tokens |
| `burn_from(spender, from, amount)` | spender | Destroy tokens, spending an allowance |
| `transfer(from, to, amount)` | from | Move tokens; `to` may be a muxed address |
| `approve(owner, spender, amount, live_until_ledger)` | owner | Set an allowance that reads as zero after `live_until_ledger` |
| `transfer_from(spender, from, to, amount)` | spender | Spend allowance |
| `set_issuer(issuer, approved)` | admin | Grant/revoke issuer role |
| `set_paused(paused)` | admin | Emergency circuit breaker |
| `update_metadata(metadata)` | admin | Update asset metadata; `decimals` is fixed, and a cap can only be tightened: never raised, removed or set below supply |
| `transfer_admin(new_admin)` | admin + new_admin | Transfer admin role |
| `set_compliance(compliance, min_level)` | admin | Point at a compliance contract, or `None` to disable screening |
| `balance(owner)` | — | Query balance |
| `allowance(owner, spender)` | — | Query allowance |
| `total_supply()` | — | Query supply |
| `metadata()` | — | Query metadata |
| `decimals()`, `name()`, `symbol()` | — | SEP-41 metadata getters |
| `admin()` | — | Query admin address |
| `is_issuer(address)` | — | Query issuer status |
| `paused()` | — | Query pause state |
| `compliance_contract()` | — | Query the configured compliance contract |
| `min_compliance_level()` | — | Query the required verification level |

**Transfer screening.** When `set_compliance` names a contract, `mint`,
`transfer` and `transfer_from` require every counterparty to hold a valid
verification record at or above `min_level` (0 none, 1 basic, 2 full,
3 accredited). `burn` and `burn_from` are deliberately exempt, so a holder whose verification
has lapsed can still exit their position. Screening is skipped entirely while
no compliance contract is configured.

### Compliance

| Function | Auth | Description |
|---|---|---|
| `set_kyc(subject, record)` | admin | Set KYC record; requires level 0–3, an expiry not yet past, and a two-letter ISO 3166-1 jurisdiction |
| `revoke_kyc(subject)` | admin | Remove KYC record |
| `transfer_admin(new_admin)` | admin + new_admin | Transfer admin role |
| `is_compliant(subject, min_level)` | — | Check compliance; pure query, no ledger write |
| `screen(subject, min_level)` | — | As above, but refreshes the record's TTL; bound by `RwaAsset` |
| `get_kyc(subject)` | — | Read KYC record |
| `admin()` | — | Query admin address |

A compliance contract plugged into `RwaAsset` must implement `screen`, not just
`is_compliant`. The two return identical answers and differ only in that
`screen` extends the lifetime of the record it consults — a KYC record is
written once and thereafter only read, and only the compliance contract can
extend its own entries. See [ADR-001](docs/architecture/001-storage-key-design.md).

### Registry

| Function | Auth | Description |
|---|---|---|
| `register(entry)` | admin | Register a new asset contract, or update a registered one |
| `set_active(contract, active)` | admin | Activate/deactivate asset |
| `get_asset(contract)` | — | Look up asset entry |
| `transfer_admin(new_admin)` | admin + new_admin | Transfer admin role |
| `list_assets(start, limit)` | — | Page through registered contracts in registration order, at most 100 per call, each exactly once |
| `asset_count()` | — | Count registered contracts |
| `admin()` | — | Query admin address |

**An entry is an assertion, not a verification.** `register` does not check
that the address is a deployed `rwa-asset` or that `asset_class` matches its
metadata, and nothing in the protocol reads `active`. Treat the registry as
the admin's directory, not as proof that an asset is genuine or current.

### Governance

| Function | Auth | Description |
|---|---|---|
| `propose(proposer, title, hash, period)` | proposer | Create proposal; the period must be 1–90 days in ledgers and the title at most 256 bytes |
| `vote(voter, id, support, weight)` | voter | Cast vote |
| `finalize(id)` | — | Tally and finalize; a tie is rejected |
| `transfer_admin(new_admin)` | admin + new_admin | Transfer admin role; no other admin powers in Phase 1 |
| `get_proposal(id)` | — | Read proposal |
| `has_voted(id, voter)` | — | Whether an address has voted on a proposal |
| `proposal_count()` | — | Count proposals |
| `admin()` | — | Query admin address |

> **Phase 1 caveat.** `vote` accepts a caller-supplied `weight` and does not
> check it against any token balance or voting-power source, and `finalize`
> applies no quorum. Governance is a skeleton until the `SFORGE` token and
> execution hooks land in Phase 3 — do not treat a passed proposal as a
> trustworthy signal before then.

### Oracle Adapter (Phase 2)

A SEP-40 price feed for net asset values, which market oracles don't publish.
The read functions are SEP-40's, so anything that reads a SEP-40 oracle reads
this one. Prices are scaled by `10^decimals()` and timestamped in Unix seconds,
rounded down to `resolution()`. See [ADR-005](docs/architecture/005-oracle-adapter.md).

| Function | Auth | Description |
|---|---|---|
| `report(reporter, asset, price, timestamp)` | reporter | Record a price; the reporter must be authorized for the asset, the tick must be later than the latest, and the move must be within the asset's limit |
| `override_price(asset, price, timestamp)` | admin | Record a price beyond the deviation limit; every other rule still applies |
| `add_asset(asset, max_deviation_bps)` | admin | List an asset, up to 100 |
| `set_max_deviation(asset, max_deviation_bps)` | admin | Change an asset's deviation limit |
| `set_reporter(asset, reporter, allowed)` | admin | Grant or revoke a reporter for one asset |
| `transfer_admin(new_admin)` | admin + new_admin | Transfer admin role |
| `lastprice(asset)` | — | Most recent price (SEP-40) |
| `price(asset, timestamp)` | — | Price in the tick containing `timestamp` (SEP-40) |
| `prices(asset, records)` | — | Up to 20 most recent prices, newest first (SEP-40) |
| `base()`, `assets()`, `decimals()`, `resolution()` | — | Feed configuration (SEP-40) |
| `admin()`, `is_reporter(asset, reporter)`, `asset_config(asset)` | — | Roles and limits |

> **Freshness is the consumer's check.** The feed never refuses to return an
> old price. Compare `timestamp` against the ledger time before relying on it.
> The admin can record any price through `override_price`, so a feed's admin
> should be a multisig.

**Events.** Every state-changing entry point publishes a Soroban event whose
first topic is the entry point's name, so admin handovers, issuer grants,
KYC decisions, compliance being switched off, and every governance action
can be followed without re-reading contract state.

**Error codes.** Every contract returns a typed `contracterror` enum, so
clients match on a stable numeric code. Discriminants are part of the public
interface: variants keep their values and new ones are appended.

---

## Security

StellarForge is pre-audit software. **Do not use on mainnet with real funds until a formal audit is complete.**

- All sensitive operations require Soroban `require_auth()` — no permission can be spoofed at the contract level.
- The `set_paused` circuit breaker allows emergency halts without upgrading contracts.
- Admin transfer requires both current and new admin to authenticate.
- See [SECURITY.md](docs/SECURITY.md) for the responsible disclosure policy.

---

## Contributing

We warmly welcome contributors of all skill levels. Whether you're fixing a typo, writing tests, building a new module, or reviewing a PR — you belong here.

Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started. Areas where we especially need help are listed there.

---

## Community

| Channel | Purpose |
|---|---|
| [GitHub Discussions](https://github.com/0xLizTech/stellarforge/discussions) | Architecture, proposals, Q&A |
| [Twitter/X](https://twitter.com/stellarforge_io) | Announcements |

---

## Roadmap Summary

| Phase | Theme | Status |
|---|---|---|
| 1 — Foundation | Core asset contract, compliance, registry, governance skeleton | **In Progress** |
| 2 — Fractionalization | Vault contract, yield distribution, fractional shares | Planned |
| 3 — DeFi Primitives | Liquidity pools, orderbook integration, yield tranching | Planned |
| 4 — Privacy & Cross-chain | ZK-compliant transfers, bridge to Ethereum/Cosmos | Planned |
| 5 — Full DAO | Decentralized governance, insurance pool, protocol treasury | Planned |

Full details in [ROADMAP.md](ROADMAP.md).

---

## License

Apache 2.0 — see [LICENSE](LICENSE).

Built with love on [Stellar](https://stellar.org) and [Soroban](https://soroban.stellar.org).
