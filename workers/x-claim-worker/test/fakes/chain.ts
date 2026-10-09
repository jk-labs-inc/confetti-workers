import { keccak256, parseTransaction, recoverTransactionAddress, toHex, type Hex } from "viem";

const ZERO_WORD = `0x${"0".repeat(64)}`;
const TRANSFER_GAS = 21_000n;
const REPLACEMENT_MIN_BUMP_PERCENT = 110n;

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown[];
}

type RpcAnswer = { result: unknown } | { error: { code: number; message: string } };

export type SendFailure =
  | { kind: "rpc"; message: string }
  | { kind: "http" }
  | { kind: "accept_then_http" }
  | { kind: "accept_then_rpc"; message: string };

const INTERNAL_RPC_ERROR_CODE = -32603;
const INVALID_INPUT_RPC_ERROR_CODE = -32000;

export const unavailableRpc = async (request: Request): Promise<Response> => {
  const { id } = (await request.json()) as JsonRpcRequest;
  return Response.json({ jsonrpc: "2.0", id, error: { code: INVALID_INPUT_RPC_ERROR_CODE, message: "header not found" } });
};

export interface FakeTransaction {
  hash: Hex;
  from: string;
  to: string;
  value: bigint;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

interface FakeReceipt {
  transaction: FakeTransaction;
  status: "success" | "reverted";
  blockNumber: bigint;
  effectiveGasPrice: bigint;
}

export class FakeChain {
  readonly accepted: FakeTransaction[] = [];
  readonly mined: FakeTransaction[] = [];
  autoMine = true;
  transactionCountLag = 0;
  baseFeePerGas = 30_000_000_000n;
  priorityFeePerGas = 30_000_000_000n;
  private blockNumber = 1_000n;
  private readonly balances = new Map<string, bigint>();
  private readonly nonces = new Map<string, number>();
  private readonly mempool = new Map<Hex, FakeTransaction>();
  private readonly receipts = new Map<Hex, FakeReceipt>();
  private readonly revertingRecipients = new Set<string>();
  private readonly sendFailures: SendFailure[] = [];
  private readonly failingReceiptLookups = new Set<Hex>();
  private readonly unindexedReceipts = new Set<Hex>();

  constructor(private readonly chainId: number) {}

  fund(address: string, wei: bigint): void {
    this.balances.set(address.toLowerCase(), this.balanceOf(address) + wei);
  }

  balanceOf(address: string): bigint {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }

  nonceOf(address: string): number {
    return this.nonces.get(address.toLowerCase()) ?? 0;
  }

  pendingTransactions(): FakeTransaction[] {
    return [...this.mempool.values()];
  }

  revertTransfersTo(address: string): void {
    this.revertingRecipients.add(address.toLowerCase());
  }

  failNextSend(failure: SendFailure): void {
    this.sendFailures.push(failure);
  }

  failReceiptLookupsFor(hash: Hex): void {
    this.failingReceiptLookups.add(hash);
  }

  withholdReceipt(hash: Hex): void {
    this.unindexedReceipts.add(hash);
  }

  releaseReceipts(): void {
    this.unindexedReceipts.clear();
  }

  dropPending(): void {
    this.mempool.clear();
  }

  consumeNonceElsewhere(address: string): void {
    this.nonces.set(address.toLowerCase(), this.nonceOf(address) + 1);
  }

  handle = async (request: Request): Promise<Response> => {
    const rpc = (await request.json()) as JsonRpcRequest;
    const reply = (answer: RpcAnswer) => Response.json({ jsonrpc: "2.0", id: rpc.id, ...answer });
    if (rpc.method !== "eth_sendRawTransaction") return reply(this.answer(rpc));

    const failure = this.sendFailures.shift();
    if (failure?.kind === "http") return new Response("bad gateway", { status: 502 });
    if (failure?.kind === "rpc") return reply({ error: { code: INVALID_INPUT_RPC_ERROR_CODE, message: failure.message } });
    const answer = await this.sendRawTransaction((rpc.params ?? [])[0] as Hex);
    if (failure?.kind === "accept_then_http") return new Response("bad gateway", { status: 502 });
    if (failure?.kind === "accept_then_rpc")
      return reply({ error: { code: INTERNAL_RPC_ERROR_CODE, message: failure.message } });
    return reply(answer);
  };

