import { BaseError, decodeFunctionData, encodeFunctionData, toFunctionSignature, type Hex } from 'viem';
import { z } from 'zod';
import { ToolError } from '../errors.js';
import { jsonSafe } from '../format.js';
import { coerceArgs, parseAbiInput, parseAddress, parseUint } from '../inputs.js';
import { resolveFunction } from './abiFunction.js';
import { defineTool } from './define.js';
import { abiInput, addressInput, argsInput } from './schemas.js';
import { audited, dryRunInput, executeWrite, writeOutputSchema } from './write.js';

export const writeContract = defineTool({
  name: 'write_contract',
  title: 'Write to a contract',
  description:
    'Call a state-changing contract function from the server’s own account (set by the operator) on the Elysium ' +
    'testnet. You must supply the ABI; it is never looked up. The call is simulated first and refused if it would ' +
    'revert, exceed MAX_SEND_HYPE or MAX_FEE_HYPE, or target a contract outside WRITE_ALLOWLIST. dry_run defaults ' +
    'to true and returns the decoded call without sending; set dry_run=false to send.',
  requiresChain: false,
  inputSchema: {
    to: addressInput('Contract address.'),
    abi: abiInput('ABI containing the function to call.'),
    functionName: z.string().describe('Function to call. Must not be view or pure.'),
    args: argsInput,
    value: z
      .union([z.string(), z.number().int().nonnegative()])
      .optional()
      .describe('HYPE to send with the call, in wei. Defaults to 0. Only payable functions accept it.'),
    dry_run: dryRunInput,
  },
  outputSchema: {
    ...writeOutputSchema,
    call: z
      .object({
        functionName: z.string(),
        signature: z.string(),
        args: z.array(z.object({ name: z.string(), type: z.string(), value: z.unknown() })),
      })
      .describe('The call decoded back from the exact call data that is (or would be) sent.'),
  },
  async handler(input, ctx) {
    const dryRun = input.dry_run !== false;
    const entry = {
      tool: 'write_contract',
      to: input.to,
      value: input.value ?? '0',
      functionName: input.functionName,
      dryRun,
    };
    let call: { functionName: string; signature: string; args: { name: string; type: string; value: unknown }[] };
    const result = await audited(ctx, entry, async () => {
      const to = parseAddress(input.to, 'to');
      const value = input.value === undefined ? 0n : parseUint(input.value, 'value');
      const abi = parseAbiInput(input.abi);
      const fn = resolveFunction(abi, input.functionName, input.args?.length ?? 0);
      if (fn.stateMutability === 'view' || fn.stateMutability === 'pure') {
        throw new ToolError('INVALID_INPUT', `${fn.name} is ${fn.stateMutability}; it changes nothing.`, {
          hint: 'Use read_contract for view and pure functions.',
        });
      }
      if (value > 0n && fn.stateMutability !== 'payable') {
        throw new ToolError('INVALID_INPUT', `${fn.name} is not payable, so it cannot receive HYPE.`, {
          hint: 'Omit value, or set it to 0.',
        });
      }
      let data: Hex;
      try {
        data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: coerceArgs(fn.inputs, input.args ?? []) });
      } catch (err) {
        throw new ToolError(
          'INVALID_INPUT',
          `Could not encode arguments: ${err instanceof BaseError ? err.shortMessage : String(err)}`,
        );
      }
      // Decoded from the encoded bytes, so the caller sees what the call data really says.
      const decoded = decodeFunctionData({ abi: [fn], data });
      call = {
        functionName: fn.name,
        signature: toFunctionSignature(fn),
        args: fn.inputs.map((p, i) => ({ name: p.name ?? '', type: p.type, value: jsonSafe(decoded.args?.[i]) })),
      };
      return executeWrite({ to, value, data, abi, dryRun }, ctx);
    });
    return { ...result, call: call! };
  },
});
