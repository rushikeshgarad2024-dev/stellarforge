import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  Account,
  Address,
  Keypair,
  nativeToScVal,
  rpc,
  SorobanDataBuilder,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";

import {
  VaultClient,
  VaultErrorCode,
  NavRefusalError,
  sharesForDeposit,
  underlyingForRedeem,
  maxRedeemable,
  decodeVaultEvent,
  decodeVaultEvents,
} from "../src/vault.js";
import {
  authorizeEntries,
  describeAuthTree,
} from "../src/sponsored.js";
import {
  RWA_ID,
  SIGNER as FEE_PAYER,
  SIGNER_SECRET as FEE_PAYER_SECRET,
  SUBMITTED_HASH,
  configWith,
  stubSimulation,
  stubWritePath,
  succeeds,
  fails,
  builtInvocation,
  invocationArgs,
} from "./helpers.js";

const VAULT_ID = StrKey.encodeContract(Buffer.alloc(32, 10));
const DEPOSITOR_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11));
const DEPOSITOR = DEPOSITOR_KP.publicKey();
const RECIPIENT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 12));
const SPENDER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 13));
const ORACLE_ID = StrKey.encodeContract(Buffer.alloc(32, 14));

const vaultConfig = configWith(
  { vault: VAULT_ID, rwaAsset: RWA_ID },
  FEE_PAYER_SECRET,
);

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── 1. Pure Rounding Helpers & 50+ Committed Cases ────────────────────────────

