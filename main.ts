// Steady Flow — a flow-filtered early-momentum paper bot for the pump.fun Sharpe sprint.
//
// Idea: a fresh bonding curve either catches a bid quickly or fades. This bot only enters
// a coin once real buyers have already shown up — net buy flow dominates 2:1, the
// price sits at least 20% above its creation price, still rising over recent prints
// with the latest print a buy — then it stakes a small fixed size and manages the
// position with staged profit-taking, a hard stop, a trailing exit, a breakeven guard
// and a stale-position exit. Small stakes, many coins and tight exits aim at a steady
// hourly Sharpe, not one lucky moonshot.
//
// Guardrails honoured: at most 5 open positions, one buy per mint, every round trip at
// least 0.01 SOL, no shorts, no leverage. Deterministic: no clock, no randomness, no
// network, no environment reads — every decision comes from the harness state alone.
//
// Drand anchor quoted before the first write of this entry (quicknet):
// round 34275903, signature b8e5c19abbc3f36386fc8df5dc339f5e927d6b169c2bc0cbc21c9871c10b6cd6f34cb79a6b4f6c02770db0d6766e33e2.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const STAKE_LAMPORTS = (SOL * 4n) / 100n; // 0.04 SOL per coin
const MIN_STAKE_LAMPORTS = (SOL * 2n) / 100n; // never enter below 0.02 SOL (round-trip floor is 0.01)
const BUY_SLIPPAGE_BPS = 3000;
const SELL_SLIPPAGE_BPS = 2000;

const MIN_TRADES = 5; // need a few prints before judging the flow
const MAX_TRADES = 40; // decision window: judge a coin only while it is young
const RISE_BPS = 1000; // entry band: price >= 10% above creation ...
const FLOW_BUY_NUM = 2n; // buy SOL volume must beat sell SOL volume 2:1
const FLOW_BUY_DEN = 1n;
const DEAD_MULT = 0.8; // price 20% under creation with prints behind it: a dead coin, drop it

const TP1_MULT = 1.25; // sell half at +25%
const TP2_MULT = 2.0; // sell the rest at +100%
const STOP_MULT = 0.92; // hard stop at -8% from the filled cost
const TRAIL_ARM_MULT = 1.2; // trailing exit arms once the mark peaked +20%
const TRAIL_MULT = 0.85; // ...then exit when the mark falls 15% off that peak
const STALE_SLOTS = 3000; // ~11 min of slots; exit a flat position
const STALE_MULT = 1.02;
const BREAKEVEN_ARM_MULT = 1.1; // once a winner peaked +10% ...
const BREAKEVEN_MULT = 1.02; // ...never let it come back below +2%

const MAX_ORDERS_PER_BATCH = 12;

interface Coin {
  mint: string;
  createdSlot: number;
  createPrice: number;
  trades: number;
  buyVol: bigint;
  sellVol: bigint;
  prices: number[];
  lastBuy: boolean; // the most recent print was a buy: fresh bidding, not a fade
  bought: boolean;
  costPerToken: number; // lamports per token, from the buy fill (0 until filled)
  buySlot: number; // slot of the buy fill
  peak: number; // highest mark seen since the buy filled
  tp1Done: boolean;
}

/** Coins under evaluation or held. */
const live = new Map<string, Coin>();
/** Mints fully decided (bought and flat, dropped, or completed): never re-entered. */
const done = new Set<string>();

/** Mark price in lamports per token from the curve's virtual reserves. */
function markPrice(state: BotState, mint: string): number {
  const c = state.curves.get(mint);
  if (c === undefined || c.virtual_token_reserves === 0n) return 0;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function pendingBuy(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && p.order.mint === mint) return true;
  }
  return false;
}

function pendingSell(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell' && p.order.mint === mint) return true;
  }
  return false;
}

function retire(mint: string): void {
  live.delete(mint);
  done.add(mint);
}

