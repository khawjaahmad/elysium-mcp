import { toFunctionSignature } from 'viem';
import { z } from 'zod';
import { ToolError, toToolError } from '../errors.js';
import { jsonSafe } from '../format.js';
import { blockParams, coerceArgs, parseAbiInput, parseAddress, parseBlockRef } from '../inputs.js';
import { resolveFunction } from './abiFunction.js';
import { defineTool } from './define.js';
import { abiInput, addressInput, argsInput, blockInput } from './schemas.js';
import { assertContract } from './token.js';

export const readContract = defineTool({
  name: 'read_contract',
  title: 'Read contract',
  description:
    'Call a view or pure function on a contract and return its decoded result. Nothing is sent to the chain. ' +
    'For state-changing functions, use simulate_call.',
  inputSchema: {
    address: addressInput('Contract address.'),
    abi: abiInput('ABI containing the function (a single fragment is enough).'),
    functionName: z.string().min(1).describe('Name of the function to call.'),
    args: argsInput,
    block: blockInput('Block to read at. Defaults to latest.'),
  },
  outputSchema: {
    address: z.string(),
    functionName: z.string(),
    signature: z.string().describe('The resolved function signature, e.g. balanceOf(address).'),
    result: z
      .unknown()
      .describe('Decoded return value. Integers are decimal strings; multiple outputs are an array or object.'),
  },
  async handler({ address, abi, functionName, args, block }, { client }) {
    const contract = parseAddress(address);
    const parsedAbi = parseAbiInput(abi);
    const fn = resolveFunction(parsedAbi, functionName, args?.length ?? 0);
    if (fn.stateMutability !== 'view' && fn.stateMutability !== 'pure') {
      throw new ToolError('INVALID_INPUT', `"${fn.name}" is ${fn.stateMutability}, not view or pure.`, {
        hint: 'Use simulate_call to see what a state-changing function would do.',
      });
    }
    const callArgs = coerceArgs(fn.inputs, args ?? []);
    const at = blockParams(parseBlockRef(block));

    let result: unknown;
    try {
      result = await client.readContract({
        address: contract,
        abi: [fn],
        functionName: fn.name,
        args: callArgs,
        ...at,
      });
    } catch (err) {
      const e = toToolError(err);
      if (e.code === 'ABI_MISMATCH') await assertContract(client, contract, at);
      throw e;
    }

    return {
      address: contract,
      functionName: fn.name,
      signature: toFunctionSignature(fn),
      result: jsonSafe(result),
    };
  },
});
