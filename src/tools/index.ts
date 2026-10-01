import type { AnyToolDefinition } from './define.js';
import { getBalance } from './getBalance.js';
import { getBlock } from './getBlock.js';
import { getChainStatus } from './getChainStatus.js';
import { getLogs } from './getLogs.js';
import { getTokenInfo } from './getTokenInfo.js';
import { getTransaction } from './getTransaction.js';
import { readContract } from './readContract.js';
import { simulateCall } from './simulateCall.js';

export const READ_TOOLS: readonly AnyToolDefinition[] = [
  getChainStatus,
  getBlock,
  getTransaction,
  getBalance,
  getTokenInfo,
  readContract,
  getLogs,
  simulateCall,
];