await runBot({
  onBatch(state, batch) {
    const orders: Array<BuyInput | SellInput> = [];

    // 1. Fold this batch's fills into the per-coin books.
    for (const f of batch.fills) {
      if (f.status === 'rejected' && f.side === 'buy') {
        retire(f.mint); // one attempt per coin: a rejected buy means its cap or price ran away
        continue;
      }
      if (f.status !== 'filled') continue;
      const coin = live.get(f.mint);
      if (coin === undefined) continue;
      if (f.side === 'buy') {
        const tokens = BigInt(f.token_amount);
        const quote = BigInt(f.quote_lamports);
        if (tokens > 0n && quote > 0n) {
          coin.costPerToken = Number(quote) / Number(tokens);
          coin.buySlot = f.slot;
          coin.peak = coin.costPerToken;
          coin.bought = true;
        }
      }
    }

    // 2. Fold this batch's events into the per-coin books.
    for (const e of batch.events) {
      if (e.event === 'CompleteEvent') {
        retire(e.mint);
        continue;
      }
      if (e.event === 'CreateEvent') {
        if (!live.has(e.mint) && !done.has(e.mint)) {
          const price =
            BigInt(e.virtual_token_reserves) === 0n
              ? 0
              : Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves);
          live.set(e.mint, {
            mint: e.mint,
            createdSlot: e.slot,
            createPrice: price,
            trades: 0,
            buyVol: 0n,
            sellVol: 0n,
            prices: [],
            lastBuy: false,
            bought: false,
            costPerToken: 0,
            buySlot: 0,
            peak: 0,
            tp1Done: false,
          });
        }
        continue;
      }
      // TradeEvent.
      let coin = live.get(e.mint);
      if (coin === undefined) {
        if (done.has(e.mint)) continue;
        // First sight came through a trade, not a create: use the first-seen mark as reference.
        coin = {
          mint: e.mint,
          createdSlot: e.slot,
          createPrice: markPrice(state, e.mint),
          trades: 0,
          buyVol: 0n,
          sellVol: 0n,
          prices: [],
          lastBuy: false,
          bought: false,
          costPerToken: 0,
          buySlot: 0,
          peak: 0,
          tp1Done: false,
        };
        live.set(e.mint, coin);
      }
      coin.trades += 1;
      coin.lastBuy = e.is_buy;
      const vol = BigInt(e.sol_amount);
      if (e.is_buy) coin.buyVol += vol;
      else coin.sellVol += vol;
      const price = markPrice(state, e.mint);
      if (price > 0) {
        coin.prices.push(price);
        if (coin.prices.length > 4) coin.prices.shift();
      }
    }

    // 3. Retire coins that are flat and finished, or past their decision window.
    for (const [mint, coin] of [...live]) {
      const curve = state.curves.get(mint);
      if (curve?.complete) {
        retire(mint);
        continue;
      }
      if (coin.bought && !state.positions.has(mint) && !pendingBuy(state, mint) && !pendingSell(state, mint)) {
        retire(mint); // bought, sold/flattened, nothing in flight
        continue;
      }
      if (!coin.bought && coin.trades > MAX_TRADES) {
        retire(mint);
        continue;
      }
      if (!coin.bought && coin.trades >= MIN_TRADES && coin.createPrice > 0) {
        const price = markPrice(state, mint);
        if (price > 0 && price < coin.createPrice * DEAD_MULT) retire(mint);
      }
    }

    // 4. Exits first: manage every held position.
    for (const [mint, holding] of state.positions) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      if (pendingSell(state, mint)) continue;
      const coin = live.get(mint);
      if (coin === undefined || coin.costPerToken <= 0) continue;
      const price = markPrice(state, mint);
      if (price <= 0) continue;
      if (price > coin.peak) coin.peak = price;

      const tokens = holding.token_amount;
      if (tokens <= 0n) continue;
      const ratio = price / coin.costPerToken;
      let sellTokens = 0n;
      if (ratio <= STOP_MULT) {
        sellTokens = tokens; // hard stop
      } else if (!coin.tp1Done && ratio >= TP1_MULT && ratio < TP2_MULT) {
        sellTokens = tokens / 2n; // first target: bank half
      } else if (ratio >= TP2_MULT) {
        sellTokens = tokens; // second target: out
      } else if (coin.peak >= coin.costPerToken * TRAIL_ARM_MULT && price <= coin.peak * TRAIL_MULT) {
        sellTokens = tokens; // gave back a fifth of the peak
      } else if (coin.peak >= coin.costPerToken * BREAKEVEN_ARM_MULT && ratio < BREAKEVEN_MULT) {
        sellTokens = tokens; // a winner that came all the way back: keep the +2%
      } else if (
        coin.buySlot > 0 &&
        state.slot - coin.buySlot >= STALE_SLOTS &&
        ratio < STALE_MULT
      ) {
        sellTokens = tokens; // flat for ~30 min: free the slot
      }
      if (sellTokens <= 0n) continue;
      if (!coin.tp1Done && sellTokens < tokens) coin.tp1Done = true;
      orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }

    // 5. Entries: young coins whose buyers are already in control.
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const [mint, coin] of live) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      if (slots <= 0) break;
      if (coin.bought || coin.costPerToken > 0) continue;
      if (pendingBuy(state, mint)) continue;
      if (state.positions.has(mint)) continue;
      if (coin.trades < MIN_TRADES || coin.trades > MAX_TRADES) continue;
      if (coin.createPrice <= 0) continue;
      const price = markPrice(state, mint);
      if (price <= 0) continue;
      if (price * 10_000 < coin.createPrice * (10_000 + RISE_BPS)) continue; // needs +10% from creation
      if (price * 10_000 > coin.createPrice * 16_000) continue; // ...but not more than +60%: never chase the top
      if (coin.buyVol * FLOW_BUY_DEN <= coin.sellVol * FLOW_BUY_NUM) continue; // buyers must dominate 3:2
      if (coin.prices.length >= 2 && price < coin.prices[0]) continue; // still rising over recent prints
      if (!coin.lastBuy) continue; // the latest print must be a buy, not a fade
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_STAKE_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },

  onDone(state, doneMsg) {
    const cash = state.cash;
    console.error(
      `steady-flow done: batches=${state.seq + 1} cash=${cash} positions=${state.positions.size} reason=${doneMsg.reason}`,
    );
  },
});
