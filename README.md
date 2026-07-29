# Leverage Terminal

A cross-exchange dashboard for perpetual futures **funding rates**, **open interest**, and **leverage positioning** — built to answer one question at a glance:

> Is the market becoming overcrowded long or short?

Aggregates 27 venues (14 CEXs, 13 DEXs) across 10 assets into four animated gauges and a composite sentiment index. 21 of them are queried first-hand; the rest arrive through an aggregator.

---

## Quickstart

You need [Node.js](https://nodejs.org) 18.18 or newer. Check with `node --version`.

```bash
npm install
npm run dev
```

Open **http://localhost:3000**.

That's it — no API keys, no accounts, no database. Every panel works immediately against free public exchange endpoints. Optional keys unlock extra venues and features, but nothing is required.

### Available commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build |
| `npm start` | Run the production build (needs `build` first) |
| `npm run typecheck` | TypeScript check, no output files |
| `npm run lint` | ESLint |

---

## Data sources

**Every number is fetched live.** There is no simulated data anywhere in the codebase.

Data arrives two ways:

### 1. Direct adapters — queried at the exchange's own API

OKX · Bitget · Gate.io · Kraken · MEXC · HTX · KuCoin · Deribit · BitMEX · Phemex · Coinbase International
Hyperliquid · dYdX · Aster · Backpack · Orderly · Paradex · Aevo · Jupiter · Drift · GMX · Synthetix

Free public endpoints, no keys. First-hand and lowest latency.

Two of these are worth knowing about:

- **Deribit** is queried on both its inverse and its USDC perp and summed. The inverse book is ~30× larger, and aggregators tend to report only the linear one.
- **BitMEX** mixes inverse and linear contracts whose `openInterest` fields use entirely different units. Each is converted by two independent derivations that must agree.

### 2. Aggregator providers — for venues that block direct access

Binance and Bybit return **HTTP 451/403 from some regions** (notably the US) as a regulatory compliance measure. Rather than trying to evade that — which is both a compliance control and technically brittle, since exchanges actively ban datacenter IPs — the app reads the same numbers from services that license and redistribute them.

| Provider | Key needed | Adds |
| --- | --- | --- |
| **CoinGecko** | No — free, no signup | Funding + open interest for Binance, Bybit, BingX and other venues that can't be reached directly. |
| **Coinalyze** | Free key | The above plus **long/short ratio** on more venues, deeper OI history, and extra venues. |
| **DefiLlama** | ⚠️ Now paid | `yields.llama.fi/perps` answers HTTP 402 without a subscription. The provider self-disables after two rejections rather than costing latency on every poll. |

**Note on open-interest conventions:** venues here report *single-sided* open interest, matching Binance/Bybit/OKX. Some aggregators sum both sides and so report roughly double — CoinGecko's Aster figure is 1.99× the venue's own. Mixing the two conventions would corrupt every OI-weighted aggregate, so direct readings are preferred wherever available.

To enable Coinalyze, get a key at `coinalyze.net/account/api-key/` and set `COINALYZE_API_KEY` in `.env.local`.

**Merge policy:** a direct adapter always wins over a provider for the same venue — first-hand data is lower latency and isn't subject to an aggregator's own refresh cadence. Providers only fill gaps. Every card shows a `via defillama` / `via coinalyze` badge when its data came second-hand, and the header line breaks down how many venues came from where.

Data redistributed by DefiLlama and Coinalyze — both ask that you cite them, which the UI does.

### On Dune

Dune was considered and deliberately left out. It's a SQL analytics platform over on-chain data: you author a query, it executes against indexed blockchain tables, and you poll for results. That's excellent for bespoke on-chain research — say, tracing wallet-level positioning on a specific perp DEX — but it's a poor fit here. It has no notion of CEX funding rates, query execution is asynchronous and slow relative to a 15-second refresh, and the free tier's credit model doesn't suit continuous polling. If you later want on-chain analysis that these APIs can't answer, Dune is the right tool and belongs as a separate provider rather than in this hot path.

### The "—" is doing real work

Where no source publishes something, the dashboard shows **—** and excludes it from the aggregate. It never fills the gap with an estimate. This is the most important rule in the codebase: a dashboard that silently invents plausible numbers is worse than one that admits what it doesn't know, because you can't tell the difference by looking.

### Why the API calls run server-side

Every exchange request happens in `/api/market-data`, not the browser:

- **No CORS problems.** Most exchange APIs reject browser-origin requests outright.
- **Shared rate limits.** One server making calls for all users, rather than every browser tab hammering Binance independently.

## Optional features

All of these are genuinely optional — the app runs fully without any of them.

### AI market summary

Writes a plain-English read of the current leverage environment. Add to `.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Get a key at [console.anthropic.com](https://console.anthropic.com). **Without a key**, the panel falls back to a deterministic rules-based summary that reads nearly as well and costs nothing.

### Alert delivery

Browser notifications and sound work immediately with no setup. The other three channels need credentials in `.env.local`:

| Channel | Variables | Where to get them |
| --- | --- | --- |
| Discord | `DISCORD_WEBHOOK_URL` | Server Settings → Integrations → Webhooks |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Create a bot via [@BotFather](https://t.me/botfather) |
| Email | `RESEND_API_KEY`, `ALERTS_EMAIL_FROM` | [resend.com](https://resend.com) free tier |

Alerts are evaluated client-side on every poll, with a 5-minute cooldown per rule so a hovering threshold doesn't spam you.

---

## Deploying

The easiest path is [Vercel](https://vercel.com) (same company that makes Next.js, free tier is fine):

1. Push this folder to a GitHub repo.
2. Import the repo at vercel.com.
3. Add your environment variables in the project settings.
4. Deploy.

Nothing in the codebase is Vercel-specific — any Node host works.

---

## Project structure

```
src/
├── app/
│   ├── page.tsx                  Dashboard composition
│   ├── layout.tsx                Root layout, fonts
│   ├── providers.tsx             React Query setup
│   ├── globals.css               Theme, scrollbars, reduced-motion
│   └── api/
│       ├── market-data/          Aggregation endpoint (calls exchanges)
│       ├── ai-summary/           Market narrative (AI or rules-based)
│       └── alerts/notify/        Discord / Telegram / email relay
│
├── components/
│   ├── gauges/                   The four speedometers + shared GaugeBase
│   ├── dashboard/                Heat map, charts, leaderboards, scanner
│   ├── layout/Header.tsx         Asset selector, live badge
│   └── ui/                       Button, Card, Select, Dialog, Tabs…
│
├── lib/
│   ├── exchanges/
│   │   ├── registry.ts           ← single source of truth for all venues
│   │   ├── aggregator.ts         ← fetch, normalize, compute aggregates
│   │   └── adapters/             Per-exchange API clients
│   ├── sentiment/
│   │   ├── compositeIndex.ts     Scoring engine
│   │   └── bands.ts              Labels and interpretation text
│   ├── alerts/engine.ts          Rule evaluation
│   ├── hooks/useMarketData.ts    Polling via React Query
│   ├── store/dashboardStore.ts   Persisted UI state (Zustand)
│   └── utils/                    Formatting, color, gauge trigonometry
│
└── types/market.ts               ← the contract everything conforms to
```

The three files marked `←` are where you'll spend most of your time.

---

## Adding an exchange

Designed as a one-file change:

**1. Write the adapter** in `src/lib/exchanges/adapters/myexchange.ts`. Copy `binance.ts` as a template — fetch, map into `ExchangeSnapshot`, and **return `null` on any failure** rather than throwing. Return `null` for individual fields the venue doesn't publish, too.

**2. Register it** in `src/lib/exchanges/registry.ts`:

```ts
{
  id: "myexchange",
  name: "My Exchange",
  type: "CEX",
  status: "live",
  color: "#FF6B35",
  docsUrl: "https://...",
  assets: ALL_ASSETS,
}
```

**3. Wire it up** in `aggregator.ts`:

```ts
const ADAPTER_MAP = {
  // ...
  myexchange: fetchMyExchange,
};
```

Nothing else changes — cards, gauges, heat map, and leaderboards all read from the registry.

Good candidates with clean public APIs: **Deribit** (`deribit.com/api/v2/public/ticker`), **MEXC**, **HTX**, and **Aevo** (`api.aevo.xyz/markets`).

## How the numbers work

Worth understanding before you trust any of it.

### Funding rate

The periodic payment between longs and shorts that keeps a perpetual future tethered to spot. **Positive funding means longs pay shorts** — the crowd is leaning long. Negative means the reverse.

Venues settle on different schedules — **hourly** on Kraken, Hyperliquid, and dYdX; **every 8 hours** on most CEXs. A raw `-0.01%` means very different things on each: hourly, it's `-0.08%` per 8h — eight times larger.

Everything that ranks, averages, or color-codes funding across venues therefore normalizes to an 8-hour equivalent first, via `fundingPer8h()` in `src/lib/utils/format.ts`. **If you add your own cross-venue calculation, use that helper.** The only places raw rates appear are the heat map tooltip and exchange cards, where the interval is labeled alongside.

Funding is displayed in **basis points** (1 bp = 0.01%), since real-world rates cluster near 0.01% and decimals become unreadable fast.

The aggregate is **open-interest weighted** — a $6B venue should move the number more than a $40M one.

### Open interest

Total notional value of open positions. Rising OI means new money and new leverage entering; falling OI means positions closing.

The gauge shows a **percentile against the trailing window**, not a raw dollar figure, because "$13B" means nothing without knowing whether that's high or low for this asset.

### Leverage heat

A composite of OI growth, funding magnitude, price stall, and liquidation intensity — weighted toward the combination the brief cares about most: **leverage building while price goes nowhere**. That's the setup where a move in either direction cascades.

### Composite sentiment index

0–100, blending funding (25%), open interest (20%), long/short ratio (15%), price momentum (15%), liquidations (15%), and volume turnover (10%).

**The weights are a starting point, not gospel.** They live in `src/lib/sentiment/compositeIndex.ts` — tune them once you've watched the score behave against real markets for a while.

---

## Known limitations

Being upfront about what this does and doesn't cover:

- **Binance and Bybit block some regions** (HTTP 451/403, notably from the US). **OKX does not**, which matters more than it sounds: OKX's `rubik` endpoints are the app's only unauthenticated source of both long/short positioning and open-interest history. If OKX is unreachable from your location too, the OI-percentile and leverage-heat gauges fall back to locally recorded history, and the long/short gauge stays blank until you add a Coinalyze key.
- **Long/short positioning cannot be reconstructed locally.** It's not derivable from open interest or funding — it has to come from a venue that publishes it.
- **No liquidation data.** The earlier version of this dashboard had a liquidation feed built entirely from simulated events. It was removed rather than left in looking real. No free REST endpoint publishes cross-venue liquidations; Binance offers a WebSocket stream (`!forceOrder@arr`) if you want to build it properly.
- **Long/short ratios come from OKX alone** without a Coinalyze key, since Binance and Bybit are geoblocked. It's one venue's account positioning, not a market-wide reading. Most DEXs publish no positioning data at all.
- **Timeframes shorter than 1D resample the same ~7 day window**, since that's the deepest history available from a single call.
- **The funding spread scanner shows gross spreads.** Fees, slippage, and margin costs routinely consume a spread of the size displayed.
- **Funding intervals differ by venue** (1h vs 8h). Everything comparing across exchanges normalizes first, but be careful if you add your own calculations.

## Local history

If no reachable venue publishes open-interest history, the app builds its own: every poll writes a snapshot to `.data/<asset>.json` (one point per 5 minutes, 30-day retention).

| Feature | Needs |
| --- | --- |
| Chart starts drawing | ~10 minutes |
| OI percentile gauge | ~4 hours |
| Leverage heat + 24h OI change | ~20 hours |

Just leave the server running. Delete `.data/` to reset.

**Deploying:** serverless platforms (Vercel, Netlify) have an ephemeral filesystem, so these writes won't persist. Swap the read/write pair in `src/lib/history/store.ts` for Vercel KV, Upstash Redis, or Postgres — nothing else changes.

## Adding more exchanges

Copy `src/lib/exchanges/adapters/binance.ts` as a template, add an entry to `registry.ts`, and register it in `ADAPTER_MAP` in `aggregator.ts`. Nothing else changes — cards, gauges, heat map, and leaderboards all read from the registry.

The rule to follow: **return `null` for anything the venue doesn't publish.** Never substitute a plausible-looking value.

## A note on interpretation

Funding and open interest describe **how traders are positioned**. They do not predict direction.

Crowded positioning is a statement about fragility, not about what happens next — a crowded long market can stay crowded and keep grinding higher for weeks. The genuine signal in this data is *conditional*: when positioning is stretched, moves against the crowd tend to be faster and larger, because liquidations feed on themselves.

Treat this as a tool for understanding market structure. Verify anything you act on against the exchange's own interface.

**Not financial advice.**
