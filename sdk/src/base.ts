import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

import type { Transaction } from "@stellar/stellar-sdk";

import { TransactionExpiredError, TransactionOutcomeUnknownError } from "./errors.js";
import { authEntryAddress, checkSignedAuthEntry } from "./sponsored.js";
import type { SponsoredTransaction } from "./sponsored.js";
import type { StellarForgeConfig, TxResult } from "./types.js";

/**
 * Validity window for a write transaction, in seconds.
 *
 * Long enough to survive a slow submission, short enough that an unsubmitted
 * signed transaction stops being replayable reasonably soon.
 */
const WRITE_TX_TIMEOUT_SECONDS = 180;

/** Validity window for a simulation, which is never submitted. */
const SIMULATION_TIMEOUT_SECONDS = 30;

/** Delay between status checks while waiting for a submitted transaction. */
const POLL_INTERVAL_MS = 1_000;

/**
 * How long to keep polling after a transaction's `maxTime`.
 *
 * A transaction can be included in a ledger that closes right at `maxTime`,
 * and the RPC reports that ledger a few seconds later. Stopping exactly at
 * `maxTime` would leave the outcome undecided.
 */
const SETTLEMENT_GRACE_MS = 30_000;

/** What a submitted transaction yielded, before a caller shapes it. */
export interface SubmitOutcome {
  hash: string;
  ledger: number;
  /** The contract's return value. Absent for entry points returning `()`. */
  returnValue: xdr.ScVal | undefined;
}

/**
 * Shared plumbing for a client bound to one deployed contract.
 *
 * Every StellarForge client needs the same four things — an RPC server, a
 * contract handle, read-only simulation, and the write path — so they live
 * here rather than being copied per contract.
 */
export abstract class ContractClient {
  protected readonly server: rpc.Server;
  protected readonly contract: Contract;
  protected readonly clientConfig: StellarForgeConfig;

  /**
   * @param contractId - Deployed contract address, from `config.contracts`.
   * @param configKey - Name of the `contracts` field, used only so a missing
   *   address names itself in the error.
   */
  protected constructor(
    config: StellarForgeConfig,
    contractId: string | undefined,
    configKey: string,
  ) {
    // TypeScript already requires rpcUrl; this catches JavaScript callers who
    // spread MAINNET_CONFIG, which deliberately carries none.
    if (!config.rpcUrl) {
      throw new Error(
        "config.rpcUrl is required. SDF runs no public mainnet RPC, so MAINNET_CONFIG has none; " +
          "choose a provider from https://developers.stellar.org/docs/data/apis/rpc/providers",
      );
    }
    if (!contractId) {
      throw new Error(`contracts.${configKey} address is required`);
    }
    this.clientConfig = config;
    this.server = new rpc.Server(config.rpcUrl, { allowHttp: false });
    this.contract = new Contract(contractId);
  }

