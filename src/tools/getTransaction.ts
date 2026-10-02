import {
  AbiFunctionSignatureNotFoundError,
  BaseError,
  decodeFunctionData,
  TransactionReceiptNotFoundError,
  type Abi,
  type Hex,
} from 'viem';
import { z } from 'zod';
import { jsonSafe, jsonSafeObject, nativeAmount } from '../format.js';
import { parseAbiInput, parseHash } from '../inputs.js';
import { ARBITRUM_INTERNAL_TX_TYPE, describeTxType } from '../txType.js';
import { defineTool } from './define.js';
import { shapeLog } from './logs.js';
import { abiInput, decodedLogSchema, nativeAmountSchema } from './schemas.js';

function decodeInput(abi: Abi, input: Hex): { functionName: string; args: unknown } | { error: string } | null {
  if (input.length < 10) return null;
  try {
    const { functionName, args } = decodeFunctionData({ abi, data: input });
    return { functionName, args: jsonSafe(args ?? []) };
  } catch (err) {
    if (err instanceof AbiFunctionSignatureNotFoundError) return null;
    return { error: err instanceof BaseError ? err.shortMessage : String(err) };
  }
}

export const getTransaction = defineTool({
  name: 'get_transaction',
  title: 'Get transaction',
  description:
    'Fetch a transaction and its receipt by hash. With an ABI, the input data and event logs are decoded. ' +
    'If the transaction is still pending, receipt is null. systemTransaction is true for ArbOS-generated ' +
    'bookkeeping transactions (Arbitrum type 106, e.g. startBlock at index 0 of every block), which no user sent ' +
    'and which pay no fee.',
  inputSchema: {
    hash: z.string().describe('Transaction hash: 0x followed by 64 hex characters.'),
    abi: abiInput('Optional ABI used to decode the input data and logs.').optional(),
  },
  outputSchema: {
    status: z.enum(['success', 'reverted', 'pending']),
    transactionType: z
      .object({
        code: z.number().nullable(),
        name: z.string(),
        origin: z.enum(['user', 'bridge', 'retryable', 'arbos', 'unknown']),
      })
      .describe(
        'From the raw type field. 0-4 are standard Ethereum types sent by users; 100-106 are Arbitrum types ' +
          '(bridge deposits and messages from the parent chain, retryable redeems, ArbOS internal transactions).',
      ),
    systemTransaction: z.boolean().describe('True for ArbOS internal transactions (type 106).'),
    note: z.string().optional(),
    transaction: z.record(z.string(), z.unknown()).describe('Transaction fields. Integers are decimal strings.'),
    receipt: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe('Receipt fields without logs (see logs). Arbitrum fields such as gasUsedForL1 are passed through.'),
    value: nativeAmountSchema,
    fee: nativeAmountSchema
      .nullable()
      .describe('gasUsed × effectiveGasPrice. null while pending or if the node reports no effectiveGasPrice.'),
    decodedInput: z
      .union([z.object({ functionName: z.string(), args: z.unknown() }), z.object({ error: z.string() })])
      .nullable()
      .describe('Decoded call data, if an ABI was supplied and contains the called function.'),
    logs: z.array(decodedLogSchema),
  },
  async handler({ hash, abi }, { client }) {
    const txHash = parseHash(hash);
    const parsedAbi = abi === undefined ? undefined : parseAbiInput(abi);

    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }).catch((err: unknown) => {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      }),
    ]);

    const { logs = [], ...receiptWithoutLogs } = receipt ?? {};
    const transactionType = describeTxType(tx.typeHex ?? undefined);
    const systemTransaction = transactionType.code === ARBITRUM_INTERNAL_TX_TYPE;
    return {
      status: receipt === null ? ('pending' as const) : receipt.status,
      transactionType,
      systemTransaction,
      ...(systemTransaction
        ? {
            note: 'ArbOS internal transaction: created by the chain itself to record block bookkeeping, not sent by any user. It uses no gas, so its fee is 0.',
          }
        : {}),
      transaction: jsonSafeObject(tx),
      receipt: receipt === null ? null : jsonSafeObject(receiptWithoutLogs),
      value: nativeAmount(client.chain, tx.value),
      fee:
        receipt === null || receipt.effectiveGasPrice == null
          ? null
          : nativeAmount(client.chain, receipt.gasUsed * receipt.effectiveGasPrice),
      decodedInput: parsedAbi ? decodeInput(parsedAbi, tx.input) : null,
      logs: logs.map((log) => shapeLog(log, parsedAbi)),
    };
  },
});