describe("Rounding helpers: 50+ committed test table", () => {
  // 50+ test case table covering:
  // - Rate 1
  // - Small, medium, large, and 10^18 exchange rates
  // - Exact multiples and non-multiples
  // - i128::MAX edge cases and zero amounts
  const roundingTable = [
    // Rate 1
    { assets: 0n, rate: 1n, shares: 0n },
    { assets: 1n, rate: 1n, shares: 1n },
    { assets: 2n, rate: 1n, shares: 2n },
    { assets: 10n, rate: 1n, shares: 10n },
    { assets: 100n, rate: 1n, shares: 100n },
    { assets: 10_000_000n, rate: 1n, shares: 10_000_000n },
    { assets: 1_000_000_000_000n, rate: 1n, shares: 1_000_000_000_000n },

    // Rate 2
    { assets: 1n, rate: 2n, shares: 2n },
    { assets: 5n, rate: 2n, shares: 10n },
    { assets: 50n, rate: 2n, shares: 100n },
    { assets: 500_000n, rate: 2n, shares: 1_000_000n },

    // Rate 5
    { assets: 1n, rate: 5n, shares: 5n },
    { assets: 3n, rate: 5n, shares: 15n },
    { assets: 20n, rate: 5n, shares: 100n },
    { assets: 200_000n, rate: 5n, shares: 1_000_000n },

    // Rate 10
    { assets: 1n, rate: 10n, shares: 10n },
    { assets: 7n, rate: 10n, shares: 70n },
    { assets: 123n, rate: 10n, shares: 1230n },
    { assets: 10_000n, rate: 10n, shares: 100_000n },

    // Rate 100
    { assets: 1n, rate: 100n, shares: 100n },
    { assets: 42n, rate: 100n, shares: 4200n },
    { assets: 999n, rate: 100n, shares: 99900n },

    // Rate 1,000
    { assets: 1n, rate: 1000n, shares: 1000n },
    { assets: 55n, rate: 1000n, shares: 55000n },
    { assets: 10_000n, rate: 1000n, shares: 10_000_000n },

    // Rate 7 (prime rate)
    { assets: 1n, rate: 7n, shares: 7n },
    { assets: 11n, rate: 7n, shares: 77n },
    { assets: 49n, rate: 7n, shares: 343n },

    // Rate 13 (prime rate)
    { assets: 1n, rate: 13n, shares: 13n },
    { assets: 10n, rate: 13n, shares: 130n },
    { assets: 100n, rate: 13n, shares: 1300n },

    // Rate 10,000,000 (1:1 Stroop rate)
    { assets: 1n, rate: 10_000_000n, shares: 10_000_000n },
    { assets: 5n, rate: 10_000_000n, shares: 50_000_000n },
    { assets: 123n, rate: 10_000_000n, shares: 1_230_000_000n },

    // Large rates
    { assets: 10n, rate: 1_000_000_000n, shares: 10_000_000_000n },
    { assets: 100n, rate: 1_000_000_000n, shares: 100_000_000_000n },
    { assets: 1n, rate: 1_000_000_000_000_000_000n, shares: 1_000_000_000_000_000_000n },
    { assets: 2n, rate: 1_000_000_000_000_000_000n, shares: 2_000_000_000_000_000_000n },

    // i128-sized values
    { assets: 1701411834604692317316873037158841057n, rate: 1n, shares: 1701411834604692317316873037158841057n },
    { assets: 850705917302346158658436518579420528n, rate: 2n, shares: 1701411834604692317316873037158841056n },
    { assets: 1701411834604692317316873037158841n, rate: 1000n, shares: 1701411834604692317316873037158841000n },

    // Additional boundary and fractionalization cases
    { assets: 3n, rate: 333n, shares: 999n },
    { assets: 4n, rate: 250n, shares: 1000n },
    { assets: 8n, rate: 125n, shares: 1000n },
    { assets: 16n, rate: 625n, shares: 10000n },
    { assets: 32n, rate: 3125n, shares: 100000n },
    { assets: 64n, rate: 15625n, shares: 1000000n },
    { assets: 128n, rate: 78125n, shares: 10000000n },
    { assets: 256n, rate: 390625n, shares: 100000000n },
    { assets: 512n, rate: 1953125n, shares: 1000000000n },
    { assets: 1024n, rate: 9765625n, shares: 10000000000n },
  ];

  it(`contains at least 50 test cases (actual: ${roundingTable.length})`, () => {
    expect(roundingTable.length).toBeGreaterThanOrEqual(50);
  });

  it("sharesForDeposit and underlyingForRedeem roundtrip perfectly on all valid multiples", () => {
    for (const { assets, rate, shares } of roundingTable) {
      expect(sharesForDeposit(assets, rate)).toBe(shares);
      expect(underlyingForRedeem(shares, rate)).toBe(assets);
    }
  });

  it("underlyingForRedeem throws on non-multiples", () => {
    const nonMultiples = [
      { shares: 1n, rate: 2n },
      { shares: 3n, rate: 2n },
      { shares: 7n, rate: 5n },
      { shares: 11n, rate: 10n },
      { shares: 99n, rate: 100n },
      { shares: 1001n, rate: 1000n },
      { shares: 15n, rate: 7n },
    ];
    for (const { shares, rate } of nonMultiples) {
      expect(() => underlyingForRedeem(shares, rate)).toThrow(/must be an exact multiple/);
    }
  });

  it("validates negative inputs and invalid rates", () => {
    expect(() => sharesForDeposit(-1n, 1n)).toThrow(RangeError);
    expect(() => sharesForDeposit(10n, 0n)).toThrow(RangeError);
    expect(() => sharesForDeposit(10n, -5n)).toThrow(RangeError);

    expect(() => underlyingForRedeem(-10n, 2n)).toThrow(RangeError);
    expect(() => underlyingForRedeem(10n, 0n)).toThrow(RangeError);
    expect(() => underlyingForRedeem(10n, -2n)).toThrow(RangeError);
  });
});

describe("maxRedeemable helper", () => {
  it("returns balance when lock has expired or lockedUntil is 0", () => {
    expect(maxRedeemable(100n, 50, 100)).toBe(100n);
    expect(maxRedeemable(100n, 50, 50)).toBe(100n);
    expect(maxRedeemable(100n, 0, 10)).toBe(100n);
  });

  it("returns 0n when current ledger is before lockedUntil", () => {
    expect(maxRedeemable(100n, 100, 50)).toBe(0n);
    expect(maxRedeemable(5000n, 200, 199)).toBe(0n);
  });

  it("returns 0n when balance is 0", () => {
    expect(maxRedeemable(0n, 10, 20)).toBe(0n);
  });

  it("throws RangeError on negative balance", () => {
    expect(() => maxRedeemable(-1n, 10, 20)).toThrow(RangeError);
  });
});

// ─── 2. VaultClient Reads ──────────────────────────────────────────────────────

