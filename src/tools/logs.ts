import {
  AbiEventSignatureEmptyTopicsError,
  AbiEventSignatureNotFoundError,
  BaseError,
  decodeEventLog,
  type Abi,
  type Log,
} from 'viem';
import type { z } from 'zod';
import { jsonSafe } from '../format.js';
import type { decodedLogSchema } from './schemas.js';

export type DecodedLog = z.infer<typeof decodedLogSchema>;

/**
 * Shapes a log for output and, when an ABI is given, decodes it. A log whose
 * event is not in the ABI gets `decoded: null`; a log whose event matches but
 * whose data does not fit (e.g. different indexed params) also gets a
 * `decodeError` explaining why.
 */
export function shapeLog(log: Log, abi?: Abi): DecodedLog {
  const base: DecodedLog = {
    address: log.address,
    topics: [...log.topics],
    data: log.data,
    blockNumber: log.blockNumber === null ? null : log.blockNumber.toString(),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    removed: log.removed,
    decoded: null,
  };
  if (!abi || log.topics.length === 0) return base;

  try {
    const decoded = decodeEventLog({
      abi,
      data: log.data,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      strict: true,
    });
    return { ...base, decoded: { eventName: decoded.eventName ?? 'anonymous', args: jsonSafe(decoded.args) } };
  } catch (err) {
    if (err instanceof AbiEventSignatureNotFoundError || err instanceof AbiEventSignatureEmptyTopicsError) return base;
    return { ...base, decodeError: err instanceof BaseError ? err.shortMessage : String(err) };
  }
}
