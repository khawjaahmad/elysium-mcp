import {
  AbiDecodingZeroDataError,
  AbiErrorSignatureNotFoundError,
  AbiEventNotFoundError,
  AbiFunctionNotFoundError,
  BaseError,
  BlockNotFoundError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  HttpRequestError,
  InvalidAddressError,
  RpcRequestError,
  TimeoutError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from 'viem';

/**
 * Error codes returned to agents. Each one tells the agent what to do next:
 * fix its input, retry later, or give up.
 */
export const ERROR_CODES = [
  'INVALID_INPUT',
  'INVALID_ADDRESS',
  'INVALID_ABI',
  'ABI_MISMATCH',
  'NOT_A_CONTRACT',
  'NOT_FOUND',
  'RANGE_TOO_LARGE',
  'EXECUTION_REVERTED',
  'RPC_TIMEOUT',
  'RATE_LIMITED',
  'RPC_UNAVAILABLE',
  'RPC_ERROR',
  'CHAIN_MISMATCH',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['RPC_TIMEOUT', 'RATE_LIMITED', 'RPC_UNAVAILABLE']);

export interface ToolErrorOptions {
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: ToolErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ToolError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
    this.retryable = RETRYABLE.has(code);
  }

  toJSON(): ToolErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export interface ToolErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  hint?: string;
  details?: Record<string, unknown>;
}

/** Walks a viem error chain and returns the first error matching `predicate`. */
function findInChain<T>(err: unknown, predicate: (e: unknown) => e is T): T | undefined {
  if (err instanceof BaseError) {
    const found = err.walk((e) => predicate(e));
    return found === null ? undefined : (found as T);
  }
  return predicate(err) ? err : undefined;
}

function isInstance<T>(ctor: abstract new (...args: never[]) => T) {
  return (e: unknown): e is T => e instanceof ctor;
}