describe("VaultClient reads", () => {
  const client = new VaultClient(vaultConfig);

  it("decodes config", async () => {
    stubSimulation(
      succeeds(
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: nativeToScVal("admin", { type: "symbol" }),
            val: nativeToScVal(FEE_PAYER, { type: "address" }),
          }),
          new xdr.ScMapEntry({
            key: nativeToScVal("exchange_rate", { type: "symbol" }),
            val: nativeToScVal(10n, { type: "i128" }),
          }),
          new xdr.ScMapEntry({
            key: nativeToScVal("oracles", { type: "symbol" }),
            val: xdr.ScVal.scvVec([nativeToScVal(ORACLE_ID, { type: "address" })]),
          }),
          new xdr.ScMapEntry({
            key: nativeToScVal("paused", { type: "symbol" }),
            val: nativeToScVal(false, { type: "bool" }),
          }),
          new xdr.ScMapEntry({
            key: nativeToScVal("share_token", { type: "symbol" }),
            val: nativeToScVal(VAULT_ID, { type: "address" }),
          }),
          new xdr.ScMapEntry({
            key: nativeToScVal("supply_cap", { type: "symbol" }),
            val: nativeToScVal(1_000_000n, { type: "i128" }),
          }),
          new xdr.ScMapEntry({
            key: nativeToScVal("underlying", { type: "symbol" }),
            val: nativeToScVal(RWA_ID, { type: "address" }),
          }),
        ]),
      ),
    );

    const config = await client.config();
    expect(config.underlying).toBe(RWA_ID);
    expect(config.shareToken).toBe(VAULT_ID);
    expect(config.exchangeRate).toBe(10n);
    expect(config.supplyCap).toBe(1_000_000n);
    expect(config.paused).toBe(false);
    expect(config.admin).toBe(FEE_PAYER);
    expect(config.oracles).toEqual([ORACLE_ID]);
  });

  it("decodes underlyingHeld", async () => {
    stubSimulation(succeeds(nativeToScVal(500_000n, { type: "i128" })));
    expect(await client.underlyingHeld()).toBe(500_000n);
  });

  it("decodes balance", async () => {
    stubSimulation(succeeds(nativeToScVal(42_000n, { type: "i128" })));
    expect(await client.balance(DEPOSITOR)).toBe(42_000n);
  });

  it("decodes totalSupply", async () => {
    stubSimulation(succeeds(nativeToScVal(10_000_000n, { type: "i128" })));
    expect(await client.totalSupply()).toBe(10_000_000n);
  });

  it("decodes allowance", async () => {
    stubSimulation(succeeds(nativeToScVal(500n, { type: "i128" })));
    expect(await client.allowance(DEPOSITOR, SPENDER)).toBe(500n);
  });

  it("decodes decimals", async () => {
    stubSimulation(succeeds(nativeToScVal(7, { type: "u32" })));
    expect(await client.decimals()).toBe(7);
  });

  it("decodes name and symbol", async () => {
    stubSimulation(succeeds(nativeToScVal("RealEstateVault", { type: "string" })));
    expect(await client.name()).toBe("RealEstateVault");

    stubSimulation(succeeds(nativeToScVal("vREIT", { type: "string" })));
    expect(await client.symbol()).toBe("vREIT");
  });

  it("decodes lockedUntil and redeemable", async () => {
    stubSimulation(succeeds(nativeToScVal(1234, { type: "u32" })));
    expect(await client.lockedUntil(DEPOSITOR)).toBe(1234);

    stubSimulation(succeeds(nativeToScVal(50_000n, { type: "i128" })));
    expect(await client.redeemable(DEPOSITOR)).toBe(50_000n);
  });

  it("decodes paused and admin", async () => {
    stubSimulation(succeeds(nativeToScVal(false, { type: "bool" })));
    expect(await client.paused()).toBe(false);

    stubSimulation(succeeds(nativeToScVal(FEE_PAYER, { type: "address" })));
    expect(await client.admin()).toBe(FEE_PAYER);
  });

  it("decodes oracles list", async () => {
    stubSimulation(succeeds(xdr.ScVal.scvVec([nativeToScVal(ORACLE_ID, { type: "address" })])));
    expect(await client.oracles()).toEqual([ORACLE_ID]);
  });

  it("decodes nav and navPerShare", async () => {
    stubSimulation(
      succeeds(
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: nativeToScVal("nav", { type: "symbol" }),
            val: nativeToScVal(10_000_000_000n, { type: "i128" }),
          }),
          new xdr.ScMapEntry({
            key: nativeToScVal("ledger", { type: "symbol" }),
            val: nativeToScVal(5555, { type: "u32" }),
          }),
          new xdr.ScMapEntry({
            key: nativeToScVal("source", { type: "symbol" }),
            val: nativeToScVal(ORACLE_ID, { type: "string" }),
          }),
        ]),
      ),
    );

    const nav = await client.nav();
    expect(nav.nav).toBe(10_000_000_000n);
    expect(nav.ledger).toBe(5555);
    expect(nav.source).toBe(ORACLE_ID);
  });

  it("maps stale oracle error to NavRefusalError", async () => {
    stubSimulation(fails("OracleStale: price too old"));
    await expect(client.nav()).rejects.toThrow(NavRefusalError);
  });

  it("maps oracle divergence error to NavRefusalError", async () => {
    stubSimulation(fails("OracleDivergence: sources differ by > 5%"));
    await expect(client.navPerShare()).rejects.toThrow(NavRefusalError);
  });

  it("decodes balanceAt and totalSupplyAt historical snapshots", async () => {
    stubSimulation(succeeds(nativeToScVal(35_000n, { type: "i128" })));
    expect(await client.balanceAt(DEPOSITOR, 1000)).toBe(35_000n);

    stubSimulation(succeeds(nativeToScVal(9_000_000n, { type: "i128" })));
    expect(await client.totalSupplyAt(1000)).toBe(9_000_000n);
  });
});

