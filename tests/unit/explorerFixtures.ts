/**
 * Explorer API responses, trimmed from real responses recorded on the
 * Elysium testnet explorer (2026-10-02). Extra fields the server ignores are
 * kept in places to prove they are tolerated.
 */
export const EOA = '0xDCCA9732cF9381b7529435Ce397E3915be41B209';
export const TOKEN = '0x7ae29BE60A29425dABC75e361875F1dd21c160A7';
export const PROXY = '0x444Efe3b7118b5333ef691a0c31eE5597b355C1e';
export const IMPL = '0x49735D0A84434efE861ACc9C62a4dcF43E53eC81';

export const addressRef = (hash: string, extra: Record<string, unknown> = {}) => ({
  ens_domain_name: null,
  hash,
  implementations: [],
  is_contract: false,
  is_scam: false,
  is_verified: false,
  metadata: null,
  name: null,
  private_tags: [],
  proxy_type: null,
  public_tags: [],
  watchlist_names: [],
  ...extra,
});

export const tokenRef = (extra: Record<string, unknown> = {}) => ({
  address_hash: TOKEN,
  circulating_market_cap: null,
  decimals: '18',
  exchange_rate: null,
  holders_count: '3062',
  icon_url: null,
  name: 'Chappie',
  symbol: 'Chap',
  total_supply: '21000000000000000000000000',
  type: 'ERC-20',
  volume_24h: null,
  ...extra,
});

export const proxyAddress = {
  block_number_balance_updated_at: 1778069,
  coin_balance: '1500000000000000000',
  creation_status: 'success',
  creation_transaction_hash: `0x${'c'.repeat(64)}`,
  creator_address_hash: EOA,
  ens_domain_name: null,
  exchange_rate: null,
  has_beacon_chain_withdrawals: false,
  has_logs: true,
  has_token_transfers: false,
  has_tokens: false,
  has_validated_blocks: false,
  hash: PROXY,
  implementations: [{ address_hash: IMPL, name: 'StandardArbERC20' }],
  is_contract: true,
  is_scam: false,
  is_verified: true,
  metadata: null,
  name: 'ClonableBeaconProxy',
  private_tags: [],
  proxy_type: 'eip1967',
  public_tags: [],
  token: tokenRef({ address_hash: PROXY, name: 'Bridged Token', symbol: 'BRG' }),
  watchlist_address_id: null,
  watchlist_names: [],
};

const PROXY_ABI = [
  { inputs: [], stateMutability: 'nonpayable', type: 'constructor' },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: 'address', name: 'beacon', type: 'address' }],
    name: 'BeaconUpgraded',
    type: 'event',
  },
];

export const IMPL_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

export const verifiedContract = (extra: Record<string, unknown> = {}) => ({
  file_path: 'contracts/ClonableBeaconProxy.sol',
  creation_status: 'success',
  source_code: '// SPDX-License-Identifier: Apache-2.0\npragma solidity ^0.8.0;\ncontract ClonableBeaconProxy {}\n',
  deployed_bytecode: '0x6080',
  optimization_enabled: true,
  is_verified: true,
  compiler_settings: {},
  optimization_runs: 100,
  compiler_version: 'v0.8.16+commit.07a7930e',
  verified_at: '2026-10-01T10:00:00.000000Z',
  implementations: [{ address_hash: IMPL, name: 'StandardArbERC20' }],
  proxy_type: 'eip1967',
  creation_bytecode: '0x6080',
  name: 'ClonableBeaconProxy',
  license_type: 'apache_2_0',
  is_fully_verified: true,
  language: 'solidity',
  abi: PROXY_ABI,
  is_partially_verified: false,
  ...extra,
});

/** What the explorer returns for a contract that is not verified: bytecode only. */
export const unverifiedContract = {
  creation_bytecode: '0x6080',
  creation_status: 'success',
  deployed_bytecode: '0x6080',
  implementations: [],
  proxy_type: 'unknown',
};

export const transaction = (extra: Record<string, unknown> = {}) => ({
  priority_fee: '0',
  raw_input: '0xd2ce7d65',
  result: 'success',
  hash: `0x${'1'.repeat(64)}`,
  revert_reason: null,
  type: 2,
  confirmations: 6015,
  position: 2,
  created_contract: null,
  value: '100000000000000',
  from: addressRef(EOA),
  gas_used: '21158',
  status: 'ok',
  to: addressRef(PROXY, { is_contract: true, is_verified: true, name: 'L2GatewayRouter' }),
  method: 'outboundTransfer',
  fee: { type: 'actual', value: '211580000000' },
  decoded_input: {
    method_call: 'outboundTransfer(address _token, address _to, uint256 _amount, bytes _data)',
    method_id: 'd2ce7d65',
    parameters: [
      { name: '_token', type: 'address', value: TOKEN },
      { name: '_amount', type: 'uint256', value: '10000000000000000000' },
      { name: '_data', type: 'bytes', value: '0x' },
    ],
  },
  timestamp: '2026-10-02T04:00:00.000000Z',
  nonce: 70,
  transaction_types: ['contract_call'],
  block_number: 1783623,
  ...extra,
});

export const tokenTransfer = (extra: Record<string, unknown> = {}) => ({
  block_hash: `0x${'b'.repeat(64)}`,
  block_number: 1707976,
  from: addressRef('0x0000000000000000000000000000000000000000'),
  log_index: 5,
  method: 'mint',
  timestamp: '2026-10-01T23:10:39.000000Z',
  to: addressRef(EOA),
  token: tokenRef(),
  total: { decimals: '18', value: '2500000000000000000' },
  transaction_hash: `0x${'2'.repeat(64)}`,
  type: 'token_minting',
  ...extra,
});
