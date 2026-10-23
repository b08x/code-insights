# Goal: Refactor Mistral Vibe Session Analysis & Plugin Logs

## Objective
Refactor the Mistral Vibe session provider (`cli/src/providers/mistral-vibe.ts`) to discover, parse, and analyze modern Mistral Vibe 3.0+ unified store sessions (`mistral.vibe.unified-session-store/v1` in `~/.vibe/logs/session/unified/`) alongside legacy `messages.jsonl` sessions. Ingest child sessions spawned by plugins (such as `ruby-dev`) with parent linkage and namespaced agent attribution, extracting full conversation history with thinking blocks, tool calls, and exact token usage.

## Shared Understanding
The testable outcomes and verifiable behaviors for this goal are documented in [`facts.md`](facts.md) (with structured metadata in [`facts.meta.json`](facts.meta.json)).

## Execution Plan
The step-by-step implementation order, file scopes, and verification procedures are documented in the approved [`plan.md`](plan.md).

## Done Condition
All 10 accepted facts in [`facts.md`](facts.md) are verified via comprehensive automated unit and regression tests in `cli/src/providers/__tests__/mistral-vibe.test.ts`, the full workspace test suite (`pnpm test`) passes with 0 failures, and the workspace builds cleanly (`pnpm build`).
