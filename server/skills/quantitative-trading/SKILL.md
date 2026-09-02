---
name: quantitative-trading
description: Use when tasks involve quantitative trading, algorithmic trading, backtesting, alpha/signal design, portfolio construction, position sizing, execution logic, or risk analysis for financial markets.
---

# Quantitative Trading

## Overview
Use a quant lens instead of generic coding or generic finance advice. Structure work around objective, assumptions, data, signal logic, execution, risk, evaluation, and operational constraints.

Default to the user's language. If the user writes in Chinese, respond in Chinese. If the user writes in English, respond in English.

## When to Use
Use this skill when the task includes:
- Quantitative trading or algorithmic trading strategy design
- Backtesting, parameter analysis, performance attribution, Sharpe, drawdown, win rate, turnover
- Position sizing, exposure limits, stop loss, take profit, liquidation risk, capital allocation
- Trading bot logic, signal generation, execution rules, slippage, fees, latency
- Portfolio optimization, factor modeling, regime analysis, market microstructure concerns

Do not use this skill for:
- Pure broker/account setup with no strategy or risk logic
- General investing opinions with no quantitative or implementation component

## Core Working Pattern
For quant tasks, organize thinking in this order:

1. **Objective**
   - What is being optimized: return, Sharpe, drawdown, hit rate, turnover-adjusted pnl, capital efficiency?
2. **Market + Data Assumptions**
   - Venue, instrument, timeframe, fees, slippage, liquidity, latency, survivorship/lookahead assumptions
3. **Signal / Model Logic**
   - Entry, exit, filters, thresholding, confirmation conditions, regime sensitivity
4. **Risk + Position Sizing**
   - Max loss per trade, gross/net exposure, leverage, concentration, correlation, stop conditions
5. **Execution Constraints**
   - Order type, fill assumptions, partial fills, cooldowns, retry logic, trading hours
6. **Evaluation**
   - Return, max drawdown, Sharpe, Sortino, Calmar, win rate, profit factor, turnover, stability by regime
7. **Failure Modes**
   - Overfitting, leakage, unrealistic fills, parameter brittleness, tail risk, silent operational failure

## Response Patterns

### When designing a strategy
Always try to cover:
- Hypothesis: why the edge should exist
- Observable inputs: what data the strategy uses
- Exact entry and exit rules
- Position sizing and exposure caps
- Fees/slippage assumptions
- Backtest plan and validation split
- Key risks and invalidation conditions

### When analyzing backtests
Do not stop at headline return.
Check:
- Maximum drawdown and drawdown duration
- Sharpe/Sortino/Calmar and whether they are stable
- Trade count and sample size adequacy
- Profit concentration: a few trades vs broad consistency
- Regime dependence: trending, mean-reverting, volatile, illiquid periods
- Sensitivity to fees, slippage, and parameter perturbation
- Evidence of lookahead bias, data leakage, or survivorship bias

### When implementing trading logic
Prefer explicit rules over vague placeholders:
- Define signal inputs and thresholds clearly
- Keep position sizing and risk checks visible in code flow
- Validate only at external boundaries; internal calculations should stay clean
- Treat fees, slippage, and fill assumptions as first-class inputs
- Separate signal generation, risk checks, and execution decisions logically

### When discussing risk management
Always consider:
- Per-trade loss budget
- Daily/session loss limit if applicable
- Maximum leverage and exposure by asset
- Correlated positions and cluster risk
- Market gap risk and liquidation risk
- Operational risk: stale data, duplicate orders, missed cancellations

## Quick Reference

| Task type | Minimum structure |
|---|---|
| Strategy idea | Hypothesis → rules → sizing → fees/slippage → validation |
| Backtest review | Metrics → drawdown → robustness → bias checks → improvement ideas |
| Bot implementation | Inputs → signal → risk gate → execution path → state handling |
| Portfolio allocation | Objective → constraints → sizing model → correlation/risk limits |
| PnL diagnosis | Source of returns → concentration → regime split → cost sensitivity |

## Common Mistakes
- Giving generic trading opinions without explicit quantitative assumptions
- Optimizing for return while ignoring drawdown, turnover, or tail risk
- Treating backtest output as valid without checking bias and execution realism
- Suggesting position sizing without capital/risk constraints
- Ignoring fees, slippage, liquidity, and partial fill behavior
- Recommending overfit parameter tuning without out-of-sample validation

## Red Flags
If any of these appear, tighten the analysis:
- "High return" but no drawdown discussion
- "Works in backtest" with no fee/slippage assumptions
- Very high Sharpe with low sample size
- Performance depends on one narrow date range or parameter set
- Strategy rules are described in words but not precise enough to implement
- Risk management is reduced to a stop loss only

## Output Style
Keep answers practical and structured. Prefer bullets, formulas, parameter tables, or pseudo-rules when helpful. Make assumptions explicit. Do not present financial advice as certainty. Frame conclusions as model- and assumption-dependent.
