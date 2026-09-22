import { Address, authorizeEntry, scValToNative, xdr } from "@stellar/stellar-sdk";

import type { Keypair, Transaction } from "@stellar/stellar-sdk";

/**
 * Writes sourced and paid for by one account while a different address
 * authorizes the contract call (#31).
 *
 * The flow, which may span machines:
 *
 * 1. The fee payer builds the call with a `buildSponsored*Tx` method. The
 *    result carries the unsigned authorization entries and, for each one, the
 *    address that must sign it.
 * 2. Each authorizer signs its entries with {@link authorizeEntries}, choosing
 *    the ledger the signature expires at. Entries travel as base64 through
 *    {@link authEntriesToXdr} and {@link authEntriesFromXdr}.
 * 3. The fee payer passes the signed entries to `finalizeSponsoredTx`, then
 *    signs and submits the result, or calls `submitSponsoredTx` to do both.
 *
 * Every authorizer that is an account must already exist on the network. An
 * account authorizes through the signers and thresholds in its ledger entry,
 * so an address that was never funded cannot authorize anything, even though
 * it never pays a fee.
 */

/**
 * The expiry ledger to aim for when signing entries: about five minutes ahead
 * at the five-second ledger target. That covers passing entries between
 * machines plus the transaction's own 180-second window.
 */
export const DEFAULT_AUTH_VALIDITY_LEDGERS = 60;

/**
 * The furthest ahead a signed entry may expire when finalized: about one day.
 * Until it expires, whoever holds a signed entry can submit it once, so a
 * standing authorization is refused rather than accepted.
 */
export const MAX_AUTH_VALIDITY_LEDGERS = 17_280;

/**
 * The fewest ledgers a signed entry must still have left when finalized: the
 * 180-second transaction window at five seconds a ledger, plus a margin. An
 * entry expiring sooner could lapse before the transaction is included.
 */
export const MIN_AUTH_REMAINING_LEDGERS = 40;

/** An invocation built for a fee payer, waiting for its authorizers to sign. */
export interface SponsoredTransaction {
  /** The invocation, sourced by the fee payer, with no authorization attached. */
  transaction: Transaction;
  /** Every authorization entry the simulated call requires, in order. */
  authEntries: xdr.SorobanAuthorizationEntry[];
  /**
   * The address that must sign each entry in `authEntries`, or `null` where the
   * fee payer's own transaction signature covers it.
   */
  authorizers: (string | null)[];
}

/** The credentials of an entry some address must sign, or `null` if the source's signature covers it. */
function addressCredentials(
  entry: xdr.SorobanAuthorizationEntry,
): xdr.SorobanAddressCredentials | null {
  const credentials = entry.credentials;
  switch (credentials.type) {
    case "sorobanCredentialsAddressV2":
      return credentials.addressV2;
    case "sorobanCredentialsAddress":
      return credentials.address;
    case "sorobanCredentialsSourceAccount":
      return null;
    default:
      throw new Error(`Unsupported authorization credentials: ${credentials.type}`);
  }
}

/**
 * The address that must sign `entry`, or `null` when the transaction source's
 * signature authorizes it.
 */
export function authEntryAddress(entry: xdr.SorobanAuthorizationEntry): string | null {
  const credentials = addressCredentials(entry);
  return credentials === null ? null : Address.fromScAddress(credentials.address).toString();
}

/**
 * Signs the entries `signer` must authorize, valid through `validUntilLedger`,
 * and returns every entry in order: signed where the signer is the authorizer,
 * unchanged otherwise. Pass the result to the next authorizer, if there is one.
 *
 * `authorizeEntry` signs with whatever key it is given, and a mismatch only
 * surfaces when the network rejects the transaction. This refuses a signer that
 * none of the entries name instead.
 */
export async function authorizeEntries(
  entries: readonly xdr.SorobanAuthorizationEntry[],
  signer: Keypair,
  validUntilLedger: number,
  networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  if (!Number.isInteger(validUntilLedger) || validUntilLedger <= 0) {
    throw new RangeError(`validUntilLedger must be a positive ledger sequence, got ${validUntilLedger}`);
  }
  const publicKey = signer.publicKey();
  const authorizers = entries.map(authEntryAddress);
  if (!authorizers.includes(publicKey)) {
    const named = [...new Set(authorizers.filter((a): a is string => a !== null))];
    throw new Error(
      `${publicKey} is not asked to authorize any of these entries. ` +
        `They must be signed by: ${named.join(", ") || "nobody (the fee payer's signature covers them)"}`,
    );
  }
  return Promise.all(
    entries.map((entry, i) =>
      authorizers[i] === publicKey
        ? authorizeEntry(entry, signer, validUntilLedger, networkPassphrase)
        : entry,
    ),
  );
}

