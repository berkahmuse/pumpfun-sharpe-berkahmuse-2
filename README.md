# Steady Flow — Pump.fun Sharpe Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/berkahmuse/pumpfun-sharpe-berkahmuse-2/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/berkahmuse/pumpfun-sharpe-berkahmuse-2/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
competition on make.fun: one strategy program (`main.ts`, Node 22) trading paper SOL on a
6-hour pump.fun forward replay, ranked by hourly Sharpe ratio.

## Strategy

A fresh bonding curve either catches a bid quickly or fades. Steady Flow only enters a
coin once real buyers have already shown up:

- at least 6 prints in, still inside its first 60 trades;
- price at least 10% above its creation price and still rising over recent prints;
- buy SOL volume beating sell SOL volume 3:2.

It stakes a small fixed size (0.04 SOL) per coin, at most 5 open positions, one buy per
mint, and manages each position with staged profit-taking (sell half at +50%, the rest
at +120%), a hard stop (-28%), a trailing exit (armed at +35% peak, out on a 25% pullback
from the peak), and a stale-position exit (flat for ~30 min of slots).

## Layout

- `main.ts` — the strategy (entrypoint, run by the grader as `node /bot/main.ts`).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim, copied byte for byte.

## Local grade

From the competition kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/this/repo --driver process
```

## License

MIT — see [LICENSE](LICENSE).
