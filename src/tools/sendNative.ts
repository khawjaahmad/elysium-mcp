import { z } from 'zod';
import { parseAddress, parseUint } from '../inputs.js';
import { defineTool } from './define.js';
import { addressInput } from './schemas.js';
import { audited, dryRunInput, executeWrite, writeOutputSchema } from './write.js';

export const sendNative = defineTool({
  name: 'send_native',
  title: 'Send HYPE',
  description:
    'Send HYPE from the server’s own account (set by the operator) on the Elysium testnet. The transaction is ' +
    'simulated first and refused if it would revert, exceed MAX_SEND_HYPE or MAX_FEE_HYPE, or go to an address ' +
    'outside WRITE_ALLOWLIST. dry_run defaults to true and only previews; set dry_run=false to send.',
  requiresChain: false,
  inputSchema: {
    to: addressInput('Recipient.'),
    value: z
      .union([z.string(), z.number().int().nonnegative()])
      .describe('HYPE to send, in wei (1 HYPE = 10^18 wei), as a decimal or 0x-hex string.'),
    dry_run: dryRunInput,
  },
  outputSchema: writeOutputSchema,
  async handler(input, ctx) {
    const dryRun = input.dry_run !== false;
    return audited(ctx, { tool: 'send_native', to: input.to, value: input.value, functionName: null, dryRun }, () =>
      executeWrite({ to: parseAddress(input.to, 'to'), value: parseUint(input.value, 'value'), dryRun }, ctx),
    );
  },
});
