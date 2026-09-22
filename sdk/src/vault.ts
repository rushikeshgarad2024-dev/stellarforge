import {
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import type { Transaction, rpc } from "@stellar/stellar-sdk";

import { ContractClient } from "./base.js";
import type { SponsoredTransaction } from "./sponsored.js";
import type { StellarForgeConfig, TxResult } from "./types.js";

// ─── Vault Types & Interfaces ──────────────────────────────────────────────────

/** Deployment and operational configuration of a StellarForge fractionalization vault. */
export interface VaultConfig {
  /** Contract address of the underlying RWA token. */
  underlying: string;
  /** Address of the vault's SEP-41 share token (itself). */
  shareToken: string;
  /** Fixed exchange rate: shares minted per 1 unit of underlying (FR-06-2). */
  exchangeRate: bigint;
  /** Maximum fractional share supply permitted; 0 means uncapped. */
  supplyCap: bigint;
  /** Whether deposits, redemptions, and transfers are paused. */
  paused: boolean;
  /** The vault's admin address. */
  admin: string;
  /** Authorized SEP-40 oracle adapter contract addresses for NAV reporting. */
  oracles: string[];
}

/** Net Asset Value report for the vault. */
export interface VaultNav {
  /** Total net asset value of the vault's underlying holdings. */
  nav: bigint;
  /** Ledger sequence at which this valuation was determined. */
  ledger: number;
  /** Oracle contract address or source key that provided the valuation. */
  source: string;
}

/** Net Asset Value per share report. */
export interface VaultNavPerShare {
  /** Net asset value per fractional share. */
  navPerShare: bigint;
  /** Ledger sequence of the valuation. */
  ledger: number;
  /** Oracle source providing or backing this calculation. */
  source: string;
}

// ─── Vault Errors ──────────────────────────────────────────────────────────────

/** Known Soroban error codes for the vault contract. */
export enum VaultErrorCode {
  AlreadyInitialized = 1,
  NotInitialized = 2,
  Unauthorized = 3,
  Paused = 4,
  ZeroAmount = 5,
  InsufficientBalance = 6,
  InsufficientAllowance = 7,
  SupplyCapExceeded = 8,
  LockedUntil = 9,
  NonMultipleRedeem = 10,
  ComplianceFailed = 11,
  OracleStale = 12,
  OracleDivergence = 13,
  InvalidRate = 14,
  MuxedAddressUnsupported = 15,
}

/** Base error class for all vault contract execution errors. */
export class VaultError extends Error {
  readonly code?: number | undefined;

  constructor(message: string, code?: number | undefined) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

/** Typed refusal error when a NAV query fails (e.g. stale price or divergence). */
export class NavRefusalError extends VaultError {
  readonly source: string;
  readonly reason: string;

  constructor(reason: string, source: string, code?: number | undefined) {
    super(`NAV refusal from source ${source}: ${reason}`, code);
    this.name = "NavRefusalError";
    this.source = source;
    this.reason = reason;
  }
}

// ─── Vault Events ──────────────────────────────────────────────────────────────

export interface DepositEvent {
  type: "deposit";
  caller: string;
  depositor: string;
  assets: bigint;
  shares: bigint;
  ledger: number;
}

export interface RedeemEvent {
  type: "redeem";
  caller: string;
  redeemer: string;
  shares: bigint;
  assets: bigint;
  ledger: number;
}

export interface TransferEvent {
  type: "transfer";
  from: string;
  to: string;
  amount: bigint;
  ledger: number;
}

export interface ApproveEvent {
  type: "approve";
  from: string;
  spender: string;
  amount: bigint;
  liveUntilLedger: number;
  ledger: number;
}

export interface SetPausedEvent {
  type: "set_paused";
  admin: string;
  paused: boolean;
  ledger: number;
}

export interface SetOraclesEvent {
  type: "set_oracles";
  admin: string;
  oracles: string[];
  ledger: number;
}

export interface UnknownVaultEvent {
  type: "unknown";
  raw?: unknown;
}

export type VaultEvent =
  | DepositEvent
  | RedeemEvent
  | TransferEvent
  | ApproveEvent
  | SetPausedEvent
  | SetOraclesEvent
  | UnknownVaultEvent;

// ─── Pure Rounding Helpers ─────────────────────────────────────────────────────

/**
 * Calculates the exact number of fractional shares minted for a given amount of
 * deposited underlying assets based on the fixed exchange rate (FR-06-2).
 *
 * @param assets - Amount of underlying assets deposited.
 * @param exchangeRate - Exchange rate: shares minted per 1 unit of underlying asset.
 * @returns Total fractional shares minted.
 * @throws RangeError if assets is negative or exchangeRate is non-positive.
 */
export function sharesForDeposit(assets: bigint, exchangeRate: bigint): bigint {
  if (assets < 0n) {
    throw new RangeError(`assets must be non-negative, got ${assets}`);
  }
  if (exchangeRate <= 0n) {
    throw new RangeError(`exchangeRate must be positive, got ${exchangeRate}`);
  }
  return assets * exchangeRate;
}

/**
 * Calculates the underlying assets returned when redeeming fractional shares.
 * Enforces that shares must be an exact integer multiple of the exchange rate (FR-06-3),
 * throwing an error if there is any fractional remainder.
 *
 * @param shares - Number of fractional shares to redeem.
 * @param exchangeRate - Exchange rate: shares per 1 unit of underlying asset.
 * @returns Amount of underlying assets to return.
 * @throws RangeError if shares is negative or exchangeRate is non-positive.
 * @throws Error if shares is not an exact integer multiple of exchangeRate.
 */
export function underlyingForRedeem(shares: bigint, exchangeRate: bigint): bigint {
  if (shares < 0n) {
    throw new RangeError(`shares must be non-negative, got ${shares}`);
  }
  if (exchangeRate <= 0n) {
    throw new RangeError(`exchangeRate must be positive, got ${exchangeRate}`);
  }
  const remainder = shares % exchangeRate;
  if (remainder !== 0n) {
    throw new Error(
      `shares (${shares}) must be an exact multiple of exchangeRate (${exchangeRate}); remainder: ${remainder}`,
    );
  }
  return shares / exchangeRate;
}

/**
 * Computes the maximum number of shares currently redeemable by a holder,
 * respecting the per-holder lock-up ledger period.
 *
 * @param balance - Total share balance of the holder.
 * @param lockedUntil - Ledger sequence until which the shares are locked.
 * @param currentLedger - Current ledger sequence.
 * @returns `balance` if the lock has lapsed (`currentLedger >= lockedUntil`), or `0n` if locked.
 * @throws RangeError if balance is negative.
 */
export function maxRedeemable(balance: bigint, lockedUntil: number, currentLedger: number): bigint {
  if (balance < 0n) {
    throw new RangeError(`balance must be non-negative, got ${balance}`);
  }
  if (currentLedger >= lockedUntil) {
    return balance;
  }
  return 0n;
}

// ─── Event Decoding ────────────────────────────────────────────────────────────

/**
 * Decodes a raw Soroban contract event into a strongly-typed `VaultEvent`.
 * Returns `{ type: "unknown" }` rather than throwing if the event does not match
 * expected vault schemas.
 *
 * @param event - The contract event (from simulation, XDR, or RPC getEvents).
 * @returns Discriminated union of typed vault events.
 */
export function decodeVaultEvent(event: unknown): VaultEvent {
  try {
    const raw = event as {
      type?: string;
      ledger?: number;
      topic?: string[];
      value?: { xdr?: string } | string;
      event?: { topics?: () => xdr.ScVal[]; data?: () => xdr.ScVal };
    };

    const ledger = raw.ledger ?? 0;

    // Handle parsed RPC getEvents format: topics as array of string / ScVal
    if (raw.topic && Array.isArray(raw.topic) && raw.topic.length > 0) {
      const topic0 = raw.topic[0];

      if (topic0 === "transfer" && raw.topic.length >= 3) {
        const from = raw.topic[1] ?? "";
        const to = raw.topic[2] ?? "";
        let amount = 0n;
        if (typeof raw.value === "string") {
          const scv = xdr.ScVal.fromXdr(raw.value, "base64");
          amount = scValToNative(scv) as bigint;
        } else if (raw.value?.xdr) {
          const scv = xdr.ScVal.fromXdr(raw.value.xdr, "base64");
          amount = scValToNative(scv) as bigint;
        }
        return { type: "transfer", from, to, amount, ledger };
      }

      if (topic0 === "Vault" && raw.topic.length >= 2) {
        const action = raw.topic[1];
        let nativeVal: Record<string, unknown> = {};
        if (typeof raw.value === "string") {
          nativeVal = scValToNative(xdr.ScVal.fromXdr(raw.value, "base64")) as Record<string, unknown>;
        } else if (raw.value?.xdr) {
          nativeVal = scValToNative(xdr.ScVal.fromXdr(raw.value.xdr, "base64")) as Record<string, unknown>;
        }

        if (action === "deposit") {
          return {
            type: "deposit",
            caller: (nativeVal["caller"] as string) ?? (raw.topic[2] as string) ?? "",
            depositor: (nativeVal["depositor"] as string) ?? (raw.topic[2] as string) ?? "",
            assets: (nativeVal["assets"] as bigint) ?? 0n,
            shares: (nativeVal["shares"] as bigint) ?? 0n,
            ledger,
          };
        }

        if (action === "redeem") {
          return {
            type: "redeem",
            caller: (nativeVal["caller"] as string) ?? (raw.topic[2] as string) ?? "",
            redeemer: (nativeVal["redeemer"] as string) ?? (raw.topic[2] as string) ?? "",
            shares: (nativeVal["shares"] as bigint) ?? 0n,
            assets: (nativeVal["assets"] as bigint) ?? 0n,
            ledger,
          };
        }

        if (action === "set_paused") {
          return {
            type: "set_paused",
            admin: (nativeVal["admin"] as string) ?? "",
            paused: Boolean(nativeVal["paused"]),
            ledger,
          };
        }

        if (action === "set_oracles") {
          return {
            type: "set_oracles",
            admin: (nativeVal["admin"] as string) ?? "",
            oracles: (nativeVal["oracles"] as string[]) ?? [],
            ledger,
          };
        }
      }
    }

    // Handle xdr.ContractEvent or xdr.DiagnosticEvent
    const contractEvent = (event as { event?: xdr.ContractEvent }).event ?? (event as xdr.ContractEvent);
    if (contractEvent?.type && contractEvent.body) {
      const v0 = contractEvent.body.v0;
      const topics = v0.topics.map((t: xdr.ScVal) => scValToNative(t));
      const nativeData = scValToNative(v0.data);

      if (topics[0] === "transfer" && topics.length >= 3) {
        return {
          type: "transfer",
          from: String(topics[1]),
          to: String(topics[2]),
          amount: typeof nativeData === "bigint" ? nativeData : BigInt(String(nativeData)),
          ledger,
        };
      }

      if (topics[0] === "approve" && topics.length >= 3) {
        const dataObj = nativeData as Record<string, unknown>;
        return {
          type: "approve",
          from: String(topics[1]),
          spender: String(topics[2]),
          amount: (dataObj["amount"] as bigint) ?? 0n,
          liveUntilLedger: Number(dataObj["live_until_ledger"] ?? 0),
          ledger,
        };
      }

      if (topics[0] === "Vault") {
        const action = String(topics[1]);
        const dataObj = (nativeData as Record<string, unknown>) ?? {};

        if (action === "deposit") {
          return {
            type: "deposit",
            caller: String(dataObj["caller"] ?? topics[2] ?? ""),
            depositor: String(dataObj["depositor"] ?? topics[2] ?? ""),
            assets: BigInt(String(dataObj["assets"] ?? 0)),
            shares: BigInt(String(dataObj["shares"] ?? 0)),
            ledger,
          };
        }

        if (action === "redeem") {
          return {
            type: "redeem",
            caller: String(dataObj["caller"] ?? topics[2] ?? ""),
            redeemer: String(dataObj["redeemer"] ?? topics[2] ?? ""),
            shares: BigInt(String(dataObj["shares"] ?? 0)),
            assets: BigInt(String(dataObj["assets"] ?? 0)),
            ledger,
          };
        }

        if (action === "set_paused") {
          return {
            type: "set_paused",
            admin: String(dataObj["admin"] ?? ""),
            paused: Boolean(dataObj["paused"]),
            ledger,
          };
        }

        if (action === "set_oracles") {
          return {
            type: "set_oracles",
            admin: String(dataObj["admin"] ?? ""),
            oracles: Array.isArray(dataObj["oracles"]) ? dataObj["oracles"].map(String) : [],
            ledger,
          };
        }
      }
    }

    return { type: "unknown", raw: event };
  } catch {
    return { type: "unknown", raw: event };
  }
}

/**
 * Decodes all events from an RPC `getEvents` response into an array of `VaultEvent`.
 *
 * @param getEventsResponse - The response object returned by `server.getEvents()`.
 * @returns Array of decoded vault events.
 */
export function decodeVaultEvents(getEventsResponse: unknown): VaultEvent[] {
  const resp = getEventsResponse as { events?: unknown[] };
  if (!resp || !Array.isArray(resp.events)) {
    return [];
  }
  return resp.events.map(decodeVaultEvent);
}

// ─── VaultClient ───────────────────────────────────────────────────────────────

/**
 * Client for interacting with a deployed StellarForge Fractionalization Vault contract.
 *
 * Provides typed methods for:
 * - All vault queries (`config`, `underlyingHeld`, `balance`, `totalSupply`, `nav`, `lockedUntil`, `redeemable`)
 * - Direct writes with automatic submission or manual transaction construction
 * - Sponsored writes with multi-contract authorization tree verification
 */
export class VaultClient extends ContractClient {
  constructor(config: StellarForgeConfig) {
    super(config, config.contracts.vault, "vault");
  }

  // ── Read-only queries ──────────────────────────────────────────────────────

  /** Retrieves the vault's complete configuration. */
  async config(): Promise<VaultConfig> {
    const result = await this.simulateReadOnly("config", []);
    const native = scValToNative(result) as Record<string, unknown>;
    return {
      underlying: Address.fromString(String(native["underlying"])).toString(),
      shareToken: Address.fromString(String(native["share_token"] ?? this.contract.contractId())).toString(),
      exchangeRate: BigInt(String(native["exchange_rate"] ?? 1)),
      supplyCap: BigInt(String(native["supply_cap"] ?? 0)),
      paused: Boolean(native["paused"]),
      admin: Address.fromString(String(native["admin"])).toString(),
      oracles: Array.isArray(native["oracles"]) ? native["oracles"].map((o) => Address.fromString(String(o)).toString()) : [],
    };
  }

  /** Total balance of underlying RWA tokens currently held in the vault. */
  async underlyingHeld(): Promise<bigint> {
    const result = await this.simulateReadOnly("underlying_held", []);
    return scValToNative(result) as bigint;
  }

  /** Fractional share balance of `holderAddress`. */
  async balance(holderAddress: string): Promise<bigint> {
    const result = await this.simulateReadOnly("balance", [
      nativeToScVal(holderAddress, { type: "address" }),
    ]);
    return scValToNative(result) as bigint;
  }

  /** Total circulating supply of fractional shares. */
  async totalSupply(): Promise<bigint> {
    const result = await this.simulateReadOnly("total_supply", []);
    return scValToNative(result) as bigint;
  }

  /** Allowance granted by `ownerAddress` to `spenderAddress` over fractional shares. */
  async allowance(ownerAddress: string, spenderAddress: string): Promise<bigint> {
    const result = await this.simulateReadOnly("allowance", [
      nativeToScVal(ownerAddress, { type: "address" }),
      nativeToScVal(spenderAddress, { type: "address" }),
    ]);
    return scValToNative(result) as bigint;
  }

  /** Fractional share token decimals (fixed to 7 on Stellar). */
  async decimals(): Promise<number> {
    const result = await this.simulateReadOnly("decimals", []);
    return scValToNative(result) as number;
  }

  /** Human-readable name of the fractional share token. */
  async name(): Promise<string> {
    const result = await this.simulateReadOnly("name", []);
    return scValToNative(result) as string;
  }

  /** Ticker symbol of the fractional share token. */
  async symbol(): Promise<string> {
    const result = await this.simulateReadOnly("symbol", []);
    return scValToNative(result) as string;
  }

  /** Ledger sequence until which `holderAddress`'s shares are locked. */
  async lockedUntil(holderAddress: string): Promise<number> {
    const result = await this.simulateReadOnly("locked_until", [
      nativeToScVal(holderAddress, { type: "address" }),
    ]);
    return Number(scValToNative(result));
  }

  /** Maximum number of shares currently redeemable by `holderAddress`. */
  async redeemable(holderAddress: string): Promise<bigint> {
    const result = await this.simulateReadOnly("redeemable", [
      nativeToScVal(holderAddress, { type: "address" }),
    ]);
    return scValToNative(result) as bigint;
  }

  /** Whether vault operations are currently paused. */
  async paused(): Promise<boolean> {
    const result = await this.simulateReadOnly("paused", []);
    return scValToNative(result) as boolean;
  }

  /** Address of the vault administrator. */
  async admin(): Promise<string> {
    const result = await this.simulateReadOnly("admin", []);
    return scValToNative(result) as string;
  }

  /** List of authorized oracle contract addresses. */
  async oracles(): Promise<string[]> {
    const result = await this.simulateReadOnly("oracles", []);
    const native = scValToNative(result) as unknown[];
    return native.map(String);
  }

  /**
   * Queries the latest Net Asset Value (NAV) of the vault from configured oracles.
   *
   * @throws NavRefusalError if the oracle reports a stale price or source divergence.
   */
  async nav(): Promise<VaultNav> {
    try {
      const result = await this.simulateReadOnly("nav", []);
      const native = scValToNative(result) as Record<string, unknown>;
      return {
        nav: BigInt(String(native["nav"] ?? 0)),
        ledger: Number(native["ledger"] ?? 0),
        source: String(native["source"] ?? "oracle"),
      };
    } catch (err: unknown) {
      const msg = (err as Error).message;
      if (msg.includes("OracleStale") || msg.includes("stale")) {
        throw new NavRefusalError("Oracle price is stale", "oracle", VaultErrorCode.OracleStale);
      }
      if (msg.includes("OracleDivergence") || msg.includes("divergence")) {
        throw new NavRefusalError("Oracle sources diverged beyond threshold", "multi-source", VaultErrorCode.OracleDivergence);
      }
      throw err;
    }
  }

  /**
   * Queries the latest Net Asset Value per fractional share.
   *
   * @throws NavRefusalError if the oracle valuation is unavailable or refused.
   */
  async navPerShare(): Promise<VaultNavPerShare> {
    try {
      const result = await this.simulateReadOnly("nav_per_share", []);
      const native = scValToNative(result) as Record<string, unknown>;
      return {
        navPerShare: BigInt(String(native["nav_per_share"] ?? 0)),
        ledger: Number(native["ledger"] ?? 0),
        source: String(native["source"] ?? "oracle"),
      };
    } catch (err: unknown) {
      const msg = (err as Error).message;
      if (msg.includes("OracleStale") || msg.includes("stale")) {
        throw new NavRefusalError("Oracle price is stale", "oracle", VaultErrorCode.OracleStale);
      }
      if (msg.includes("OracleDivergence") || msg.includes("divergence")) {
        throw new NavRefusalError("Oracle sources diverged beyond threshold", "multi-source", VaultErrorCode.OracleDivergence);
      }
      throw err;
    }
  }

  /** Historical snapshot balance of `holderAddress` at ledger `ledger` (FR-07-2). */
  async balanceAt(holderAddress: string, ledger: number): Promise<bigint> {
    const result = await this.simulateReadOnly("balance_at", [
      nativeToScVal(holderAddress, { type: "address" }),
      nativeToScVal(ledger, { type: "u32" }),
    ]);
    return scValToNative(result) as bigint;
  }

  /** Historical snapshot total supply of shares at ledger `ledger` (FR-07-3). */
  async totalSupplyAt(ledger: number): Promise<bigint> {
    const result = await this.simulateReadOnly("total_supply_at", [
      nativeToScVal(ledger, { type: "u32" }),
    ]);
    return scValToNative(result) as bigint;
  }

  // ── Write operations ───────────────────────────────────────────────────────

  /**
   * Builds a transaction depositing `amount` underlying RWA tokens to mint fractional shares.
   */
  async buildDepositTx(depositor: string, amount: bigint): Promise<Transaction> {
    return this.buildWriteTx(depositor, "deposit", [
      nativeToScVal(depositor, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ]);
  }

  /** Deposits `amount` underlying tokens and submits the transaction. */
  async deposit(depositor: string, amount: bigint): Promise<TxResult> {
    return this.submit(await this.buildDepositTx(depositor, amount), depositor);
  }

  /**
   * Builds a transaction redeeming `shares` fractional shares for underlying RWA tokens.
   */
  async buildRedeemTx(redeemer: string, shares: bigint): Promise<Transaction> {
    return this.buildWriteTx(redeemer, "redeem", [
      nativeToScVal(redeemer, { type: "address" }),
      nativeToScVal(shares, { type: "i128" }),
    ]);
  }

  /** Redeems `shares` fractional shares and submits the transaction. */
  async redeem(redeemer: string, shares: bigint): Promise<TxResult> {
    return this.submit(await this.buildRedeemTx(redeemer, shares), redeemer);
  }

  /** Builds a transaction transferring `amount` fractional shares from `from` to `to`. */
  async buildTransferTx(from: string, to: string, amount: bigint): Promise<Transaction> {
    return this.buildWriteTx(from, "transfer", [
      nativeToScVal(from, { type: "address" }),
      nativeToScVal(to, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ]);
  }

  /** Transfers `amount` fractional shares and submits the transaction. */
  async transfer(from: string, to: string, amount: bigint): Promise<TxResult> {
    return this.submit(await this.buildTransferTx(from, to, amount), from);
  }

  /** Builds a transaction setting `spender`'s allowance over `owner`'s shares. */
  async buildApproveTx(
    owner: string,
    spender: string,
    amount: bigint,
    liveUntilLedger: number,
  ): Promise<Transaction> {
    return this.buildWriteTx(owner, "approve", [
      nativeToScVal(owner, { type: "address" }),
      nativeToScVal(spender, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
      nativeToScVal(liveUntilLedger, { type: "u32" }),
    ]);
  }

  /** Sets `spender`'s allowance and submits the transaction. */
  async approve(
    owner: string,
    spender: string,
    amount: bigint,
    liveUntilLedger: number,
  ): Promise<TxResult> {
    return this.submit(await this.buildApproveTx(owner, spender, amount, liveUntilLedger), owner);
  }

  /** Builds a transaction transferring `amount` shares using delegated allowance. */
  async buildTransferFromTx(
    spender: string,
    from: string,
    to: string,
    amount: bigint,
  ): Promise<Transaction> {
    return this.buildWriteTx(spender, "transfer_from", [
      nativeToScVal(spender, { type: "address" }),
      nativeToScVal(from, { type: "address" }),
      nativeToScVal(to, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ]);
  }

  /** Transfers shares via allowance and submits the transaction. */
  async transferFrom(
    spender: string,
    from: string,
    to: string,
    amount: bigint,
  ): Promise<TxResult> {
    return this.submit(await this.buildTransferFromTx(spender, from, to, amount), spender);
  }

  /** Builds an admin transaction pausing or unpausing the vault. */
  async buildSetPausedTx(admin: string, paused: boolean): Promise<Transaction> {
    return this.buildWriteTx(admin, "set_paused", [
      nativeToScVal(admin, { type: "address" }),
      nativeToScVal(paused, { type: "bool" }),
    ]);
  }

  /** Sets the paused state and submits the transaction. */
  async setPaused(admin: string, paused: boolean): Promise<TxResult> {
    return this.submit(await this.buildSetPausedTx(admin, paused), admin);
  }

  /** Builds an admin transaction updating authorized oracle adapter contracts. */
  async buildSetOraclesTx(admin: string, oracles: string[]): Promise<Transaction> {
    return this.buildWriteTx(admin, "set_oracles", [
      nativeToScVal(admin, { type: "address" }),
      xdr.ScVal.scvVec(oracles.map((o) => nativeToScVal(o, { type: "address" }))),
    ]);
  }

  /** Updates authorized oracle contracts and submits the transaction. */
  async setOracles(admin: string, oracles: string[]): Promise<TxResult> {
    return this.submit(await this.buildSetOraclesTx(admin, oracles), admin);
  }

  // ── Sponsored writes ───────────────────────────────────────────────────────

  /**
   * Builds an unsigned sponsored deposit transaction.
   * Sourced and paid for by `feeSource`, while `depositor` authorizes the deposit
   * and underlying token transfer tree.
   *
   * @example
   * ```ts
   * const sponsored = await vault.buildSponsoredDepositTx(userAddress, 10_000_000n, { feeSource: relayerAddress });
   * const signedAuth = await authorizeEntries(sponsored.authEntries, userKeypair, expiryLedger, networkPassphrase);
   * const tx = await client.finalizeSponsoredTx(sponsored, signedAuth);
   * await client.submitSponsoredTx(tx);
   * ```
   */
  async buildSponsoredDepositTx(
    depositor: string,
    amount: bigint,
    { feeSource }: { feeSource: string },
  ): Promise<SponsoredTransaction> {
    return this.buildSponsoredWriteTx(feeSource, "deposit", [
      nativeToScVal(depositor, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ]);
  }

  /** Builds an unsigned sponsored redemption transaction. */
  async buildSponsoredRedeemTx(
    redeemer: string,
    shares: bigint,
    { feeSource }: { feeSource: string },
  ): Promise<SponsoredTransaction> {
    return this.buildSponsoredWriteTx(feeSource, "redeem", [
      nativeToScVal(redeemer, { type: "address" }),
      nativeToScVal(shares, { type: "i128" }),
    ]);
  }

  /** Builds an unsigned sponsored transfer transaction for fractional shares. */
  async buildSponsoredTransferTx(
    from: string,
    to: string,
    amount: bigint,
    { feeSource }: { feeSource: string },
  ): Promise<SponsoredTransaction> {
    return this.buildSponsoredWriteTx(feeSource, "transfer", [
      nativeToScVal(from, { type: "address" }),
      nativeToScVal(to, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ]);
  }

  /** Builds an unsigned sponsored transferFrom transaction. */
  async buildSponsoredTransferFromTx(
    spender: string,
    from: string,
    to: string,
    amount: bigint,
    { feeSource }: { feeSource: string },
  ): Promise<SponsoredTransaction> {
    return this.buildSponsoredWriteTx(feeSource, "transfer_from", [
      nativeToScVal(spender, { type: "address" }),
      nativeToScVal(from, { type: "address" }),
      nativeToScVal(to, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ]);
  }
}