/** Encodes entries as base64 XDR, for passing to an authorizer on another machine. */
export function authEntriesToXdr(entries: readonly xdr.SorobanAuthorizationEntry[]): string[] {
  return entries.map((entry) => entry.toXdr("base64"));
}

/** Decodes entries encoded by {@link authEntriesToXdr}. */
export function authEntriesFromXdr(encoded: readonly string[]): xdr.SorobanAuthorizationEntry[] {
  return encoded.map((value) => xdr.SorobanAuthorizationEntry.fromXdr(value, "base64"));
}

/**
 * Recursively verifies that `signed` matches `original` throughout the entire
 * authorization invocation tree: contract address, function name, arguments,
 * and all sub-invocations. Refuses any difference with an error naming the differing node.
 */
export function checkInvocationTree(
  original: xdr.SorobanAuthorizedInvocation,
  signed: xdr.SorobanAuthorizedInvocation,
  nodePath = "rootInvocation",
): void {
  const origFn = original.function;
  const signedFn = signed.function;

  if (origFn.type !== signedFn.type) {
    throw new Error(
      `Authorization tree differs at ${nodePath}: function type mismatch (expected ${origFn.type}, got ${signedFn.type})`,
    );
  }

  if (origFn.type === "sorobanAuthorizedFunctionTypeContractFn" && signedFn.type === "sorobanAuthorizedFunctionTypeContractFn") {
    const origContractFn = origFn.contractFn;
    const signedContractFn = signedFn.contractFn;

    if (!origContractFn.contractAddress.equals(signedContractFn.contractAddress)) {
      const expectedAddr = Address.fromScAddress(origContractFn.contractAddress).toString();
      const actualAddr = Address.fromScAddress(signedContractFn.contractAddress).toString();
      throw new Error(
        `Authorization tree differs at ${nodePath}.contractAddress: expected ${expectedAddr}, got ${actualAddr}`,
      );
    }

    const origName = origContractFn.functionName.toString();
    const signedName = signedContractFn.functionName.toString();
    if (origName !== signedName) {
      throw new Error(
        `Authorization tree differs at ${nodePath}.functionName: expected "${origName}", got "${signedName}"`,
      );
    }

    const origArgs = origContractFn.args;
    const signedArgs = signedContractFn.args;
    if (origArgs.length !== signedArgs.length) {
      throw new Error(
        `Authorization tree differs at ${nodePath}.args: count mismatch (expected ${origArgs.length}, got ${signedArgs.length})`,
      );
    }

    for (let i = 0; i < origArgs.length; i++) {
      const origArg = origArgs[i];
      const signedArg = signedArgs[i];
      if (origArg && signedArg && !origArg.equals(signedArg)) {
        throw new Error(
          `Authorization tree differs at ${nodePath}.args[${i}]: argument mismatch`,
        );
      }
    }
  } else if (!origFn.equals(signedFn)) {
    throw new Error(`Authorization tree differs at ${nodePath}.function: function mismatch`);
  }

  const origSubs = original.subInvocations;
  const signedSubs = signed.subInvocations;
  if (origSubs.length !== signedSubs.length) {
    throw new Error(
      `Authorization tree differs at ${nodePath}.subInvocations: count mismatch (expected ${origSubs.length}, got ${signedSubs.length})`,
    );
  }

  for (let i = 0; i < origSubs.length; i++) {
    const origSub = origSubs[i];
    const signedSub = signedSubs[i];
    if (origSub && signedSub) {
      checkInvocationTree(origSub, signedSub, `${nodePath}.subInvocations[${i}]`);
    }
  }
}

/**
 * Formats a SorobanAuthorizedInvocation into a human-readable string.
 */
function describeInvocation(inv: xdr.SorobanAuthorizedInvocation, prefix = "", isLast = true): string[] {
  const lines: string[] = [];
  const fn = inv.function;
  let callDesc = "unknown";

  if (fn.type === "sorobanAuthorizedFunctionTypeContractFn") {
    const contractFn = fn.contractFn;
    const contractId = Address.fromScAddress(contractFn.contractAddress).toString();
    const fnName = contractFn.functionName.toString();
    const args = contractFn.args.map((arg) => {
      try {
        const native = scValToNative(arg);
        if (typeof native === "bigint") return `${native.toString()}n`;
        return JSON.stringify(native);
      } catch {
        return arg.toXdr("base64");
      }
    });
    callDesc = `${contractId}.${fnName}(${args.join(", ")})`;
  } else {
    callDesc = fn.type;
  }

  const branch = isLast ? "└── " : "├── ";
  lines.push(`${prefix}${branch}${callDesc}`);

  const nextPrefix = prefix + (isLast ? "    " : "│   ");
  const subInvs = inv.subInvocations;
  for (let i = 0; i < subInvs.length; i++) {
    const sub = subInvs[i];
    if (sub) {
      lines.push(...describeInvocation(sub, nextPrefix, i === subInvs.length - 1));
    }
  }

  return lines;
}

