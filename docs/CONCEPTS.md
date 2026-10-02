# Blockchain concepts used by this server

A short guide for back-end engineers. Each section covers only what you need to read this codebase and
the tool outputs.

## The chain as a database

An EVM chain is a replicated, append-only database with a built-in program runtime: the **EVM**, the
Ethereum Virtual Machine. You talk to it over **JSON-RPC**: HTTP POSTs with bodies like
`{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}`. Every tool in this server is a thin,
validated wrapper around a few of these methods (`eth_getBlockByNumber`, `eth_call`, `eth_getLogs`, …).
[viem](https://viem.sh) is the TypeScript client that builds and parses those requests.

The **chain ID** is an integer that identifies a network: `99801` for Elysium testnet. It is part of every
signed transaction, so a transaction for one chain can't be replayed on another. That is also why the
server refuses to run when the RPC endpoint reports a different chain ID from the one configured.

## Blocks

State changes are grouped into **blocks**, numbered from 0. Each block has:

- a **hash**, a 32-byte fingerprint of its contents;
- its parent's hash, which forms the chain;
- a **timestamp** in whole Unix seconds;
- the transactions it contains.

Elysium makes a block every 100–200 ms. Several blocks therefore share the same timestamp second, which
is why `get_chain_status` measures block time over a window of many blocks rather than between two.

**Block tags** name moving targets:

- `latest`: the newest block;
- `safe` / `finalized`: blocks the chain considers very unlikely or impossible to be reverted (on an L2
  this relates to what has been posted to and confirmed on the parent chain);
- `earliest`: block 0;
- `pending`: what the node expects the next block to look like.

## Accounts and addresses

An **address** is 20 bytes, written as `0x` plus 40 hex characters. There are two kinds of account:

- **Externally owned accounts (EOAs)** are controlled by a private key. Only they can sign transactions.
- **Contract accounts** hold code (deployed programs) and storage. They run only when called.
  `NOT_A_CONTRACT` means there is no code at the address.

**EIP-55 checksums** encode a checksum in the letter case of the hex digits:
`0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`. All-lowercase is also valid (no checksum). Mixed case with
the wrong pattern almost certainly means a typo, so the server rejects it with `INVALID_ADDRESS`.

## Native coin, wei and decimals

Each chain has a **native coin** used to pay fees: on Elysium that is **HYPE**. Balances are integers in
the smallest unit, **wei**; 1 HYPE = 10^18 wei. This "18 decimals" is a display convention shared by all
EVM native coins; the chain itself only stores the integer. Tools return both the raw `wei` string and a
`formatted` value. The decimals are defined once, in `src/chain.ts`.

Because balances regularly exceed 2^53, all large integers are returned as **decimal strings**.

## Transactions and receipts

A **transaction** is a signed request from an EOA to:

- move native coin (`value`), and/or
- call a contract (`to` + `data`).

It includes a **nonce** (a per-sender counter that orders transactions and prevents replays) and gas
settings.

After a transaction is included in a block, the node produces a **receipt**. The receipt records:

- **status**: `success`, or `reverted` (the call failed, all its state changes were undone, but the fee
  was still paid);
- **gasUsed** and **effectiveGasPrice**;
- the **logs** the transaction emitted.

A transaction without a receipt yet is **pending**.

Each transaction has a **type** code. Types 0–4 are standard Ethereum formats signed by users. Arbitrum
chains add their own types (100–106) for transactions that no user signed: deposits and messages arriving
from the parent chain, and **ArbOS internal transactions** (type 106). ArbOS is the chain's built-in system
layer. It starts every block with an internal `startBlock` transaction that records bookkeeping data and pays
no fee. `get_transaction` flags these as `systemTransaction: true`.

## Gas, base fee and fees

**Gas** measures computational work: a plain coin transfer costs 21,000 gas, contract calls cost more.
The sender pays

> fee = gasUsed × effectiveGasPrice

with the price in wei per gas. The price usually has two parts:

- the **base fee**, a protocol-set minimum per block (EIP-1559);
- an optional **priority fee** (tip).

Prices are often shown in **gwei** (10^9 wei). Elysium's fees are designed to be low; `get_chain_status`
shows the current base fee and gas price.

On Arbitrum-based chains, the gas estimate also covers the cost of posting the transaction's data to the
parent chain. That is why a simple transfer can estimate above 21,000 gas, and why receipts carry an
extra `gasUsedForL1` field.

## Contracts, ABIs and function selectors

A contract's **ABI** (Application Binary Interface) is its typed interface, like an OpenAPI spec. It lists
functions, events and errors with their parameter types. The chain does not store ABIs, so callers must
supply them. You can write an ABI as JSON, or as human-readable signatures:

```
function balanceOf(address owner) view returns (uint256)
event Transfer(address indexed from, address indexed to, uint256 value)
```

To call a function, the client sends **call data**:

- a 4-byte **function selector** (the first 4 bytes of the keccak-256 hash of `balanceOf(address)`);
- then the arguments, ABI-encoded.

The response is ABI-encoded too. viem does both the encoding and the decoding, given the ABI.

Functions are marked:

- `view`: reads state;
- `pure`: reads nothing;
- `nonpayable` / `payable`: changes state; `payable` also accepts native coin.

`read_contract` only calls `view` and `pure` functions.

## eth_call vs sending a transaction

`eth_call` runs a function **locally on the node** against current (or historical) state and returns the
result. Nothing is signed, nothing is recorded, and it costs nothing. It works for any function, so it can
also show what a state-changing call _would_ do: that is `simulate_call`. `eth_estimateGas` likewise
reports how much gas the call would need.

Sending a real transaction requires a signature from a private key. That is phase 2 and is not in this
version.

## Reverts

When a contract rejects a call it **reverts**: it aborts, undoes its changes, and returns error data.
There are three common forms:

- `Error(string)`, e.g. `"ERC20: transfer amount exceeds balance"`;
- `Panic(uint256)`, for internal failures such as overflow or division by zero;
- **custom errors** declared in the ABI, e.g. `InsufficientBalance(uint256 available, uint256 required)`.

The server decodes all three when it can.

## Events and logs

Contracts emit **events** to record what happened. Off-chain code reads them cheaply, but contracts
can't read them back. Each emitted event is a **log** with:

- the emitting `address`;
- up to 4 **topics** (32-byte values). Topic 0 is usually the event signature hash, e.g. `keccak256("Transfer(address,address,uint256)")`.
  The other topics hold the `indexed` parameters.
- `data`: the non-indexed parameters, ABI-encoded.

Because indexed parameters are topics, nodes can filter on them. That is what `get_logs`'s `event` +
`args` (or raw `topics`) do. Scanning logs is expensive for the node, so both this server and the node cap
how many blocks one query may span.

## ERC-20 tokens

**ERC-20** is the standard interface for fungible tokens. A token is a contract that keeps a balance
table. Its read functions are `name()`, `symbol()`, `decimals()`, `totalSupply()` and
`balanceOf(address)`, and it emits `Transfer(from, to, value)` events.

Token amounts are integers in the token's smallest unit. `decimals()` (often 18, sometimes 6) says where
the decimal point goes. Some fields are optional in practice, which is why `get_token_info` returns
`null` for any function a contract doesn't implement. NFTs (ERC-721) use the same `Transfer` event name
but index the third parameter, so their logs have 4 topics instead of 3.

## Layer 2, rollups and settlement

A **Layer 2 (L2)** is a separate chain that periodically commits its state to a **parent chain** for
security. Elysium is an **Arbitrum Orbit** chain, built on Arbitrum's **Nitro** software. Its parent
("settlement") chain is HyperEVM, Hyperliquid's EVM; the testnet settles to HyperEVM testnet.

Elysium is an **optimistic rollup**. Its state is assumed correct unless someone proves fraud within a
**challenge period**. Its transaction data is kept by an **AnyTrust data availability committee**, with
a fallback that posts the full data to HyperEVM.

On Elysium, a single **sequencer** orders transactions into blocks. You can see its address as the
block's `miner` field.

For this server, all of that is mostly invisible: Elysium speaks standard Ethereum JSON-RPC, plus a few
extra Arbitrum fields in blocks and receipts. The practical consequences are fast blocks, low fees, and
withdrawals to the parent chain that only finalize after the challenge period.

## Finality

Once the sequencer puts a transaction in a block, `latest` and the receipt reflect it, and most
applications treat it as done. Elysium's docs note there is no separate preconfirmation layer. Stronger,
protocol-level finality comes later, once the batch containing the block has been posted to and confirmed
on the parent chain. The `safe` and `finalized` block tags let you read at those more conservative points.
