import { formatGwei, formatUnits, type Chain } from 'viem';

/** Recursively converts bigint to decimal strings so values survive JSON. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = jsonSafe(v);
    }
    return out;
  }
  return value;
}

export function jsonSafeObject(value: object): Record<string, unknown> {
  return jsonSafe(value) as Record<string, unknown>;
}

export interface NativeAmount {
  wei: string;
  formatted: string;
  symbol: string;
}

/** A native-coin amount in wei plus its human-readable value, using the chain's decimals. */
export function nativeAmount(chain: Chain | undefined, wei: bigint): NativeAmount {
  const currency = chain?.nativeCurrency;
  if (!currency) throw new Error('Chain definition is missing nativeCurrency');
  return { wei: wei.toString(), formatted: formatUnits(wei, currency.decimals), symbol: currency.symbol };
}

export interface GasPrice {
  wei: string;
  gwei: string;
}

export function gasPrice(wei: bigint): GasPrice {
  return { wei: wei.toString(), gwei: formatGwei(wei) };
}

export function isoTimestamp(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString();
}
