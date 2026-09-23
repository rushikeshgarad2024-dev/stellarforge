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
 *
 * Fully supports:
 * 1. `@stellar/stellar-sdk` `rpc.Api.EventResponse` from `server.getEvents()` (`topic: xdr.ScVal[]`, `value: xdr.ScVal`).
 * 2. `@stellar/stellar-sdk` `rpc.Api.RawEventResponse` (`topic?: string[]` base64 XDR, `value: string` base64 XDR).
 * 3. Soroban `xdr.ContractEvent` or `xdr.DiagnosticEvent` directly.
 * 4. Custom/simulated event objects with string or ScVal topics and values.
 *
 * Returns `{ type: "unknown" }` rather than throwing if the event does not match
 * expected vault schemas.
 *
 * @param event - The contract event (from RPC getEvents, simulation, or XDR).
 * @returns Discriminated union of typed vault events.
 */
export function decodeVaultEvent(event: unknown): VaultEvent {
  try {
    if (!event || typeof event !== "object") {
      return { type: "unknown", raw: event };
    }

    const raw = event as Record<string, unknown>;
    const ledger = typeof raw["ledger"] === "number" ? raw["ledger"] : 0;

    // 1. Extract raw topics and raw value from either EventResponse, RawEventResponse, or ContractEvent
    let rawTopics: unknown[] = [];
    let rawValue: unknown = undefined;

    const contractEvent =
      (raw["event"] as { body?: xdr.ContractEventBody } | undefined) ??
      (raw as { body?: xdr.ContractEventBody });
    if (contractEvent?.body?.v0) {
      rawTopics = contractEvent.body.v0.topics;
      rawValue = contractEvent.body.v0.data;
    } else if (Array.isArray(raw["topic"])) {
      rawTopics = raw["topic"];
      rawValue = raw["value"];
    } else if (Array.isArray(raw["topics"])) {
      rawTopics = raw["topics"];
      rawValue = raw["value"] ?? raw["data"];
    }

    if (rawTopics.length === 0) {
      return { type: "unknown", raw: event };
    }

    // 2. Normalize each topic to native JS (strings, addresses, symbols)
    const topics: unknown[] = rawTopics.map((t: unknown) => {
      if (t instanceof xdr.ScVal || (t && typeof (t as { switch?: unknown }).switch === "function")) {
        try {
          return scValToNative(t as xdr.ScVal);
        } catch {
          return t;
        }
      }
      if (typeof t === "string") {
        try {
          const scv = xdr.ScVal.fromXdr(t, "base64");
          return scValToNative(scv);
        } catch {
          return t;
        }
      }
      return t;
    });

    // 3. Normalize value to native JS
    let nativeVal: unknown = undefined;
    if (rawValue instanceof xdr.ScVal || (rawValue && typeof (rawValue as { switch?: unknown }).switch === "function")) {
      try {
        nativeVal = scValToNative(rawValue as xdr.ScVal);
      } catch {
        nativeVal = rawValue;
      }
    } else if (typeof rawValue === "string") {
      try {
        const scv = xdr.ScVal.fromXdr(rawValue, "base64");
        nativeVal = scValToNative(scv);
      } catch {
        nativeVal = rawValue;
      }
    } else if (rawValue && typeof (rawValue as { xdr?: unknown }).xdr === "string") {
      try {
        const scv = xdr.ScVal.fromXdr((rawValue as { xdr: string }).xdr, "base64");
        nativeVal = scValToNative(scv);
      } catch {
        nativeVal = rawValue;
      }
    } else {
      nativeVal = rawValue;
    }

    const topic0 = String(topics[0] ?? "");

    // ─── Transfer Event (SEP-41) ─────────────────────────────────────────────
    // Topics: ["transfer", from, to]
    if (topic0 === "transfer" && topics.length >= 3) {
      const from = String(topics[1] ?? "");
      const to = String(topics[2] ?? "");
      let amount = 0n;
      if (typeof nativeVal === "bigint") {
        amount = nativeVal;
      } else if (typeof nativeVal === "number") {
        amount = BigInt(nativeVal);
      } else if (nativeVal && typeof nativeVal === "object") {
        const valObj = nativeVal as Record<string, unknown>;
        if (typeof valObj["amount"] === "bigint") {
          amount = valObj["amount"];
        } else if (typeof valObj["amount"] === "number" || typeof valObj["amount"] === "string") {
          amount = BigInt(valObj["amount"]);
        }
      }
      return { type: "transfer", from, to, amount, ledger };
    }

    // ─── Approve Event (SEP-41) ──────────────────────────────────────────────
    // Topics: ["approve", from/owner, spender]
    if (topic0 === "approve" && topics.length >= 3) {
      const from = String(topics[1] ?? "");
      const spender = String(topics[2] ?? "");
      let amount = 0n;
      let liveUntilLedger = 0;
      if (Array.isArray(nativeVal)) {
        amount = typeof nativeVal[0] === "bigint" ? nativeVal[0] : BigInt(nativeVal[0] ?? 0);
        liveUntilLedger = Number(nativeVal[1] ?? 0);
      } else if (nativeVal && typeof nativeVal === "object") {
        const valObj = nativeVal as Record<string, unknown>;
        amount =
          typeof valObj["amount"] === "bigint"
            ? valObj["amount"]
            : BigInt((valObj["amount"] as string | number) ?? 0);
        liveUntilLedger = Number(valObj["live_until_ledger"] ?? valObj["liveUntilLedger"] ?? 0);
      }
      return { type: "approve", from, spender, amount, liveUntilLedger, ledger };
    }

    // ─── Vault Events ────────────────────────────────────────────────────────
    // Topics: ["Vault", action, ...] or [action, ...]
    const isVaultNamespace = topic0 === "Vault";
    const action = isVaultNamespace ? String(topics[1] ?? "") : topic0;
    const dataObj =
      (nativeVal && typeof nativeVal === "object" ? nativeVal : {}) as Record<string, unknown>;

    if (action === "deposit") {
      const caller = String(dataObj["caller"] ?? (isVaultNamespace ? topics[2] : topics[1]) ?? "");
      const depositor = String(dataObj["depositor"] ?? (isVaultNamespace ? topics[2] : topics[1]) ?? "");
      const assets =
        typeof dataObj["assets"] === "bigint"
          ? dataObj["assets"]
          : BigInt(String(dataObj["assets"] ?? 0));
      const shares =
        typeof dataObj["shares"] === "bigint"
          ? dataObj["shares"]
          : BigInt(String(dataObj["shares"] ?? 0));
      return { type: "deposit", caller, depositor, assets, shares, ledger };
    }

    if (action === "redeem") {
      const caller = String(dataObj["caller"] ?? (isVaultNamespace ? topics[2] : topics[1]) ?? "");
      const redeemer = String(dataObj["redeemer"] ?? (isVaultNamespace ? topics[2] : topics[1]) ?? "");
      const shares =
        typeof dataObj["shares"] === "bigint"
          ? dataObj["shares"]
          : BigInt(String(dataObj["shares"] ?? 0));
      const assets =
        typeof dataObj["assets"] === "bigint"
          ? dataObj["assets"]
          : BigInt(String(dataObj["assets"] ?? 0));
      return { type: "redeem", caller, redeemer, shares, assets, ledger };
    }

    if (action === "set_paused" || action === "paused") {
      const admin = String(dataObj["admin"] ?? "");
      const paused = typeof nativeVal === "boolean" ? nativeVal : Boolean(dataObj["paused"]);
      return { type: "set_paused", admin, paused, ledger };
    }

    if (action === "set_oracles") {
      const admin = String(dataObj["admin"] ?? "");
      const oracles = Array.isArray(dataObj["oracles"]) ? dataObj["oracles"].map(String) : [];
      return { type: "set_oracles", admin, oracles, ledger };
    }

    return { type: "unknown", raw: event };
  } catch {
    return { type: "unknown", raw: event };
  }
}

/**
 * Decodes all events from an RPC `getEvents` response or an event collection into an array of `VaultEvent`.
 *
 * Accepts:
 * - `rpc.Api.GetEventsResponse` or `rpc.Api.RawGetEventsResponse` (`{ events: EventResponse[] }`)
 * - An array of events (`EventResponse[]` or `RawEventResponse[]`)
 * - A transaction result containing `events`
 *
 * @param getEventsResponse - The response object returned by `server.getEvents()` or array of events.
 * @returns Array of decoded vault events.
 */
export function decodeVaultEvents(getEventsResponse: unknown): VaultEvent[] {
  if (!getEventsResponse) {
    return [];
  }
  if (Array.isArray(getEventsResponse)) {
    return getEventsResponse.map(decodeVaultEvent);
  }
  const resp = getEventsResponse as { events?: unknown[] };
  if (resp && Array.isArray(resp.events)) {
    return resp.events.map(decodeVaultEvent);
  }
  return [];
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