// ─── 3. VaultClient Writes ─────────────────────────────────────────────────────

describe("VaultClient writes", () => {
  const client = new VaultClient(vaultConfig);

  it("buildDepositTx constructs exact contract args", async () => {
    stubWritePath();
    const tx = await client.buildDepositTx(FEE_PAYER, 5_000_000n);
    const op = builtInvocation(tx);
    expect(op.fn).toBe("deposit");
    expect(Address.fromScAddress(invocationArgs(tx).contractAddress).toString()).toBe(VAULT_ID);
    expect(op.args).toEqual([FEE_PAYER, 5_000_000n]);
  });

  it("deposit submits transaction", async () => {
    stubWritePath();
    const res = await client.deposit(FEE_PAYER, 5_000_000n);
    expect(res.hash).toBe(SUBMITTED_HASH);
    expect(res.ledger).toBe(42);
  });

  it("buildRedeemTx constructs exact contract args", async () => {
    stubWritePath();
    const tx = await client.buildRedeemTx(FEE_PAYER, 10_000_000n);
    const op = builtInvocation(tx);
    expect(op.fn).toBe("redeem");
    expect(op.args).toEqual([FEE_PAYER, 10_000_000n]);
  });

  it("buildTransferTx constructs exact contract args", async () => {
    stubWritePath();
    const tx = await client.buildTransferTx(FEE_PAYER, RECIPIENT, 1_000_000n);
    const op = builtInvocation(tx);
    expect(op.fn).toBe("transfer");
    expect(op.args).toEqual([FEE_PAYER, RECIPIENT, 1_000_000n]);
  });

  it("buildApproveTx constructs exact contract args", async () => {
    stubWritePath();
    const tx = await client.buildApproveTx(FEE_PAYER, SPENDER, 2_000_000n, 5000);
    const op = builtInvocation(tx);
    expect(op.fn).toBe("approve");
    expect(op.args).toEqual([FEE_PAYER, SPENDER, 2_000_000n, 5000]);
  });

  it("buildTransferFromTx constructs exact contract args", async () => {
    stubWritePath();
    const tx = await client.buildTransferFromTx(SPENDER, FEE_PAYER, RECIPIENT, 500_000n);
    const op = builtInvocation(tx);
    expect(op.fn).toBe("transfer_from");
    expect(op.args).toEqual([SPENDER, FEE_PAYER, RECIPIENT, 500_000n]);
  });

  it("buildSetPausedTx constructs exact contract args", async () => {
    stubWritePath();
    const tx = await client.buildSetPausedTx(FEE_PAYER, true);
    const op = builtInvocation(tx);
    expect(op.fn).toBe("set_paused");
    expect(op.args).toEqual([FEE_PAYER, true]);
  });

  it("buildSetOraclesTx constructs exact contract args", async () => {
    stubWritePath();
    const tx = await client.buildSetOraclesTx(FEE_PAYER, [ORACLE_ID]);
    const op = builtInvocation(tx);
    expect(op.fn).toBe("set_oracles");
    expect(op.args).toEqual([FEE_PAYER, [ORACLE_ID]]);
  });
});