/** Innermost human-readable message: the raw RPC message if there is one. */
export function rpcMessage(err: unknown): string {
  // RpcRequestError keeps the node's own message in `details`.
  const rpc = findInChain(err, isInstance(RpcRequestError));
  if (rpc) return rpc.details || rpc.shortMessage;
  if (err instanceof BaseError) return err.shortMessage;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Numeric JSON-RPC error code anywhere in the chain, if any. */
export function rpcCode(err: unknown): number | undefined {
  const withCode = findInChain(
    err,
    (e): e is { code: number } =>
      typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'number',
  );
  return withCode?.code;
}

const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|request limit/i;

/** Classifies transport-level failures (timeouts, HTTP status, rate limits). */
function classifyTransportError(err: unknown): ToolError | undefined {
  const timeout = findInChain(err, isInstance(TimeoutError));
  if (timeout) {
    return new ToolError('RPC_TIMEOUT', 'The RPC node did not respond in time.', {
      hint: 'Retry shortly. If it keeps happening, increase RPC_TIMEOUT_MS or narrow the request.',
      cause: err,
    });
  }

  const http = findInChain(err, isInstance(HttpRequestError));
  if (http) {
    const status = http.status;
    if (status === 429) {
      return new ToolError('RATE_LIMITED', 'The RPC node is rate limiting requests (HTTP 429).', {
        hint: 'Wait a few seconds and retry, or lower RPC_RATE_LIMIT_RPS.',
        details: { status },
        cause: err,
      });
    }
    if (status === undefined || status >= 500 || status === 408) {
      return new ToolError('RPC_UNAVAILABLE', 'The RPC node could not be reached or returned a server error.', {
        hint: 'Retry later. Check ELYSIUM_RPC_URL and network connectivity.',
        details: status === undefined ? { reason: http.details } : { status },
        cause: err,
      });
    }
    return new ToolError('RPC_ERROR', `The RPC node rejected the HTTP request (status ${status}).`, {
      details: { status },
      cause: err,
    });
  }

  const code = rpcCode(err);
  if (code === 429 || ((code === -32005 || code === -32007) && RATE_LIMIT_PATTERN.test(rpcMessage(err)))) {
    return new ToolError('RATE_LIMITED', `The RPC node is rate limiting requests: ${rpcMessage(err)}`, {
      hint: 'Wait a few seconds and retry, or lower RPC_RATE_LIMIT_RPS.',
      details: { rpcCode: code },
      cause: err,
    });
  }
  return undefined;
}

/** Revert information extracted from a failed call, if the failure was a revert. */
export interface RevertInfo {
  reason: string | null;
  data: `0x${string}` | null;
  errorName: string | null;
  errorArgs: unknown[] | null;
}

export function extractRevert(err: unknown): RevertInfo | undefined {
  const contractRevert = findInChain(err, isInstance(ContractFunctionRevertedError));
  if (contractRevert) {
    return {
      reason: contractRevert.reason ?? null,
      data: contractRevert.raw ?? null,
      errorName: contractRevert.data?.errorName ?? null,
      errorArgs: contractRevert.data?.args ? [...contractRevert.data.args] : null,
    };
  }
  const execRevert = findInChain(err, isInstance(ExecutionRevertedError));
  if (execRevert) {
    return { reason: execRevert.details || null, data: revertDataFrom(err), errorName: null, errorArgs: null };
  }
  // Nodes signal reverts with JSON-RPC code 3 and the revert payload in `data`.
  if (rpcCode(err) === 3 || /execution reverted/i.test(rpcMessage(err))) {
    return { reason: rpcMessage(err), data: revertDataFrom(err), errorName: null, errorArgs: null };
  }
  return undefined;
}

/** Revert payload (`data` field of the JSON-RPC error), if present and hex. */
export function revertDataFrom(err: unknown): `0x${string}` | null {
  const withData = findInChain(
    err,
    (e): e is { data: `0x${string}` } =>
      typeof e === 'object' &&
      e !== null &&
      'data' in e &&
      typeof (e as { data: unknown }).data === 'string' &&
      /^0x[0-9a-fA-F]*$/.test((e as { data: string }).data),
  );
  return withData?.data ?? null;
}

/**
 * Converts any thrown value into a ToolError. Unknown failures become
 * RPC_ERROR (if they came from the node) or INTERNAL_ERROR.
 */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;

  const transport = classifyTransportError(err);
  if (transport) return transport;

  if (findInChain(err, isInstance(InvalidAddressError))) {
    return new ToolError('INVALID_ADDRESS', rpcMessage(err), {
      hint: 'Addresses are 0x followed by 40 hex characters. Mixed-case addresses must have a valid EIP-55 checksum.',
      cause: err,
    });
  }

  if (
    findInChain(err, isInstance(BlockNotFoundError)) ||
    findInChain(err, isInstance(TransactionNotFoundError)) ||
    findInChain(err, isInstance(TransactionReceiptNotFoundError))
  ) {
    return new ToolError('NOT_FOUND', rpcMessage(err), { cause: err });
  }

  if (findInChain(err, isInstance(AbiFunctionNotFoundError)) || findInChain(err, isInstance(AbiEventNotFoundError))) {
    return new ToolError('ABI_MISMATCH', rpcMessage(err), {
      hint: 'Check that the name matches an entry in the supplied ABI, including its exact casing.',
      cause: err,
    });
  }

  if (
    findInChain(err, isInstance(ContractFunctionZeroDataError)) ||
    findInChain(err, isInstance(AbiDecodingZeroDataError))
  ) {
    return new ToolError('ABI_MISMATCH', 'The call returned no data (0x).', {
      hint: 'The address may not be a contract, or the contract does not implement this function.',
      cause: err,
    });
  }

  const revert = extractRevert(err);
  if (revert) {
    return new ToolError('EXECUTION_REVERTED', `Execution reverted${revert.reason ? `: ${revert.reason}` : ''}.`, {
      hint: 'The contract rejected the call. Check the arguments, the caller (from), and the value sent.',
      details: { ...revert },
      cause: err,
    });
  }

  if (findInChain(err, isInstance(AbiErrorSignatureNotFoundError))) {
    return new ToolError('ABI_MISMATCH', rpcMessage(err), { cause: err });
  }

  if (findInChain(err, isInstance(RpcRequestError)) || rpcCode(err) !== undefined) {
    return new ToolError('RPC_ERROR', `The RPC node returned an error: ${rpcMessage(err)}`, {
      details: { rpcCode: rpcCode(err) },
      cause: err,
    });
  }

  if (err instanceof BaseError) {
    return new ToolError('INVALID_INPUT', err.shortMessage, { cause: err });
  }

  return new ToolError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err), { cause: err });
}

/** True when a raw error should be retried at the transport level. */
export function isRetryableTransportError(err: unknown): boolean {
  const classified = classifyTransportError(err);
  return classified?.retryable ?? false;
}
