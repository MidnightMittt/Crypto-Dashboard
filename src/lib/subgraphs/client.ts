/**
 * Minimal GraphQL client for The Graph.
 *
 * IMPORTANT CONTEXT: subgraphs index BLOCKCHAIN data. They work for
 * on-chain perp DEXs (GMX, Synthetix, Gains, Vertex) and cannot work for
 * centralized exchanges — Binance/Bybit/OKX order books live in private
 * databases that never touch a chain, so there is nothing to index.
 *
 * The Graph retired its free hosted service; queries now route through the
 * decentralized network and need an API key from https://thegraph.com/studio
 * (free tier ~100k queries/month, far more than this app uses).
 *
 * Subgraph IDs are read from env rather than hardcoded, because deployment
 * IDs change whenever a protocol ships a new subgraph version. Setting them
 * in .env.local avoids a code change every time that happens.
 */

import { timeoutSignal } from "../net/timeout";

const GATEWAY = "https://gateway.thegraph.com/api";

export interface SubgraphConfig {
  /** Env var holding this protocol's subgraph deployment ID. */
  idEnvVar: string;
  /** Optional self-hosted endpoint, used in preference to the gateway. */
  urlEnvVar: string;
}

export function apiKey(): string | undefined {
  return process.env.THE_GRAPH_API_KEY?.trim() || undefined;
}

/** Resolve the endpoint for a protocol: self-hosted URL first, then gateway. */
export function resolveEndpoint(config: SubgraphConfig): string | null {
  const selfHosted = process.env[config.urlEnvVar]?.trim();
  if (selfHosted) return selfHosted;

  const key = apiKey();
  const subgraphId = process.env[config.idEnvVar]?.trim();
  if (!key || !subgraphId) return null;

  return `${GATEWAY}/${key}/subgraphs/id/${subgraphId}`;
}

export function isConfigured(config: SubgraphConfig): boolean {
  return resolveEndpoint(config) !== null;
}

export async function querySubgraph<T>(
  config: SubgraphConfig,
  query: string,
  variables: Record<string, unknown> = {},
  label = "subgraph"
): Promise<T | null> {
  const endpoint = resolveEndpoint(config);
  if (!endpoint) return null;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: timeoutSignal(),
      cache: "no-store",
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.errors?.length) {
      // Schema drift is the common failure here — surface the real message
      // so the query can be corrected rather than silently returning nothing.
      console.warn(`[${label}] GraphQL errors:`, JSON.stringify(json.errors).slice(0, 400));
      return null;
    }
    if (!json.data) {
      console.warn(`[${label}] no data field; keys:`, Object.keys(json).join(", "));
      return null;
    }
    return json.data as T;
  } catch (err) {
    console.warn(`[${label}] query failed:`, err);
    return null;
  }
}
