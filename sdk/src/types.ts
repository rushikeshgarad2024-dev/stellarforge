// ─── Core Protocol Types ──────────────────────────────────────────────────────

export type AssetClass =
  | "real_estate"
  | "commodity"
  | "private_equity"
  | "debt"
  | "infrastructure"
  | "art"
  | "other";

export interface AssetMetadata {
  /** Human-readable name of the real-world asset */
  name: string;
  /** Ticker symbol, e.g. "REIT-NYC-001" */
  symbol: string;
  /** Number of decimal places (Stellar standard: 7) */
  decimals: number;
  /** Broad category of the underlying asset */
  assetClass: AssetClass;
  /** IPFS CID or SHA-256 hex of the legal offering document */
  legalDocHash: string;
  /** Hard cap on total minted supply; 0 means uncapped */
  maxSupply: bigint;
}

export interface KycRecord {
  /** ISO-3166-1 alpha-2 country code */
  jurisdiction: string;
  /** 0=none | 1=basic | 2=full | 3=accredited */
  level: 0 | 1 | 2 | 3;
  /** Unix timestamp of expiry, or 0 for never */
  expiresAt: number;
}

export interface NetworkConfig {
  /** "mainnet" | "testnet" | "futurenet" | custom RPC URL */
  network: "mainnet" | "testnet" | "futurenet" | (string & {});
  /** Soroban RPC endpoint URL */
  rpcUrl: string;
  /** Stellar network passphrase */
  networkPassphrase: string;
}

export interface ContractAddresses {
  rwaAsset?: string;
  registry?: string;
  compliance?: string;
  governance?: string;
  vault?: string;
}

export interface StellarForgeConfig extends NetworkConfig {
  contracts: ContractAddresses;
  /** Optional signing keypair (StrKey secret, `S...`) — only for server-side use */
  signerSecret?: string;
}

/** Outcome of a write transaction that was submitted and confirmed. */
export interface TxResult {
  /** Hex-encoded transaction hash. */
  hash: string;
  /** Ledger sequence the transaction was included in. */
  ledger: number;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/** An asset contract recorded in the registry. */
export interface AssetEntry {
  /** Address of the deployed `rwa-asset` contract. */
  contract: string;
  /**
   * Broad category of the underlying asset.
   *
   * The registry stores this as a free-form string and validates nothing, so a
   * value outside this union is possible for an entry written by other tooling.
   */
  assetClass: AssetClass;
  /** Whether the registry still considers this asset current. */
  active: boolean;
}

// ─── Governance ───────────────────────────────────────────────────────────────

export type ProposalStatus = "Active" | "Passed" | "Rejected" | "Executed";

export interface Proposal {
  /** Contract-assigned id, counting from 1. */
  id: bigint;
  proposer: string;
  title: string;
  /** Hex of the off-chain proposal document's hash. */
  descriptionHash: string;
  votesFor: bigint;
  votesAgainst: bigint;
  /** Ledger sequence after which voting is closed. */
  deadlineLedger: number;
  status: ProposalStatus;
}

/** Outcome of a submitted `propose`, carrying the id the contract assigned. */
export interface ProposalCreated extends TxResult {
  proposalId: bigint;
}

// ─── Well-known network presets ───────────────────────────────────────────────

export const TESTNET_CONFIG: Omit<NetworkConfig, "network"> & { network: "testnet" } = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

/**
 * Mainnet's network identity, without an RPC endpoint.
 *
 * SDF runs a public RPC for testnet but not for mainnet, so there is no URL the
 * SDK could honestly default to. Spread this preset and supply `rpcUrl` from the
 * provider you use: https://developers.stellar.org/docs/data/apis/rpc/providers. TypeScript rejects a config that omits it.
 *
 * In 0.1.0 this preset named `https://soroban-rpc.stellar.org`, which does not
 * resolve, so every mainnet call made with it failed.
 */
export const MAINNET_CONFIG: Omit<NetworkConfig, "network" | "rpcUrl"> & { network: "mainnet" } = {
  network: "mainnet",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
};