/**
 * Returns a human-readable tree representation of an authorization entry,
 * enabling wallets and users to inspect the full multi-contract call tree before signing.
 *
 * @param entry - The authorization entry to describe.
 * @returns Human-readable formatted string representing authorizer and invocation tree.
 */
export function describeAuthTree(entry: xdr.SorobanAuthorizationEntry): string {
  const authorizer = authEntryAddress(entry) ?? "source account";
  const lines: string[] = [`Authorizer: ${authorizer}`];

  const rootInv = entry.rootInvocation;
  const fn = rootInv.function;
  let rootDesc = "unknown";

  if (fn.type === "sorobanAuthorizedFunctionTypeContractFn") {
    const contractFn = fn.contractFn;
    const contractId = Address.fromScAddress(contractFn.contractAddress).toString();
    const fnName = contractFn.functionName.toString();
    const args = contractFn.args.map((arg) => {
      try {
        const native = scValToNative(arg);
        if (typeof native === "bigint") return `${native.toString()}n`;
        return JSON.stringify(native);
      } catch {
        return arg.toXdr("base64");
      }
    });
    rootDesc = `${contractId}.${fnName}(${args.join(", ")})`;
  } else {
    rootDesc = fn.type;
  }

  lines.push(`Root: ${rootDesc}`);

  const subInvs = rootInv.subInvocations;
  for (let i = 0; i < subInvs.length; i++) {
    const sub = subInvs[i];
    if (sub) {
      lines.push(...describeInvocation(sub, "", i === subInvs.length - 1));
    }
  }

  return lines.join("\n");
}

/**
 * Checks a signed entry against the unsigned one it should be a signed copy of.
 * Signature validity itself is left to the network: simulating the finalized
 * transaction rejects a signature made with the wrong key.
 */
export function checkSignedAuthEntry(
  original: xdr.SorobanAuthorizationEntry,
  signed: xdr.SorobanAuthorizationEntry,
  latestLedger: number,
  index: number,
): void {
  const address = authEntryAddress(original);
  if (address === null) {
    if (!signed.equals(original)) {
      throw new Error(`Authorization entry ${index} is covered by the fee payer and must be passed back unchanged`);
    }
    return;
  }

  try {
    checkInvocationTree(original.rootInvocation, signed.rootInvocation, "rootInvocation");
  } catch (err: unknown) {
    throw new Error(
      `Authorization entry ${index} authorizes a different invocation than the one built: ${(err as Error).message}`,
    );
  }

  const signedAddress = authEntryAddress(signed);
  if (signedAddress !== address) {
    throw new Error(`Authorization entry ${index} is for ${signedAddress ?? "the source account"}, not ${address}`);
  }

  const originalCredentials = addressCredentials(original) as xdr.SorobanAddressCredentials;
  const signedCredentials = addressCredentials(signed) as xdr.SorobanAddressCredentials;
  if (signedCredentials.nonce !== originalCredentials.nonce) {
    throw new Error(`Authorization entry ${index} for ${address} carries a different nonce than the one built`);
  }
  if (signedCredentials.signature.type === "scvVoid") {
    throw new Error(`Authorization entry ${index} for ${address} is not signed`);
  }

  const expiry = signedCredentials.signatureExpirationLedger;
  if (expiry < latestLedger + MIN_AUTH_REMAINING_LEDGERS) {
    throw new Error(
      `Authorization entry ${index} for ${address} expires at ledger ${expiry}, but the latest ledger is ` +
        `${latestLedger} and at least ${MIN_AUTH_REMAINING_LEDGERS} ledgers must remain. Sign it again with a later expiry.`,
    );
  }
  if (expiry > latestLedger + MAX_AUTH_VALIDITY_LEDGERS) {
    throw new Error(
      `Authorization entry ${index} for ${address} expires at ledger ${expiry}, more than ` +
        `${MAX_AUTH_VALIDITY_LEDGERS} ledgers after the latest (${latestLedger}). Sign it again with a nearer expiry.`,
    );
  }
}

