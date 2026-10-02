import { z } from 'zod';

/**
 * Shapes of the explorer's /api/v2 responses, limited to the fields this
 * server reads. Recorded from the Elysium testnet explorer on 2026-10-02.
 * Unknown extra fields are ignored; a missing or retyped field we rely on
 * fails validation (EXPLORER_RESPONSE_INVALID).
 */

const str = z.string().nullish();
const bool = z.boolean().nullish();

export const addressRef = z.object({
  hash: z.string(),
  name: str,
  is_contract: bool,
  is_verified: bool,
  ens_domain_name: str,
});

export const tokenRef = z.object({
  address_hash: z.string(),
  name: str,
  symbol: str,
  decimals: str,
  type: str,
  holders_count: str,
  total_supply: str,
});

export const implementation = z.object({ address_hash: z.string(), name: str });

const pageParams = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullish();

export const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), next_page_params: pageParams });

export const address = z.object({
  hash: z.string(),
  is_contract: bool,
  is_verified: bool,
  name: str,
  ens_domain_name: str,
  coin_balance: str,
  block_number_balance_updated_at: z.number().nullish(),
  creator_address_hash: str,
  creation_transaction_hash: str,
  proxy_type: str,
  implementations: z.array(implementation).nullish(),
  has_tokens: bool,
  has_token_transfers: bool,
  has_logs: bool,
  token: tokenRef.nullish(),
});

export const decodedInput = z.object({
  method_call: str,
  method_id: str,
  parameters: z.array(z.object({ name: str, type: str, value: z.unknown() })).nullish(),
});

export const transaction = z.object({
  hash: z.string(),
  block_number: z.number().nullish(),
  timestamp: str,
  from: addressRef,
  to: addressRef.nullish(),
  created_contract: addressRef.nullish(),
  value: str,
  fee: z.object({ type: str, value: str }).nullish(),
  status: str,
  result: str,
  type: z.number().nullish(),
  method: str,
  transaction_types: z.array(z.string()).nullish(),
  decoded_input: decodedInput.nullish(),
  revert_reason: z.unknown(),
});

export const tokenTransfer = z.object({
  transaction_hash: z.string(),
  block_number: z.number().nullish(),
  timestamp: str,
  log_index: z.number().nullish(),
  from: addressRef,
  to: addressRef,
  token: tokenRef,
  total: z.record(z.string(), z.unknown()).nullish(),
  type: str,
  method: str,
});

export const tokenBalances = z.array(
  z.object({ token: tokenRef, value: z.string(), token_id: z.union([z.string(), z.number()]).nullish() }),
);

export const holder = z.object({
  address: addressRef,
  value: z.string(),
  token_id: z.union([z.string(), z.number()]).nullish(),
});

export const smartContract = z.object({
  name: str,
  is_verified: bool,
  is_fully_verified: bool,
  is_partially_verified: bool,
  compiler_version: str,
  language: str,
  optimization_enabled: bool,
  verified_at: str,
  license_type: str,
  file_path: str,
  abi: z.array(z.unknown()).nullish(),
  source_code: str,
  proxy_type: str,
  implementations: z.array(implementation).nullish(),
});

export const searchResult = z.object({
  type: z.string(),
  address_hash: str,
  name: str,
  symbol: str,
  token_type: str,
  is_smart_contract_verified: bool,
  total_supply: str,
  transaction_hash: str,
  block_hash: str,
  block_number: z.union([z.number(), z.string()]).nullish(),
});
