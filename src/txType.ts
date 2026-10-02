/**
 * Transaction type codes. 0-4 are standard Ethereum types; 100-106 are
 * Arbitrum's, from https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/rpc-methods
 * (Elysium is an Arbitrum Orbit chain, so its RPC returns these codes).
 */
type Origin = 'user' | 'bridge' | 'retryable' | 'arbos' | 'unknown';

const TYPES: Record<number, { name: string; origin: Origin }> = {
  0: { name: 'legacy', origin: 'user' },
  1: { name: 'eip2930', origin: 'user' },
  2: { name: 'eip1559', origin: 'user' },
  3: { name: 'eip4844', origin: 'user' },
  4: { name: 'eip7702', origin: 'user' },
  100: { name: 'ArbitrumDepositTx', origin: 'bridge' },
  101: { name: 'ArbitrumUnsignedTx', origin: 'bridge' },
  102: { name: 'ArbitrumContractTx', origin: 'bridge' },
  104: { name: 'ArbitrumRetryTx', origin: 'retryable' },
  105: { name: 'ArbitrumSubmitRetryableTx', origin: 'bridge' },
  106: { name: 'ArbitrumInternalTx', origin: 'arbos' },
};

/** Arbitrum's ArbOS-generated internal transaction (e.g. the startBlock at index 0 of every block). */
export const ARBITRUM_INTERNAL_TX_TYPE = 106;

export interface TxTypeInfo {
  code: number | null;
  name: string;
  /** Who created it: a user, the parent-chain bridge, a retryable redeem, or ArbOS itself. */
  origin: Origin;
}

/** Describes a transaction from the raw `type` field returned by the node (e.g. "0x2", "0x6a"). */
export function describeTxType(typeHex: string | undefined): TxTypeInfo {
  if (typeHex === undefined) return { code: null, name: 'unknown', origin: 'unknown' };
  const code = Number.parseInt(typeHex, 16);
  if (Number.isNaN(code)) return { code: null, name: 'unknown', origin: 'unknown' };
  return { code, ...(TYPES[code] ?? { name: 'unknown', origin: 'unknown' }) };
}
