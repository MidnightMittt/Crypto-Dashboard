import { CHAIN } from "./config";

/**
 * A MINIMAL, READ-ONLY JSON-RPC CLIENT for Robinhood Chain.
 *
 * Deliberately not ethers or viem: this monitor makes a handful of eth_call and
 * eth_getBlockByNumber requests and nothing else, and a full library would drag
 * in a signer surface this build is forbidden to have. Everything here READS.
 * There is no account, no private key, no transaction builder — the client
 * cannot move value because it has no method that could.
 *
 * ── The two landmines this file exists to defuse ──────────────────────
 *
 *  1. The RPC returns 403 to a default User-Agent and 200 with one set. Every
 *     request carries CHAIN.userAgent; a request without it is the commonest
 *     way this monitor would silently stop reading, so the UA is not optional.
 *
 *  2. This node does NOT retain historical state: eth_call at a block more than
 *     minutes old returns {code:-32000,"historical state ... not available"}.
 *     That is surfaced as a typed error, not swallowed — the series is built
 *     forward-only from live reads, and a caller asking for old state deserves
 *     to be told why it cannot be served rather than handed a wrong number.
 */

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    /** True for the archive-state limitation, so callers can branch on it. */
    readonly isHistoricalStateUnavailable = false
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface JsonRpcResponse {
  result?: string;
  error?: { code: number; message: string };
}

async function rpc(method: string, params: unknown[], attempt = 0): Promise<string> {
  let res: Response;
  try {
    res = await fetch(CHAIN.rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Landmine 1: no UA → 403. Non-negotiable.
        "User-Agent": CHAIN.userAgent,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (err) {
    // Network-level failure: retry with backoff before giving up.
    if (attempt < 3) {
      await sleep(backoffMs(attempt));
      return rpc(method, params, attempt + 1);
    }
    throw new RpcError(`${method} network error: ${err instanceof Error ? err.message : String(err)}`, null);
  }

  // 429 near large getLogs spans is documented; back off and retry.
  if (res.status === 429 && attempt < 4) {
    await sleep(backoffMs(attempt));
    return rpc(method, params, attempt + 1);
  }
  if (!res.ok) {
    throw new RpcError(`${method} HTTP ${res.status}`, null);
  }

  const body = (await res.json()) as JsonRpcResponse;
  if (body.error) {
    const historical = /historical state .* is not available/i.test(body.error.message);
    throw new RpcError(`${method}: ${body.error.message}`, body.error.code, historical);
  }
  if (body.result === undefined) {
    throw new RpcError(`${method}: empty result`, null);
  }
  return body.result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 0.5s, 1s, 2s, 4s — enough to clear a rate-limit window without stalling a sweep. */
const backoffMs = (attempt: number) => 500 * 2 ** attempt;

/** eth_call at a block tag ("latest" or a 0x-hex block number). */
export function ethCall(to: string, data: string, block: string = "latest"): Promise<string> {
  return rpc("eth_call", [{ to, data }, block]);
}

/** The latest block number as a bigint. */
export async function blockNumber(): Promise<bigint> {
  return BigInt(await rpc("eth_blockNumber", []));
}

/** A block header (timestamp, number) — served even when state at it is not. */
export async function blockHeader(block: string): Promise<{ number: bigint; timestampMs: number }> {
  const obj = (await rpcObject("eth_getBlockByNumber", [block, false])) as {
    number: string;
    timestamp: string;
  } | null;
  if (!obj) throw new RpcError(`eth_getBlockByNumber(${block}): no such block`, null);
  return { number: BigInt(obj.number), timestampMs: Number(BigInt(obj.timestamp)) * 1000 };
}

/** One raw log as eth_getLogs returns it. */
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
}

/**
 * eth_getLogs over an arbitrary span, in 20k-block chunks.
 *
 * The RPC 429s near ~100k-block spans (measured by the trading session), so
 * the span is split and each chunk rides rpc()'s own backoff. Chunks are
 * sequential, not parallel — the 429 is a rate limit, and racing a rate limit
 * just moves the failure around. ~860k blocks (24h) sweeps in ~75s.
 */
export async function getLogs(params: {
  address: string;
  topics: (string | null)[];
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<RawLog[]> {
  const CHUNK = 20_000n;
  const out: RawLog[] = [];
  for (let from = params.fromBlock; from <= params.toBlock; from += CHUNK) {
    const to = from + CHUNK - 1n < params.toBlock ? from + CHUNK - 1n : params.toBlock;
    const chunk = (await rpcObject("eth_getLogs", [
      {
        address: params.address,
        topics: params.topics,
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
      },
    ])) as RawLog[];
    out.push(...chunk);
  }
  return out;
}

/** Like rpc() but returns the object result (logs, block headers). Same backoff. */
async function rpcObject(method: string, params: unknown[], attempt = 0): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(CHAIN.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CHAIN.userAgent },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (err) {
    if (attempt < 3) {
      await sleep(backoffMs(attempt));
      return rpcObject(method, params, attempt + 1);
    }
    throw new RpcError(`${method} network error: ${err instanceof Error ? err.message : String(err)}`, null);
  }
  if (res.status === 429 && attempt < 4) {
    await sleep(backoffMs(attempt));
    return rpcObject(method, params, attempt + 1);
  }
  if (!res.ok) throw new RpcError(`${method} HTTP ${res.status}`, null);
  const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.code);
  return body.result;
}