// ─── 4. Auth-Tree Verification & describeAuthTree ─────────────────────────────

describe("Auth-Tree Verification & describeAuthTree", () => {
  const client = new VaultClient(vaultConfig);

  beforeEach(() => {
    stubWritePath();
  });

  /**
   * Helper that builds the realistic deposit auth tree:
   * Root: vault.deposit(depositor, amount)
   * Child: rwa-asset.transfer(depositor, vault, amount)
   */
  function buildDepositAuthEntry(
    depositor: string,
    amount = 10_000_000n,
    underlyingId = RWA_ID,
    nonce = 42n,
  ): xdr.SorobanAuthorizationEntry {
    const childInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(underlyingId).toScAddress(),
          functionName: "transfer",
          args: [
            nativeToScVal(depositor, { type: "address" }),
            nativeToScVal(VAULT_ID, { type: "address" }),
            nativeToScVal(amount, { type: "i128" }),
          ],
        }),
      ),
      subInvocations: [],
    });

    const rootInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(VAULT_ID).toScAddress(),
          functionName: "deposit",
          args: [
            nativeToScVal(depositor, { type: "address" }),
            nativeToScVal(amount, { type: "i128" }),
          ],
        }),
      ),
      subInvocations: [childInvocation],
    });

    return new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        new xdr.SorobanAddressCredentials({
          address: new Address(depositor).toScAddress(),
          nonce,
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation,
    });
  }

  it("describeAuthTree formats full multi-contract tree clearly", () => {
    const entry = buildDepositAuthEntry(DEPOSITOR, 10_000_000n);
    const desc = describeAuthTree(entry);
    expect(desc).toContain(`Authorizer: ${DEPOSITOR}`);
    expect(desc).toContain(`Root: ${VAULT_ID}.deposit("${DEPOSITOR}", 10000000n)`);
    expect(desc).toContain(`└── ${RWA_ID}.transfer("${DEPOSITOR}", "${VAULT_ID}", 10000000n)`);
  });

  it("authorizes and finalizes a realistic deposit tree successfully", async () => {
    const originalEntry = buildDepositAuthEntry(DEPOSITOR, 5_000_000n);
    const latestLedger = 1_000;
    const expiryLedger = latestLedger + 60;

    vi.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(
      new Account(FEE_PAYER, "1"),
    );
    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
      id: "1",
      protocolVersion: 22,
      sequence: latestLedger,
    } as never);
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
      _parsed: true,
      id: "1",
      latestLedger,
      minResourceFee: "5000",
      transactionData: new SorobanDataBuilder(),
      events: [],
      result: { retval: xdr.ScVal.scvVoid(), auth: [] },
    } as unknown as rpc.Api.SimulateTransactionResponse);

    const dummyTx = await client.buildDepositTx(FEE_PAYER, 5_000_000n);
    const sponsored = {
      transaction: dummyTx,
      authEntries: [originalEntry],
      authorizers: [DEPOSITOR],
    };

    const signedEntries = await authorizeEntries(
      [originalEntry],
      DEPOSITOR_KP,
      expiryLedger,
      vaultConfig.networkPassphrase,
    );

    const finalized = await client.finalizeSponsoredTx(sponsored, signedEntries);
    expect(finalized).toBeDefined();
  });

  it("refuses tampering when root amount is modified", async () => {
    const original = buildDepositAuthEntry(DEPOSITOR, 5_000_000n);
    const tampered = buildDepositAuthEntry(DEPOSITOR, 9_999_999n);
    const signed = await authorizeEntries(
      [tampered],
      DEPOSITOR_KP,
      1_060,
      vaultConfig.networkPassphrase,
    );

    const sponsored = {
      transaction: await client.buildDepositTx(FEE_PAYER, 5_000_000n),
      authEntries: [original],
      authorizers: [DEPOSITOR],
    };

    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
      id: "1",
      protocolVersion: 22,
      sequence: 1_000,
    } as never);

    await expect(client.finalizeSponsoredTx(sponsored, signed)).rejects.toThrow(
      /Authorization tree differs at rootInvocation.args\[1\]: argument mismatch/,
    );
  });

  it("refuses tampering when child underlying transfer amount is modified", async () => {
    const original = buildDepositAuthEntry(DEPOSITOR, 5_000_000n);
    // Create tampered tree where root says 5M but child rwa-asset transfer says 50M
    const childTampered = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(RWA_ID).toScAddress(),
          functionName: "transfer",
          args: [
            nativeToScVal(DEPOSITOR, { type: "address" }),
            nativeToScVal(VAULT_ID, { type: "address" }),
            nativeToScVal(50_000_000n, { type: "i128" }), // Tampered child amount!
          ],
        }),
      ),
      subInvocations: [],
    });

    const tamperedRoot = new xdr.SorobanAuthorizedInvocation({
      function: original.rootInvocation.function,
      subInvocations: [childTampered],
    });

    const tamperedEntry = new xdr.SorobanAuthorizationEntry({
      credentials: original.credentials,
      rootInvocation: tamperedRoot,
    });

    const signed = await authorizeEntries(
      [tamperedEntry],
      DEPOSITOR_KP,
      1_060,
      vaultConfig.networkPassphrase,
    );

    const sponsored = {
      transaction: await client.buildDepositTx(FEE_PAYER, 5_000_000n),
      authEntries: [original],
      authorizers: [DEPOSITOR],
    };

    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
      id: "1",
      protocolVersion: 22,
      sequence: 1_000,
    } as never);

    await expect(client.finalizeSponsoredTx(sponsored, signed)).rejects.toThrow(
      /Authorization tree differs at rootInvocation.subInvocations\[0\].args\[2\]: argument mismatch/,
    );
  });

  it("refuses tampering when child contract address differs", async () => {
    const original = buildDepositAuthEntry(DEPOSITOR, 5_000_000n, RWA_ID);
    const fakeRwa = StrKey.encodeContract(Buffer.alloc(32, 99));
    const tampered = buildDepositAuthEntry(DEPOSITOR, 5_000_000n, fakeRwa);
    const signed = await authorizeEntries([tampered], DEPOSITOR_KP, 1_060, vaultConfig.networkPassphrase);

    const sponsored = {
      transaction: await client.buildDepositTx(FEE_PAYER, 5_000_000n),
      authEntries: [original],
      authorizers: [DEPOSITOR],
    };

    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
      id: "1",
      protocolVersion: 22,
      sequence: 1_000,
    } as never);

    await expect(client.finalizeSponsoredTx(sponsored, signed)).rejects.toThrow(
      /Authorization tree differs at rootInvocation.subInvocations\[0\].contractAddress/,
    );
  });

  it("refuses tampering when child function name differs", async () => {
    const original = buildDepositAuthEntry(DEPOSITOR, 5_000_000n);
    const childFnTampered = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(RWA_ID).toScAddress(),
          functionName: "burn", // Tampered from transfer to burn!
          args: [
            nativeToScVal(DEPOSITOR, { type: "address" }),
            nativeToScVal(VAULT_ID, { type: "address" }),
            nativeToScVal(5_000_000n, { type: "i128" }),
          ],
        }),
      ),
      subInvocations: [],
    });

    const tamperedRoot = new xdr.SorobanAuthorizedInvocation({
      function: original.rootInvocation.function,
      subInvocations: [childFnTampered],
    });

    const tamperedEntry = new xdr.SorobanAuthorizationEntry({
      credentials: original.credentials,
      rootInvocation: tamperedRoot,
    });

    const signed = await authorizeEntries([tamperedEntry], DEPOSITOR_KP, 1_060, vaultConfig.networkPassphrase);
    const sponsored = {
      transaction: await client.buildDepositTx(FEE_PAYER, 5_000_000n),
      authEntries: [original],
      authorizers: [DEPOSITOR],
    };

    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
      id: "1",
      protocolVersion: 22,
      sequence: 1_000,
    } as never);

    await expect(client.finalizeSponsoredTx(sponsored, signed)).rejects.toThrow(
      /Authorization tree differs at rootInvocation.subInvocations\[0\].functionName: expected "transfer", got "burn"/,
    );
  });

  it("refuses tampering when extra sub-invocation is appended", async () => {
    const original = buildDepositAuthEntry(DEPOSITOR, 5_000_000n);
    const extraChild = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(RWA_ID).toScAddress(),
          functionName: "transfer",
          args: [nativeToScVal(DEPOSITOR, { type: "address" })],
        }),
      ),
      subInvocations: [],
    });

    const tamperedRoot = new xdr.SorobanAuthorizedInvocation({
      function: original.rootInvocation.function,
      subInvocations: [original.rootInvocation.subInvocations[0]!, extraChild],
    });

    const tamperedEntry = new xdr.SorobanAuthorizationEntry({
      credentials: original.credentials,
      rootInvocation: tamperedRoot,
    });

    const signed = await authorizeEntries([tamperedEntry], DEPOSITOR_KP, 1_060, vaultConfig.networkPassphrase);
    const sponsored = {
      transaction: await client.buildDepositTx(FEE_PAYER, 5_000_000n),
      authEntries: [original],
      authorizers: [DEPOSITOR],
    };

    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
      id: "1",
      protocolVersion: 22,
      sequence: 1_000,
    } as never);

    await expect(client.finalizeSponsoredTx(sponsored, signed)).rejects.toThrow(
      /Authorization tree differs at rootInvocation.subInvocations: count mismatch \(expected 1, got 2\)/,
    );
  });
});

