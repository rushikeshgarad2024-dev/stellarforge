# Contributing to StellarForge

First — **thank you**. StellarForge is an ambitious open-source infrastructure project and every contribution moves the RWA ecosystem forward. Whether you write code, review PRs, improve documentation, surface bugs, or simply participate in design discussions, you are making this project better.

This document explains how to contribute effectively. Please read it before opening an issue or pull request.

---

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [Where to Start](#where-to-start)
3. [Development Setup](#development-setup)
4. [Project Structure](#project-structure)
5. [Making Changes](#making-changes)
6. [Commit Style](#commit-style)
7. [Pull Request Process](#pull-request-process)
8. [Testing Requirements](#testing-requirements)
9. [Documentation Standards](#documentation-standards)
10. [Security Vulnerabilities](#security-vulnerabilities)
11. [Areas Needing Help](#areas-needing-help)
12. [Recognition](#recognition)

---

## Code of Conduct

StellarForge is committed to a welcoming, inclusive, and harassment-free community. By participating you agree to:

- **Be respectful.** Critique ideas, not people.
- **Be patient.** Not everyone has the same background or timezone.
- **Be constructive.** If you identify a problem, try to propose a solution.
- **No discrimination.** On any basis — experience level, gender, ethnicity, nationality, or anything else.

Serious or repeated violations may result in removal from the project. Report issues by emailing `conduct@stellarforge.io`.

---

## Where to Start

**New to the project?** Look for issues tagged:

- [`good first issue`](https://github.com/0xLizTech/stellarforge/issues?q=label%3A%22good+first+issue%22) — small, well-scoped tasks ideal for first-timers
- [`help wanted`](https://github.com/0xLizTech/stellarforge/issues?q=label%3A%22help+wanted%22) — tasks where we especially welcome outside help
- [`documentation`](https://github.com/0xLizTech/stellarforge/issues?q=label%3Adocumentation) — no Rust required; improve docs, ADRs, or examples

**New to Stellar/Soroban?** Start here:
- [Soroban documentation](https://soroban.stellar.org/docs)
- [Stellar developer docs](https://developers.stellar.org)
- [`/docs/architecture/`](docs/architecture/) — our architecture decision records

**Experienced contributor?** Jump straight into the [Roadmap](ROADMAP.md) and pick up a Phase 2 or 3 task that excites you, then open a discussion before building.

---

## Development Setup

### Required Tools

```bash
# Rust (stable + wasm32 target)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32v1-none
rustup component add rustfmt clippy

# Stellar CLI (includes Soroban). The `opt` feature no longer exists; the
# version must track the soroban-sdk major pinned in Cargo.toml.
cargo install --locked stellar-cli

# Node.js >= 20 (for the SDK)
# Use https://volta.sh or https://nvm.sh for version management

# Optional but recommended
cargo install cargo-watch    # auto-rerun tests on save
```

### Initial Setup

```bash
git clone https://github.com/0xLizTech/stellarforge.git
cd stellarforge

# Build everything
make build

# Run all tests
make test

# Set up SDK
make sdk-install
make sdk-test
```

### Running a single contract's tests

```bash
cd contracts/rwa-asset
cargo test --features testutils
```

### Watching for changes (fast feedback loop)

```bash
cargo watch -x "test --all --features testutils"
```

### Deploying to testnet for manual testing

```bash
# Generate and fund a test keypair
stellar keys generate devkey --network testnet
stellar keys fund devkey --network testnet

# Deploy
STELLAR_ACCOUNT=devkey make deploy-testnet
```

---

## Project Structure

```
stellarforge/
├── contracts/              # All Soroban smart contracts (Rust)
│   ├── common/             # Shared storage/TTL policy; a library, never deployed
│   ├── rwa-asset/          # Core RWA token (mint, burn, transfer, metadata)
│   ├── registry/           # Global registry of deployed asset contracts
│   ├── compliance/         # KYC/AML record management
│   ├── governance/         # On-chain proposal & voting
│   └── oracle-adapter/     # SEP-40 NAV price feed (Phase 2)
├── sdk/                    # @stellarforge-protocol/sdk (TypeScript)
│   ├── src/
│   │   ├── client.ts       # RwaAssetClient, ComplianceClient
│   │   ├── types.ts        # Shared data types
│   │   └── utils.ts        # Pure utility functions
│   └── tests/
├── docs/
│   ├── prd/                # Product Requirements Document
│   └── architecture/       # Architecture Decision Records (ADRs)
├── scripts/                # Deployment and ops scripts
└── .github/
    └── workflows/          # GitHub Actions CI
```

Each contract is an independent Cargo package inside the workspace. They share no runtime dependencies on each other — cross-contract calls happen via Soroban's `env.invoke_contract` interface, keeping each contract independently deployable and upgradeable. `contracts/common` is the one exception, and only at compile time: it holds policy that must be identical everywhere (currently the storage TTL constants) and is never deployed as a contract of its own.

---

## Making Changes

### 1. Fork and branch

```bash
# Fork on GitHub, then:
git clone https://github.com/YOUR_USERNAME/stellarforge.git
cd stellarforge
git remote add upstream https://github.com/0xLizTech/stellarforge.git
git checkout -b feat/your-feature-name
```

Branch naming conventions:
| Prefix | Use case |
|---|---|
| `feat/` | New feature or module |
| `fix/` | Bug fix |
| `docs/` | Documentation only |
| `test/` | Adding or fixing tests |
| `refactor/` | Code restructuring without behavior change |
| `chore/` | Tooling, CI, dependency bumps |

### 2. Write your code

**Rust contracts:**
- Keep contracts minimal and single-purpose.
- Every public function must have `require_auth()` on any address that performs a privileged action.
- Avoid panics except for invariant violations; use descriptive panic messages.
- No `unsafe` code — Soroban's WASM sandbox already provides isolation.
- Prefer `persistent` storage for user data and `instance` storage for admin/config data.
- All `i128` amounts must be validated positive before arithmetic.

**TypeScript SDK:**
- Strict TypeScript — no `any` types.
- Pure utility functions are preferred; side effects belong in `client.ts`.
- All exported functions and types must have JSDoc.
- Never hardcode secrets, RPC URLs, or contract IDs — pass via config.

### 3. Format and lint

```bash
# Rust
make fmt
make lint

# TypeScript — checks src/ and tests/
cd sdk && npm run typecheck
```

CI will reject PRs that fail formatting or linting.

### 4. Write tests

See [Testing Requirements](#testing-requirements).

---

## Commit Style

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional longer body]

[optional footer: BREAKING CHANGE: ..., Closes #123]
```

**Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`

**Scopes:** `rwa-asset`, `registry`, `compliance`, `governance`, `oracle-adapter`, `sdk`, `ci`, `docs`

**Examples:**

```
feat(rwa-asset): add transfer_from with allowance deduction
fix(compliance): correct expiry check direction (> not <)
docs(readme): add SDK quick-start example
test(rwa-asset): add pause/unpause integration tests
chore(ci): cache cargo registry for faster builds
```

Keep the subject line under 72 characters. Use the body for _why_, not _what_.

---

## Pull Request Process

1. **Open a draft PR early** if you want design feedback before finishing.
2. **Fill in the PR template** — describe what changed, why, and how to test it.
3. **Ensure CI is green** — all checks must pass before review.
4. **Request a review** from a maintainer (listed in [CODEOWNERS](.github/CODEOWNERS) once it exists).
5. **Address review comments** — update the branch; do not open a new PR.
6. **Squash or rebase** messy commit history before final merge if asked.
7. A maintainer will merge once at least **one approval** is received and all checks pass.

### PR size guidelines

- **Small PRs merge faster.** Keep each PR focused on a single concern.
- If a feature naturally requires multiple contracts or layers, split it across linked PRs.
- Documentation-only PRs can be larger.

---

## Testing Requirements

### Contracts (Rust)

- All new public functions must have at least one positive test (happy path) and one negative test (expected panic or error).
- Use `env.mock_all_auths()` for unit tests; avoid mocking auth for integration scenarios where auth is the feature being tested.
- Tests live in a `tests/` folder inside each contract crate (not inline).
- Run: `cargo test --all --features testutils`

### SDK (TypeScript)

- All utility functions in `utils.ts` must have full unit test coverage.
- Client tests stub Soroban RPC at `rpc.Server.prototype.simulateTransaction` rather than mocking the whole module, so the real `Contract`, `TransactionBuilder` and ScVal codecs stay in the path. See `tests/client.test.ts`.
- Run: `cd sdk && npm test`

#### Live smoke test (opt-in)

`tests/smoke.testnet.test.ts` runs the same read methods against a deployed contract over real Soroban RPC. It skips unless you point it at one, which is why CI never runs it.

```bash
cd sdk
SMOKE_RWA_ASSET_ID=C... SMOKE_COMPLIANCE_ID=C... npm run test:smoke
```

| Variable | Purpose |
|---|---|
| `SMOKE_RWA_ASSET_ID` | Deployed `rwa-asset` contract id. Unset skips that block. |
| `SMOKE_COMPLIANCE_ID` | Deployed `compliance` contract id. Unset skips that block. |
| `SMOKE_HOLDER_ADDRESS` | Optional address to query. Defaults to a deterministic unfunded one. |
| `SOROBAN_RPC_URL` | Defaults to Soroban testnet. Must be `https`, since the clients set `allowHttp: false`. |
| `STELLAR_NETWORK_PASSPHRASE` | Defaults to the testnet passphrase. |

`make deploy-testnet` writes the deployed ids to `deployed-contracts.json`.

The two layers are not interchangeable. A stub replaces the SDK's own behaviour with a fixture, so those tests pass identically across SDK versions no matter what changed underneath. Only the smoke test exercises the real wire format, which is what a major `@stellar/stellar-sdk` bump needs evidence for. Run it before merging one.

#### Live write smoke test (opt-in, moves testnet tokens)

`tests/smoke.write.testnet.test.ts` runs the write methods against a deployed `rwa-asset`: `mint`, `transfer` (including to a muxed address), `approve`, `transferFrom`, `burnFrom` and `burn`, plus a sponsored `transfer` that the issuer authorizes and the spender pays for. With `SMOKE_WRITE_SETUP` it first configures the deployment through the operator methods (`setIssuer`, `setKyc`, `revokeKyc`, `setCompliance`, `setPaused`, `updateMetadata`), checking each through its read. Each step asserts a before-and-after delta, so it can be re-run against the same contract. It is gated separately from the read smoke test, and it refuses any network passphrase except testnet's.

```bash
cd sdk
SMOKE_WRITE_RWA_ASSET_ID=C... \
SMOKE_WRITE_ISSUER_SECRET=S... \
SMOKE_WRITE_SPENDER_SECRET=S... \
SMOKE_WRITE_RECIPIENT_ADDRESS=G... \
npm run test:smoke:write
```

| Variable | Purpose |
|---|---|
| `SMOKE_WRITE_RWA_ASSET_ID` | Deployed `rwa-asset` contract id. Unset skips the whole file. |
| `SMOKE_WRITE_ISSUER_SECRET` | Account holding the issuer role on that asset. It signs and pays for `mint`, `transfer`, `approve` and `burn`. |
| `SMOKE_WRITE_SPENDER_SECRET` | A second funded account. It signs and pays for `transferFrom` and `burnFrom`. |
| `SMOKE_WRITE_RECIPIENT_ADDRESS` | Receives the transfers. It needs no account. |
| `SMOKE_WRITE_SCREENED` | Set to `true` when the asset has a compliance contract, to also assert that a transfer to an unverified address is refused. |
| `SMOKE_WRITE_TRANSFER_ADMIN` | Set to `true` to also hand the asset's admin role from the issuer to the spender, through a sponsored `transfer_admin`. It runs last. Never set it for a deployment you intend to keep administering. |
| `SMOKE_WRITE_SETUP` | Set to `true` to have the test configure the deployment itself through the operator methods before the holder writes. |
| `SMOKE_WRITE_COMPLIANCE_ID` | Deployed `compliance` contract id. Required with `SMOKE_WRITE_SETUP`. |
| `SMOKE_WRITE_ADMIN_SECRET` | Admin of the asset and the compliance contract, used by `SMOKE_WRITE_SETUP`. Defaults to `SMOKE_WRITE_ISSUER_SECRET`, since a default deploy makes the issuer the admin. |

**Before running it**, the asset's admin must grant the issuer role (`set_issuer`), and the asset must not be paused. If a compliance contract is configured, the issuer and the recipient both need KYC records at the asset's `min_level`, or the transfers fail with `NotCompliant`. With `SMOKE_WRITE_SETUP` set, the test does all of this itself.

**What one run changes:** it mints 1,000 base units, transfers 510 of them to the recipient (40 in a transfer the spender pays for), burns 80, and leaves the spender an allowance of 150 over the issuer's balance. Total supply rises by 920 per run. The issuer and the spender each pay testnet fees for the transactions they source. With `SMOKE_WRITE_SETUP` set, it also records KYC for the issuer and the recipient, switches compliance on at level 1, pauses and unpauses the asset, and replaces its legal document hash. With `SMOKE_WRITE_TRANSFER_ADMIN` set, the spender also ends up as the asset's admin. Nothing is cleaned up afterwards.

The **Testnet Smoke** workflow runs it on every dispatch, against a fresh deployment it configures through `SMOKE_WRITE_SETUP`.

### Coverage targets (aspirational, not enforced in CI yet)

| Layer | Target |
|---|---|
| Soroban contracts | ≥ 80% branch coverage |
| SDK utilities | 100% |
| SDK clients | ≥ 70% |

---

## Documentation Standards

- **ADRs (Architecture Decision Records):** For any significant architectural decision, create a new ADR in `docs/architecture/` using the template at `docs/architecture/000-template.md`. ADRs are immutable once merged; superseded ADRs are marked as such.
- **Contract changes:** Update the relevant section in `README.md`'s Contract Reference table.
- **New modules:** Add a brief description to the README architecture diagram.
- **Breaking changes:** Document in `CHANGELOG.md` and flag `BREAKING CHANGE:` in the commit footer.

Comments in Rust code: write them only when the _why_ is genuinely non-obvious. Do not comment what the code does — the code should be readable itself.

---

## Security Vulnerabilities

**Do not open a public GitHub issue for security vulnerabilities.**

Email `security@stellarforge.io` with:
- A description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Any suggested mitigations

We aim to acknowledge within 48 hours and provide a fix timeline within 7 days. Responsible disclosures will be credited in the release notes (unless you prefer anonymity).

See [docs/SECURITY.md](docs/SECURITY.md) for the full policy.

---

## Areas Needing Help

We are a small core team with a large vision. Here are the areas where outside contributions will have the highest impact:

### High Priority

- **Fractionalization vault contract** (Phase 2) — the core vault that holds an underlying asset and issues fractional shares. Design discussion open in [#discussions](https://github.com/0xLizTech/stellarforge/discussions).
- **Yield distribution engine** (Phase 2) — distributing income from underlying assets to fractional token holders.
- **SDK: transaction builder helpers** — right now clients only do read-only simulation; we need write path helpers for `mint`, `burn`, `transfer`, `approve`, and `transfer_from`.

### Medium Priority

- **Architecture Decision Records** — we need ADRs for the auth patterns, the upgrade path strategy, and the cross-contract interaction model (storage key design is already covered by ADR-001).
- **SDK clients for `registry` and `governance`** — the SDK currently exposes only `RwaAssetClient` and `ComplianceClient`.
- **Example apps** — a minimal Next.js or plain-HTML frontend that demonstrates minting and transferring an RWA token.

### Lower Effort / Great First Issues

- Write an ADR for the chosen Stellar network passphrase management approach.
- Expand `sdk/tests` beyond `utils.test.ts` — mock the Soroban RPC with `vitest` and cover the client methods.
- Add `#[doc]` comments and improve the wording on each contract error variant.
- Triage and label open issues with [`good first issue`](https://github.com/0xLizTech/stellarforge/issues?q=label%3A%22good+first+issue%22) and [`help wanted`](https://github.com/0xLizTech/stellarforge/issues?q=label%3A%22help+wanted%22).

---

## Recognition

Contributors are recognized in:

- The `CHANGELOG.md` for the release they contributed to.
- The GitHub contributors graph.

Significant contributors (multiple merged PRs or major features) will be invited to join the `stellarforge-contributors` GitHub team, which grants write access to non-main branches and the ability to review PRs.

We believe open-source is built on trust and generosity. Thank you for being part of this. 🌟