  /** Simulates `method` and returns its raw return value. Touches no ledger state. */
  protected async simulateReadOnly(method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    // A throwaway account is enough: a simulation is never submitted, so the
    // source needs neither funding nor a real sequence number.
    const dummyKeypair = Keypair.random();
    const dummyAccount = new Account(dummyKeypair.publicKey(), "0");

    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.clientConfig.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(SIMULATION_TIMEOUT_SECONDS)
      .build();

    const simResult = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation error: ${simResult.error}`);
    }

    if (!simResult.result) {
      throw new Error(`No result returned from ${method}`);
    }

    return simResult.result.retval;
  }

  /**
   * Builds and prepares an invocation sourced from `source`.
   *
   * For an entry point calling `require_auth`, `source` must be the address it
   * authorizes, so the transaction signature satisfies the check. For a
   * permissionless entry point, any funded account will do.
   */
  protected async buildWriteTx(
    source: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<Transaction> {
    const account = await this.server.getAccount(source);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.clientConfig.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(WRITE_TX_TIMEOUT_SECONDS)
      .build();

    // Simulates, then attaches the footprint, authorization entries and
    // resource fee the transaction needs to be accepted.
    return this.server.prepareTransaction(tx);
  }

  /**
   * Signs with the configured secret and waits for the transaction to settle.
   *
   * @param source - The address sourcing the transaction, which must sign it:
   *   it supplies the sequence number and pays the fee, whatever the contract
   *   requires. For an entry point calling `require_auth`, this is also the
   *   address being authorized. For a permissionless one it is simply whoever
   *   is paying.
   */
  protected async signAndSubmit(
    tx: Transaction,
    source: string,
    sponsored = false,
  ): Promise<SubmitOutcome> {
    const secret = this.clientConfig.signerSecret;
    if (!secret) {
      throw new Error(
        "config.signerSecret is required to submit a transaction. " +
          "Use the matching build*Tx method to sign with a wallet instead.",
      );
    }

    const keypair = Keypair.fromSecret(secret);

    // The signer has to be the transaction source. Catching it here beats a
    // protocol-level bad-auth failure, or a require_auth failure after the fee
    // is spent.
    if (keypair.publicKey() !== source) {
      throw new Error(
        sponsored
          ? `signerSecret is for ${keypair.publicKey()} but this sponsored transaction is sourced ` +
              `and paid for by ${source}, which must sign it.`
          : `signerSecret is for ${keypair.publicKey()} but this call must be authorized by ` +
              `${source}. To pay from a different account, use a buildSponsored*Tx method.`,
      );
    }

    tx.sign(keypair);

    const sent = await this.server.sendTransaction(tx);
    switch (sent.status) {
      case "ERROR":
        throw new Error(`Transaction ${sent.hash} was rejected on submission`);
      case "TRY_AGAIN_LATER":
        // The node declined to queue it. Unlike a timeout, nothing is pending,
        // so the caller can retry straight away.
        throw new Error(
          `Transaction ${sent.hash} was not accepted (TRY_AGAIN_LATER). ` +
            "Nothing was submitted, so it is safe to retry.",
        );
      default:
        // PENDING, or DUPLICATE when this exact transaction is already queued.
        // Either way the network has it, so wait for it to settle.
        break;
    }

    const settled = await this.awaitSettlement(tx, sent.hash);
    if (settled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`Transaction ${sent.hash} did not succeed: ${settled.status}`);
    }

    return { hash: sent.hash, ledger: settled.ledger, returnValue: settled.returnValue };
  }

  /**
   * Polls until the transaction settles, or until it provably cannot.
   *
   * A fixed number of attempts was IR-05. The stellar-sdk default gave up after
   * about 30 seconds on a transaction valid for 180, so a caller could be told
   * a write failed, retry, and have the original land anyway, executing a mint
   * or transfer twice. Polling now runs until the transaction's `maxTime` plus
   * {@link SETTLEMENT_GRACE_MS}, and the last response decides between
   * {@link TransactionExpiredError} and {@link TransactionOutcomeUnknownError}.
   */
  private async awaitSettlement(
    tx: Transaction,
    hash: string,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse> {
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    const deadlineMs = maxTime * 1000 + SETTLEMENT_GRACE_MS;
    const attempts = Math.max(1, Math.ceil((deadlineMs - Date.now()) / POLL_INTERVAL_MS));

    const settled = await this.server.pollTransaction(hash, {
      attempts,
      sleepStrategy: () => POLL_INTERVAL_MS,
    });
    if (settled.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return settled;
    }

    // No ledger that closes after maxTime can include the transaction. Once
    // the RPC has seen such a ledger and still does not know the hash, it
    // never will.
    if (maxTime > 0 && Number(settled.latestLedgerCloseTime) > maxTime) {
      throw new TransactionExpiredError(hash);
    }
    throw new TransactionOutcomeUnknownError(hash);
  }

  /**
   * Signs, submits, and discards the return value.
   *
   * The common case: most entry points return `()`, so there is nothing to
   * carry back beyond the hash and ledger.
   */
  protected async submit(tx: Transaction, source: string): Promise<TxResult> {
    const { hash, ledger } = await this.signAndSubmit(tx, source);
    return { hash, ledger };
  }

  // ── Sponsored writes (#31) ─────────────────────────────────────────────────

  /**
   * Builds an invocation that `feeSource` sources and pays for, and returns the
   * authorization entries other parties must sign. See `sponsored.ts` for the
   * whole flow.
   *
   * Nothing is prepared or signed here. The transaction is rebuilt when it is
   * finalized, with a fresh sequence number and validity window, so gathering
   * signatures may take longer than the transaction's own 180 seconds.
   */
  protected async buildSponsoredWriteTx(
    feeSource: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<SponsoredTransaction> {
    const transaction = new TransactionBuilder(await this.server.getAccount(feeSource), {
      fee: BASE_FEE,
      networkPassphrase: this.clientConfig.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(WRITE_TX_TIMEOUT_SECONDS)
      .build();

    const simulation = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`Simulation error: ${simulation.error}`);
    }

    const authEntries = simulation.result?.auth ?? [];
    const authorizers = authEntries.map(authEntryAddress);

    // Checked here because the network's own rejection is opaque: simulating
    // with a signed entry from an account that does not exist fails with
    // "trying to get non-existing value for account". Confirmed on testnet.
    for (const authorizer of new Set(authorizers)) {
      if (authorizer === null || !authorizer.startsWith("G")) continue;
      try {
        await this.server.getAccount(authorizer);
      } catch {
        throw new Error(
          `${authorizer} must authorize this call but has no account on the network. An account ` +
            "can authorize only once it exists, even when another account pays every fee.",
        );
      }
    }

    return { transaction, authEntries, authorizers };
  }

  /**
   * Attaches the signed entries to a sponsored invocation and prepares it for
   * the fee payer to sign.
   *
   * Each signed entry is checked against the entry it replaces: the same
   * invocation, address and nonce, actually signed, and expiring no sooner than
   * {@link MIN_AUTH_REMAINING_LEDGERS} and no later than
   * {@link MAX_AUTH_VALIDITY_LEDGERS} ledgers from now. The transaction is then
   * rebuilt from the fee payer's current sequence and simulated again with the
   * signatures in place, which is also where the network rejects a signature
   * made with the wrong key.
   *
   * @returns An unsigned transaction, sourced by the fee payer.
   */
  async finalizeSponsoredTx(
    sponsored: SponsoredTransaction,
    signedEntries: readonly xdr.SorobanAuthorizationEntry[],
  ): Promise<Transaction> {
    const { authEntries, transaction } = sponsored;
    if (signedEntries.length !== authEntries.length) {
      throw new Error(
        `Expected ${authEntries.length} authorization entries, got ${signedEntries.length}. ` +
          "Pass back every entry, including those the fee payer covers.",
      );
    }

    const { sequence: latestLedger } = await this.server.getLatestLedger();
    signedEntries.forEach((signed, i) =>
      checkSignedAuthEntry(authEntries[i] as xdr.SorobanAuthorizationEntry, signed, latestLedger, i),
    );

    const { func } = transaction.operations[0] as unknown as { func: xdr.HostFunction };
    const withAuth = new TransactionBuilder(await this.server.getAccount(transaction.source), {
      fee: BASE_FEE,
      networkPassphrase: this.clientConfig.networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({ func, auth: [...signedEntries] }))
      .setTimeout(WRITE_TX_TIMEOUT_SECONDS)
      .build();

    const simulation = await this.server.simulateTransaction(withAuth);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`Simulation error: ${simulation.error}`);
    }
    return rpc.assembleTransaction(withAuth, simulation).build();
  }

  /**
   * Finalizes a sponsored invocation, signs it with `config.signerSecret` as the
   * fee payer, and waits for it to settle.
   */
  async submitSponsoredTx(
    sponsored: SponsoredTransaction,
    signedEntries: readonly xdr.SorobanAuthorizationEntry[],
  ): Promise<TxResult> {
    const tx = await this.finalizeSponsoredTx(sponsored, signedEntries);
    const { hash, ledger } = await this.signAndSubmit(tx, tx.source, true);
    return { hash, ledger };
  }

  /**
   * Hands this contract's admin role to `newAdmin`.
   *
   * The contract requires the current and the incoming admin to authorize in
   * one transaction (NFR-S-4), so this is always built sponsored. `feeSource`
   * (by default the current admin) sources and pays. Every other authorizer
   * signs its entry, and when the fee payer is the current admin, that leaves
   * only `newAdmin` to sign.
   *
   * @param admin - The current admin. The contract reads it from storage, so it
   *   is used only as the default fee payer.
   */
  async buildTransferAdminTx(
    admin: string,
    newAdmin: string,
    options: { feeSource?: string } = {},
  ): Promise<SponsoredTransaction> {
    return this.buildSponsoredWriteTx(options.feeSource ?? admin, "transfer_admin", [
      nativeToScVal(newAdmin, { type: "address" }),
    ]);
  }
}

/**
 * Unwraps a Soroban unit enum variant.
 *
 * `scValToNative` decodes `ProposalStatus::Active` to the one-element array
 * `["Active"]`, not to `"Active"`. Handing that straight to a caller gives them
 * a value that silently fails every comparison they write.
 */
export function unwrapEnumVariant(decoded: unknown): string {
  if (Array.isArray(decoded) && typeof decoded[0] === "string") {
    return decoded[0];
  }
  if (typeof decoded === "string") {
    return decoded;
  }
  throw new Error(`Expected a unit enum variant, got ${JSON.stringify(decoded)}`);
}

/**
 * Converts a hex string to the `Bytes` a contract expects.
 *
 * Rejects odd-length or non-hex input before anything touches the network, so a
 * malformed document hash fails in the caller rather than being encoded as
 * different bytes.
 */
export function hexToScVal(hex: string): xdr.ScVal {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`Expected an even-length hex string, got: ${hex}`);
  }
  return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
}