// ─── 5. Event Decoding ─────────────────────────────────────────────────────────

describe("Event Decoding", () => {
  it("decodes parsed RPC deposit event", () => {
    const rawRpcEvent = {
      ledger: 42,
      topic: ["Vault", "deposit", DEPOSITOR],
      value: {
        xdr: nativeToScVal({
          caller: DEPOSITOR,
          depositor: DEPOSITOR,
          assets: 10_000_000n,
          shares: 20_000_000n,
        }).toXdr("base64"),
      },
    };

    const decoded = decodeVaultEvent(rawRpcEvent);
    expect(decoded.type).toBe("deposit");
    if (decoded.type === "deposit") {
      expect(decoded.caller).toBe(DEPOSITOR);
      expect(decoded.depositor).toBe(DEPOSITOR);
      expect(decoded.assets).toBe(10_000_000n);
      expect(decoded.shares).toBe(20_000_000n);
      expect(decoded.ledger).toBe(42);
    }
  });

  it("decodes parsed RPC redeem event", () => {
    const rawRpcEvent = {
      ledger: 43,
      topic: ["Vault", "redeem", DEPOSITOR],
      value: {
        xdr: nativeToScVal({
          caller: DEPOSITOR,
          redeemer: DEPOSITOR,
          shares: 20_000_000n,
          assets: 10_000_000n,
        }).toXdr("base64"),
      },
    };

    const decoded = decodeVaultEvent(rawRpcEvent);
    expect(decoded.type).toBe("redeem");
    if (decoded.type === "redeem") {
      expect(decoded.redeemer).toBe(DEPOSITOR);
      expect(decoded.shares).toBe(20_000_000n);
      expect(decoded.assets).toBe(10_000_000n);
      expect(decoded.ledger).toBe(43);
    }
  });

  it("decodes parsed RPC transfer event", () => {
    const rawRpcEvent = {
      ledger: 44,
      topic: ["transfer", DEPOSITOR, RECIPIENT],
      value: {
        xdr: nativeToScVal(1_000_000n, { type: "i128" }).toXdr("base64"),
      },
    };

    const decoded = decodeVaultEvent(rawRpcEvent);
    expect(decoded.type).toBe("transfer");
    if (decoded.type === "transfer") {
      expect(decoded.from).toBe(DEPOSITOR);
      expect(decoded.to).toBe(RECIPIENT);
      expect(decoded.amount).toBe(1_000_000n);
      expect(decoded.ledger).toBe(44);
    }
  });

  it("returns unknown event for unrecognized topics instead of throwing", () => {
    const unknownEvent = {
      ledger: 10,
      topic: ["SomethingElse", "custom"],
      value: "AAAAAQ==",
    };
    const decoded = decodeVaultEvent(unknownEvent);
    expect(decoded.type).toBe("unknown");
  });

  it("decodeVaultEvents decodes batch RPC getEvents response", () => {
    const getEventsResponse = {
      events: [
        {
          ledger: 100,
          topic: ["transfer", DEPOSITOR, RECIPIENT],
          value: { xdr: nativeToScVal(500n, { type: "i128" }).toXdr("base64") },
        },
        {
          ledger: 101,
          topic: ["UnknownTopic"],
          value: "AAAA",
        },
      ],
    };

    const decoded = decodeVaultEvents(getEventsResponse);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]?.type).toBe("transfer");
    expect(decoded[1]?.type).toBe("unknown");
  });
});
