# Fixes — model pool pruning + Telegram spam (2026-08-31)

## Problem
`🪦 Hermes: auto-pruned dead model(s) mid-run: nvidia/nemotron-3-ultra-550b-a55b, mistral-large-latest`
kept arriving on Telegram over and over.

### Root cause (loop)
1. The config website keeps the dead models ticked in the Firebase vault (`MODEL_POOL`).
2. `scripts/fbpool.py` re-syncs the vault → `pool.json` **every 60s**, re-adding the models the pruner just removed.
3. `pool/poolctl.py --watch` prunes them again **every 30 min** → sends the exact same Telegram message. Forever.

### Second bug: false pruning of LIVE models
`probe()` fired a `max_tokens: 1` test call and treated **any** HTTP 4xx as "dead".
Reasoning models (e.g. `nvidia/nemotron-3-ultra-550b-a55b`, `mistral-large-latest` → Mistral Large 3)
can reject such a request with HTTP 400 for request-shape reasons even though they work fine —
so perfectly healthy models could be pruned.

## Changes

### `pool/poolctl.py`
- **Smarter probe**: `max_tokens` 1 → 16; the error body is parsed. A model is dead only on a
  definitive model-level error (401/402/403/404, or 400/422 whose message names the model —
  unknown / retired / not entitled). Request-shape 400s, 429 and 5xx fail OPEN (model stays).
  The prune reason is recorded and shown in the alert.
- **Graveyard (bench)**: pruned models are written to `~/.hermes/graveyard.json` with timestamp +
  reason. Benched models are skipped by `load_pool()` and by both vault-sync scripts, so they can
  no longer bounce back in. A grave expires after `GRAVEYARD_TTL_H` (default 24h) → automatic retry.
- **Smart Telegram alerts**: one digest message per NEW death (model + reason + what happens next).
  Per-model dedupe state in `~/.hermes/prune_notified.json` with `PRUNE_NOTIFY_COOLDOWN_H`
  (default 24h) — the same dead model is never announced twice within the cooldown. `tg_notify()`
  also supports `silent=True` (Telegram `disable_notification`).
- Updated the `MISTRAL_MODELS` reference list to the current 2026 aliases
  (adds `magistral-medium-latest`, `magistral-small-latest`).

### `scripts/fbpool.py` + `scripts/model_pool_init.py`
- Both now apply the graveyard filter when taking `MODEL_POOL` from the website vault:
  - benched + fresh → kept out silently (no re-prune, no re-alert)
  - grave older than TTL → allowed back for one retry
  - **pool re-applied on the website after the burial** (`MODEL_POOL_UPDATED` newer than the
    grave) → un-buried immediately: pressing *Apply pool* on the panel is always respected.

### `scripts/firebase_vault.py`
- Forwards `MODEL_POOL_UPDATED` from the vault so the startup init can honour the re-apply rule.

## New env knobs (optional)
- `GRAVEYARD_TTL_H` — hours a pruned model stays benched before auto-retry (default 24)
- `PRUNE_NOTIFY_COOLDOWN_H` — hours before the same dead model may be announced again (default 24)

## Behaviour now
- A model dies mid-run → **one** Telegram digest with the reason, then silence about it.
- The pool keeps running with the healthy models; benched ones auto-retry after the TTL.
- To retry sooner or swap models: config website → Model pool → *Apply pool*.
- No workflow (`hermes.yml`) or panel changes required — everything is backward compatible.
