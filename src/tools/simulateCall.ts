import {
  BaseError,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  toFunctionSignature,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
import { ToolError, extractRevert, rpcMessage, toToolError, type RevertInfo } from '../errors.js';
import { jsonSafe, nativeAmount, gasPrice } from '../format.js';
import { blockParams, coerceArgs, parseAbiInput, parseAddress, parseBlockRef, parseHex, parseUint } from '../inputs.js';
import { resolveFunction } from './abiFunction.js';
import { defineTool } from './define.js';
import {
  abiInput,
  addressInput,
  argsInput,
  blockInput,
  gasPriceSchema,
  nativeAmountSchema,
  revertSchema,
} from './schemas.js';

/** Fills errorName/errorArgs by decoding revert data against the ABI plus Error(string)/Panic(uint256). */
export function decodeRevert(revert: RevertInfo, abi: Abi | undefined): RevertInfo {
  if (!revert.data || revert.data === '0x' || revert.errorName) return revert;
  try {
    const decoded = decodeErrorResult({ abi: abi ?? [], data: revert.data });
    const args = decoded.args ? [...decoded.args] : [];
    const reason = decoded.errorName === 'Error' && typeof args[0] === 'string' ? args[0] : revert.reason;
    return { ...revert, reason, errorName: decoded.errorName, errorArgs: jsonSafe(args) as unknown[] };
  } catch {
    return revert;
  }
}

export const simulateCall = defineTool({
  name: 'simulate_call',
  title: 'Simulate call',
  description:
    'Dry-run a transaction with eth_call and estimate its gas, without sending anything. Provide either raw data, ' +
    'or abi + functionName + args to have the call data encoded and the result decoded. ' +
    'A transaction that would fail returns success: false with the revert reason; that is a result, not a tool error.',
  inputSchema: {
    to: addressInput('Recipient or contract address.'),
    from: addressInput(
      'Sender to simulate as. Defaults to the zero address. Set it when the call depends on msg.sender or balance.',
    ).optional(),
    value: z
      .union([z.string(), z.number().int().nonnegative()])
      .optional()
      .describe('HYPE to send, in wei (1 HYPE = 10^18 wei), as a decimal or 0x-hex string. Defaults to 0.'),
    data: z.string().optional().describe('Raw call data (0x-hex). Use this or abi + functionName.'),
    abi: abiInput('ABI containing the function to call.').optional(),
    functionName: z.string().optional().describe('Function to call. Requires abi.'),
    args: argsInput,
    block: blockInput('Block state to simulate against. Defaults to latest.'),
  },
  outputSchema: {
    success: z.boolean(),
    returnData: z.string().nullable().describe('Raw return data from eth_call, if it succeeded.'),
    decodedResult: z.unknown().optional().describe('Decoded return value, when abi + functionName were given.'),
    signature: z.string().optional(),
    revert: revertSchema.optional().describe('Why the call would fail, if it reverted.'),
    error: z
      .string()
      .optional()
      .describe('Node error message if the call failed for a reason other than a revert (e.g. insufficient funds).'),
    gasEstimate: z
      .string()
      .nullable()
      .describe('Gas units from eth_estimateGas; includes the parent-chain data cost on Arbitrum chains.'),
    gasEstimateError: z.string().optional(),
    gasPrice: gasPriceSchema,
    estimatedFee: nativeAmountSchema
      .nullable()
      .describe('gasEstimate × current gas price. An estimate, not a guarantee.'),
  },
  async handler(input, { client }) {
    const to = parseAddress(input.to, 'to');
    const from: Address | undefined = input.from === undefined ? undefined : parseAddress(input.from, 'from');
    const value = input.value === undefined ? undefined : parseUint(input.value, 'value');
    const at = blockParams(parseBlockRef(input.block));

    if (input.data !== undefined && (input.abi !== undefined || input.functionName !== undefined)) {
      throw new ToolError('INVALID_INPUT', 'Pass either data or abi + functionName, not both.');
    }
    if ((input.abi === undefined) !== (input.functionName === undefined)) {
      throw new ToolError('INVALID_INPUT', 'abi and functionName must be given together.');
    }
    if (input.args !== undefined && input.functionName === undefined) {
      throw new ToolError('INVALID_INPUT', 'args requires abi + functionName.');
    }

    let abi: Abi | undefined;
    let fn: AbiFunction | undefined;
    let data: Hex | undefined;
    if (input.abi !== undefined && input.functionName !== undefined) {
      abi = parseAbiInput(input.abi);
      fn = resolveFunction(abi, input.functionName, input.args?.length ?? 0);
      const args = coerceArgs(fn.inputs, input.args ?? []);
      try {
        data = encodeFunctionData({ abi: [fn], functionName: fn.name, args });
      } catch (err) {
        throw new ToolError(
          'INVALID_INPUT',
          `Could not encode arguments: ${err instanceof BaseError ? err.shortMessage : String(err)}`,
        );
      }
    } else if (input.data !== undefined) {
      data = parseHex(input.data, 'data');
    }

    const tx = {
      to,
      ...(from === undefined ? {} : { account: from }),
      ...(data === undefined ? {} : { data }),
      ...(value === undefined ? {} : { value }),
    };

    const price = await client.getGasPrice();
    const base = { gasPrice: gasPrice(price), ...(fn ? { signature: toFunctionSignature(fn) } : {}) };

    let returnData: Hex;
    try {
      returnData = (await client.call({ ...tx, ...at })).data ?? '0x';
    } catch (err) {
      const e = toToolError(err);
      if (e.retryable || (e.code !== 'EXECUTION_REVERTED' && e.code !== 'RPC_ERROR')) throw e;
      const revert = extractRevert(err);
      return {
        ...base,
        success: false,
        returnData: null,
        ...(revert ? { revert: decodeRevert(revert, abi) } : { error: rpcMessage(err) }),
        gasEstimate: null,
        estimatedFee: null,
      };
    }

    let decodedResult: unknown;
    if (fn) {
      try {
        decodedResult = jsonSafe(decodeFunctionResult({ abi: [fn], functionName: fn.name, data: returnData }));
      } catch (err) {
        decodedResult = { decodeError: err instanceof BaseError ? err.shortMessage : String(err) };
      }
    }

    let gasEstimate: bigint | null = null;
    let gasEstimateError: string | undefined;
    try {
      gasEstimate = await client.estimateGas({ ...tx, ...at });
    } catch (err) {
      const e = toToolError(err);
      if (e.retryable) throw e;
      gasEstimateError = rpcMessage(err);
    }

    return {
      ...base,
      success: true,
      returnData,
      ...(fn ? { decodedResult } : {}),
      gasEstimate: gasEstimate === null ? null : gasEstimate.toString(),
      ...(gasEstimateError === undefined ? {} : { gasEstimateError }),
      estimatedFee: gasEstimate === null ? null : nativeAmount(client.chain, gasEstimate * price),
    };
  },
});