  mine(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const transaction of [...this.mempool.values()].sort((a, b) => a.nonce - b.nonce)) {
        if (transaction.nonce !== this.nonceOf(transaction.from)) continue;
        this.execute(transaction);
        progressed = true;
      }
    }
  }

  private execute(transaction: FakeTransaction): void {
    for (const [hash, other] of this.mempool)
      if (other.from === transaction.from && other.nonce === transaction.nonce) this.mempool.delete(hash);

    const effectiveGasPrice = [transaction.maxFeePerGas, this.baseFeePerGas + transaction.maxPriorityFeePerGas].reduce(
      (a, b) => (a < b ? a : b),
    );
    const reverted = this.revertingRecipients.has(transaction.to);
    const cost = TRANSFER_GAS * effectiveGasPrice + (reverted ? 0n : transaction.value);
    this.balances.set(transaction.from, this.balanceOf(transaction.from) - cost);
    if (!reverted) this.fund(transaction.to, transaction.value);
    this.nonces.set(transaction.from, transaction.nonce + 1);
    this.blockNumber += 1n;
    this.receipts.set(transaction.hash, {
      transaction,
      status: reverted ? "reverted" : "success",
      blockNumber: this.blockNumber,
      effectiveGasPrice,
    });
    this.mined.push(transaction);
  }

  private async sendRawTransaction(raw: Hex): Promise<RpcAnswer> {
    const parsed = parseTransaction(raw);
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    const hash = keccak256(raw);
    const rpcError = (message: string): RpcAnswer => ({ error: { code: -32000, message } });

    if (parsed.chainId !== this.chainId) return rpcError("invalid chain id");
    if (this.mempool.has(hash) || this.receipts.has(hash)) return rpcError("already known");
    const nonce = parsed.nonce ?? 0;
    if (nonce < this.nonceOf(from)) return rpcError("nonce too low");

    const transaction: FakeTransaction = {
      hash,
      from,
      to: (parsed.to ?? "").toLowerCase(),
      value: parsed.value ?? 0n,
      nonce,
      maxFeePerGas: parsed.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? 0n,
    };
    const replaced = [...this.mempool.values()].find((other) => other.from === from && other.nonce === nonce);
    if (
      replaced &&
      (transaction.maxFeePerGas * 100n < replaced.maxFeePerGas * REPLACEMENT_MIN_BUMP_PERCENT ||
        transaction.maxPriorityFeePerGas * 100n < replaced.maxPriorityFeePerGas * REPLACEMENT_MIN_BUMP_PERCENT)
    )
      return rpcError("replacement transaction underpriced");
    if (transaction.value + TRANSFER_GAS * transaction.maxFeePerGas > this.balanceOf(from))
      return rpcError("insufficient funds for gas * price + value");
    if (transaction.maxFeePerGas < this.baseFeePerGas) return rpcError("max fee per gas less than block base fee");

    if (replaced) this.mempool.delete(replaced.hash);
    this.mempool.set(hash, transaction);
    this.accepted.push(transaction);
    if (this.autoMine) this.mine();
    return { result: hash };
  }

  private pendingNonce(address: string): number {
    const nonces = [...this.mempool.values()].filter((tx) => tx.from === address).map((tx) => tx.nonce + 1);
    return Math.max(this.nonceOf(address), ...nonces);
  }

  private block() {
    const hash = keccak256(toHex(this.blockNumber));
    return {
      number: toHex(this.blockNumber),
      hash,
      parentHash: keccak256(toHex(this.blockNumber - 1n)),
      timestamp: toHex(Math.floor(Date.now() / 1000)),
      baseFeePerGas: toHex(this.baseFeePerGas),
      gasLimit: toHex(30_000_000n),
      gasUsed: "0x0",
      miner: `0x${"0".repeat(40)}`,
      difficulty: "0x0",
      totalDifficulty: "0x0",
      extraData: "0x",
      logsBloom: `0x${"0".repeat(512)}`,
      nonce: "0x0000000000000000",
      sha3Uncles: ZERO_WORD,
      mixHash: ZERO_WORD,
      receiptsRoot: ZERO_WORD,
      stateRoot: ZERO_WORD,
      transactionsRoot: ZERO_WORD,
      size: "0x0",
      transactions: [],
      uncles: [],
    };
  }

  private receiptJson(receipt: FakeReceipt) {
    return {
      transactionHash: receipt.transaction.hash,
      transactionIndex: "0x0",
      blockHash: keccak256(toHex(receipt.blockNumber)),
      blockNumber: toHex(receipt.blockNumber),
      from: receipt.transaction.from,
      to: receipt.transaction.to,
      cumulativeGasUsed: toHex(TRANSFER_GAS),
      gasUsed: toHex(TRANSFER_GAS),
      effectiveGasPrice: toHex(receipt.effectiveGasPrice),
      contractAddress: null,
      logs: [],
      logsBloom: `0x${"0".repeat(512)}`,
      status: receipt.status === "success" ? "0x1" : "0x0",
      type: "0x2",
    };
  }

  private answer(rpc: JsonRpcRequest): RpcAnswer {
    const params = rpc.params ?? [];
    const address = String(params[0] ?? "").toLowerCase();
    switch (rpc.method) {
      case "eth_chainId":
        return { result: toHex(this.chainId) };
      case "eth_blockNumber":
        return { result: toHex(this.blockNumber) };
      case "eth_getBlockByNumber":
        return { result: this.block() };
      case "eth_maxPriorityFeePerGas":
        return { result: toHex(this.priorityFeePerGas) };
      case "eth_gasPrice":
        return { result: toHex(this.baseFeePerGas + this.priorityFeePerGas) };
      case "eth_estimateGas":
        return { result: toHex(TRANSFER_GAS) };
      case "eth_getBalance":
        return { result: toHex(this.balanceOf(address)) };
      case "eth_getTransactionCount": {
        const count = params[1] === "pending" ? this.pendingNonce(address) : this.nonceOf(address);
        return { result: toHex(Math.max(0, count - this.transactionCountLag)) };
      }
      case "eth_getTransactionReceipt": {
        if (this.failingReceiptLookups.has(params[0] as Hex))
          return { error: { code: INVALID_INPUT_RPC_ERROR_CODE, message: "header not found" } };
        const receipt = this.unindexedReceipts.has(params[0] as Hex) ? undefined : this.receipts.get(params[0] as Hex);
        return { result: receipt ? this.receiptJson(receipt) : null };
      }
      case "eth_call":
        return { result: ZERO_WORD };
      default:
        return { error: { code: -32601, message: `FakeChain does not support ${rpc.method}` } };
    }
  }
}
