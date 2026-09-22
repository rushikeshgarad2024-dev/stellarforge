# @stellarforge-protocol/sdk

TypeScript client for the [StellarForge](https://github.com/0xLizTech/stellarforge)
Real World Asset tokenization protocol on Stellar/Soroban.

Clients for all four Phase 1 contracts: `rwa-asset`, `compliance`, `registry`
and `governance`.

```bash
npm install @stellarforge-protocol/sdk
```

Requires Node.js 22.12 or newer, which is what `@stellar/stellar-sdk` 17 requires. Its CommonJS build loads ESM-only dependencies with `require()`, and Node supports that without a flag only from 22.12.

## Reading

Every read is a simulation. Nothing is written, nothing is signed, and no
account is needed.

```typescript
import { RwaAssetClient, TESTNET_CONFIG, fromStroops } from "@stellarforge-protocol/sdk";

const client = new RwaAssetClient({
  ...TESTNET_CONFIG,
  contracts: { rwaAsset: "C..." },
});

const meta = await client.metadata();
const supply = await client.totalSupply();

console.log(`${meta.symbol}: ${fromStroops(supply, meta.decimals)}`);
```

Amounts are `bigint`, because the contracts store them as `i128` and a `number`
would lose precision silently. Use `toStroops` and `fromStroops` to convert.
`toStroops` throws rather than guess. It rejects anything but plain decimal
notation, more decimal places than the asset allows, and a `number` that is not
a safe integer, so pass user-entered amounts as strings.

## Networks

`TESTNET_CONFIG` includes SDF's public testnet RPC. `MAINNET_CONFIG` has no RPC
URL, because SDF doesn't run a public mainnet RPC. Supply one from an
[RPC provider](https://developers.stellar.org/docs/data/apis/rpc/providers); TypeScript won't compile a mainnet config without it.

```typescript
import { MAINNET_CONFIG, RwaAssetClient } from "@stellarforge-protocol/sdk";

const client = new RwaAssetClient({
  ...MAINNET_CONFIG,
  rpcUrl: "https://your-mainnet-rpc-provider.example",
  contracts: { rwaAsset: "C..." },
});
```

## Writing

Every write comes in two forms.

**`build*Tx` returns a prepared but unsigned transaction** for a wallet to
sign. No secret reaches this library, which is the only form usable in a
browser.

```typescript
const tx = await client.buildTransferTx(from, to, toStroops("100", meta.decimals));
const signedXdr = await freighter.signTransaction(tx.toXdr(), { networkPassphrase });
```

**The bare method signs and submits**, for server-side automation.

```typescript
const client = new RwaAssetClient({ ...TESTNET_CONFIG, contracts, signerSecret });
const { hash, ledger } = await client.transfer(from, to, amount);
```

A bare write waits for the transaction to settle, for up to its 180-second
validity window plus 30 seconds. If it has not settled by then, the error type
says whether retrying is safe:

- `TransactionExpiredError`: the window closed without the transaction being
  included. It can never land, so rebuild and resubmit.
- `TransactionOutcomeUnknownError`: it may still land. Look up `err.hash`
  before retrying, or the write may execute twice.

Two things worth knowing before you use either:

- **The authorizing address also sources the transaction** in these forms, so
  its signature satisfies the contract's `require_auth`. To have another account
  pay, see [Sponsored writes](#sponsored-writes).
- **Building simulates.** A call the contract would reject — a bad amount, a
  paused asset, a party failing compliance — fails while building, with the
  contract's own error, before anything is signed or submitted.

## Clients

| Client | Contract | Notes |
|---|---|---|
| `RwaAssetClient` | `rwa-asset` | Balances, metadata, allowances; mint, burn, burnFrom, transfer, approve (with an expiry ledger), transferFrom. Admin: setIssuer, setPaused, updateMetadata, setCompliance |
| `ComplianceClient` | `compliance` | `isCompliant` is the pure query, never the TTL-extending `screen`; `getKyc` reads a stored record. Admin: setKyc, revokeKyc |
| `RegistryClient` | `registry` | Asset directory, paged with `listAssets(start, limit)` or walked with `listAllAssets()`; `register` and `setActive` are admin-only |
| `GovernanceClient` | `governance` | Proposals and voting — **see the warning below** |
| `VaultClient` | `vault` | Real estate / RWA share vault: config, balances, historical checkpoints, NAV, sponsored deposits/redeems, and typed event decoders |

## Vault & Auth-Tree Verification

`VaultClient` handles tokenized share vaults where users deposit underlying RWA tokens in exchange for vault shares:

```typescript
import {
  VaultClient,
  TESTNET_CONFIG,
  sharesForDeposit,
  underlyingForRedeem,
  maxRedeemable,
  describeAuthTree,
  decodeVaultEvents,
} from "@stellarforge-protocol/sdk";

const client = new VaultClient({
  ...TESTNET_CONFIG,
  contracts: { vault: "C...", rwaAsset: "C..." },
});

// 1. Typed reads & NAV
const config = await client.config();
const navData = await client.nav(); // Throws NavRefusalError if oracles diverge or are stale
const navPerShare = await client.navPerShare();

// 2. Pure rounding and lockup checks
const shares = sharesForDeposit(assets, config.exchangeRate);
const redeemableBalance = maxRedeemable(userBalance, lockedUntilLedger, currentLedger);

// 3. Sponsored deposit with auth-tree verification
const sponsored = await client.buildSponsoredDepositTx(depositor, depositAmount, {
  feeSource: relayer,
});

// The authorizer can inspect the entire nested call tree:
// e.g. "Root: <vault>.deposit(depositor, amount) └── <rwa>.transfer(depositor, vault, amount)"
console.log(describeAuthTree(sponsored.authEntries[0]));

// Deep verification runs during finalizeSponsoredTx: verifies root calls AND
// nested child invocations, refusing any tampering of amounts, contracts, or methods.
const finalizedTx = await client.finalizeSponsoredTx(sponsored, signedEntries);

// 4. Typed event decoding
const events = decodeVaultEvents(txResult);
for (const event of events) {
  if (event.type === "deposit") {
    console.log(`Deposited ${event.assets} assets for ${event.shares} shares by ${event.depositor}`);
  }
}
```

## Sponsored writes

One account can source and pay for a write while another address only
authorizes it, for example an issuer covering fees for its holders. The
authorizer signs an authorization entry rather than the transaction, so the two
keys can live on different machines.

```typescript
import { rpc } from "@stellar/stellar-sdk";
import { DEFAULT_AUTH_VALIDITY_LEDGERS, authorizeEntries } from "@stellarforge-protocol/sdk";

// Fee payer: build the call. Nothing is signed yet.
const sponsored = await client.buildSponsoredTransferTx(holder, recipient, amount, {
  feeSource: relayer,
});

// Authorizer: sign its entries, valid until a ledger it chooses.
const { sequence } = await new rpc.Server(rpcUrl).getLatestLedger();
const signed = await authorizeEntries(
  sponsored.authEntries,
  holderKeypair,
  sequence + DEFAULT_AUTH_VALIDITY_LEDGERS,
  networkPassphrase,
);

// Fee payer: attach the signatures, then sign and submit.
const { hash } = await client.submitSponsoredTx(sponsored, signed);
```

- **Transport.** Entries cross machines as base64 through `authEntriesToXdr`
  and `authEntriesFromXdr`. `finalizeSponsoredTx` returns the prepared
  transaction instead of submitting it, for a fee payer signing with a wallet.
- **Checks before submitting.** Finalizing checks every signed entry against
  the one built, and requires its expiry to be at least
  `MIN_AUTH_REMAINING_LEDGERS` (40) and at most `MAX_AUTH_VALIDITY_LEDGERS`
  (17,280) ledgers ahead. `authorizeEntries` refuses a key the entries don't
  name.
- **Network rejections.** The network refuses a signature made with the wrong
  key, a replayed entry, and an entry reused for other arguments.
- **The authorizer must have an account.** It must already exist on the
  network, even though it pays nothing.

`buildTransferAdminTx(admin, newAdmin)`, on every client, uses the same flow,
because the contract requires both admins to authorize. By default the current
admin pays, and the incoming admin signs its entry.

### Governance results are advisory in Phase 1

The governance contract accepts whatever vote weight its caller declares and
verifies it against nothing, and `finalize` applies no quorum. **Any address
can carry any proposal.** Do not gate anything privileged on an outcome read
through `GovernanceClient`.

Weight is deliberately unverified rather than read from a live balance, which
would be worse: a holder could vote, transfer the same tokens onward, and vote
again from the recipient. Correct weighting needs balances snapshotted at
proposal creation, which arrives with `SFORGE` in Phase 2/3.

## Status

Phase 1. The contracts are unaudited and not deployed to mainnet. See the
[roadmap](https://github.com/0xLizTech/stellarforge/blob/main/ROADMAP.md).

## License

Apache-2.0
