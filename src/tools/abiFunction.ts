import type { Abi, AbiFunction } from 'viem';
import { ToolError } from '../errors.js';

/**
 * Picks the function `name` from `abi`. Overloads are disambiguated by
 * argument count; if that is not enough, the caller must pass a single
 * fragment.
 */
export function resolveFunction(abi: Abi, name: string, argCount: number): AbiFunction {
  const candidates = abi.filter((item): item is AbiFunction => item.type === 'function' && item.name === name);
  if (candidates.length === 0) {
    const available = abi.filter((i): i is AbiFunction => i.type === 'function').map((f) => f.name);
    throw new ToolError('ABI_MISMATCH', `Function "${name}" is not in the supplied ABI.`, {
      hint: available.length
        ? `Functions in the ABI: ${[...new Set(available)].join(', ')}.`
        : 'The ABI has no functions.',
      details: { functionName: name },
    });
  }
  const byArity = candidates.filter((f) => f.inputs.length === argCount);
  if (byArity.length === 1) return byArity[0]!;
  if (candidates.length === 1) return candidates[0]!;
  throw new ToolError(
    'INVALID_INPUT',
    byArity.length === 0
      ? `No overload of "${name}" takes ${argCount} argument(s).`
      : `"${name}" has several overloads taking ${argCount} argument(s).`,
    {
      hint: 'Pass an ABI containing only the overload you want.',
      details: { overloads: candidates.map((f) => `${f.name}(${f.inputs.map((i) => i.type).join(',')})`) },
    },
  );
}
