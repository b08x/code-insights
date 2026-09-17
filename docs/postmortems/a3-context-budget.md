```
═══════════════════════════════════════════════════════════════
                    A3 PROBLEM ANALYSIS
═══════════════════════════════════════════════════════════════

TITLE: Context budget is a transport-level byte count spent at
       four uncoordinated callsites
OWNER: Robert Pannick
DATE: 2026-09-13
STATUS: Open
```

```
┌─────────────────────────────────────────────────────────────┐
│ 1. BACKGROUND (Why this matters)                            │
└─────────────────────────────────────────────────────────────┘
```

Every LLM-facing path in `server/src/llm/` and `server/src/routes/agent.ts` must decide what to
send and what to drop. Each one currently decides alone, using a different mechanism, against a
cost unit (`text.length / 4`) that carries no information about what the content is worth.

Consequences visible in the code and in recent commit history:

- `288c083 fix: optimize agent memory search and stream responsiveness` — the agent context fill
  was tuned by lowering hardcoded counts, not by measuring what fit.
- Two of the four paths discard the *tail* of a conversation, which is where the resolution of a
  debugging session lives.
- The retrieval layer computes a value signal (RRF rank), then throws it away before context
  assembly, so a rank-1 session and a rank-9 session are packed identically.

```
┌─────────────────────────────────────────────────────────────┐
│ 2. CURRENT CONDITION (Facts, from source)                   │
└─────────────────────────────────────────────────────────────┘
```

**Four independent budget mechanisms, no shared accountant:**

| Path | File:line | Mechanism | Drops |
|---|---|---|---|
| Session analysis | `analysis.ts:112` → `chunkMessages:418` | Token-aware chunking at `MAX_INPUT_TOKENS * 0.8`, responses merged | Nothing (multi-call) |
| Facet extraction | `facet-extraction.ts:45` | Proportional character slice + `[... truncated ...]` marker | Conversation tail |
| Prompt quality | `prompt-quality-analysis.ts:65` | Byte-identical duplicate of the above | Conversation tail |
| Agent memory | `agent.ts:138,144,163` | Fixed counts: 1 session/query, `LIMIT 20` messages, `.slice(0,3)` results | Everything past the count |

**The cost unit is uniform per character.** All three providers implement the same estimator:

```ts
estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
// anthropic.ts:79, openai.ts:58, gemini.ts:82 — identical
```

A 2000-character tool-result dump and a 2000-character architectural decision cost the same.

**Magic numbers, unowned:**
- `MAX_INPUT_TOKENS = 80000` (`analysis-internal.ts:41`) — one constant for every model.
- `0.8` safety factor — repeated at 4 callsites.
- `LIMIT 20` / `slice(0,1)` / `slice(0,3)` — `agent.ts`, no derivation.
- `chunkMessages` already knows tool results are bulky (`.slice(0, 500)`) and thinking blocks are
  bulky (`.slice(0, 1000)`), but encodes that as inline truncation rather than as cost.

**Known drift:** `agent.ts:43` docstring says "top 2 sessions per query"; `agent.ts:138` slices to 1.
The limits are not traceable to any stated intent.

```
┌─────────────────────────────────────────────────────────────┐
│ 3. GOAL/TARGET                                              │
└─────────────────────────────────────────────────────────────┘
```

1. One object owns "how much context remains" — injectable, testable, per-request.
2. Cost is a function of content class, not character count.
3. Exhaustion triggers a defined fallback (summarize-and-reset), never a blind tail slice.
4. Zero duplicated truncation blocks.
5. Budget derives from the active model's real window, not a global constant.
6. Every drop decision is traceable: which item, what cost, what remained.

```
┌─────────────────────────────────────────────────────────────┐
│ 4. ROOT CAUSE ANALYSIS (5 Whys)                             │
└─────────────────────────────────────────────────────────────┘
```

**Problem:** context assembly is imprecise — it either truncates arbitrarily or under-fills.

- **Why 1:** the budget is enforced at each callsite by an ad-hoc limit (char slice, `LIMIT 20`,
  `slice(0,1)`) rather than centrally.
- **Why 2:** there is no object that owns remaining capacity, so there is nothing to centralize to.
- **Why 3:** the only cost primitive available is `length / 4`, which is not worth centralizing —
  it answers "how many bytes" but not "should this be here".
- **Why 4:** cost was defined at the transport layer (bytes on the wire) instead of the semantic
  layer (what this content contributes to the answer).
- **Why 5:** the codebase has no model of context *value*. RRF rank is the one value signal that
  exists, and retrieval discards it before assembly (`agent.ts:135` maps entries to bare ids).

**ROOT CAUSE:** No semantic cost function and no shared accountant. Budget is therefore spent
locally and blindly, four times over.

**Contributing factors (fishbone):**
- *Technology:* no real tokenizer; `length/4` was the path of least resistance.
- *Process:* the third truncation block was added by copy from the second (comment at
  `facet-extraction.ts:42` says "same pattern as PQ analysis").
- *Design:* the RRF fusion layer and the context-assembly layer have no shared data structure.

```
┌─────────────────────────────────────────────────────────────┐
│ 5. COUNTERMEASURES                                          │
└─────────────────────────────────────────────────────────────┘
```

The `CognitiveGas` design supplies all four missing pieces: a single accountant, a feature-derived
cost function, a defined exhaustion signal, and a reset hook for compression. Port the structure,
not the constants.

**Immediate — build the accountant**

1. `server/src/llm/context-budget.ts` — `ContextBudget` class mirroring `CognitiveGas`:
   `charge(item)`, `chargeBatch(items)`, `remaining`, `exhausted`, `run(fn)` (throws
   `ContextExhaustedError`), `reset()`. Constructed per request, not global. No mutex needed —
   Node is single-threaded per request; drop that part of the Ruby design.
2. Cost function keyed on code-insights' analogue of `PROCESS_COSTS`. The discriminator already
   exists as `message.type`:

   | Content class | Rationale | Weight |
   |---|---|---|
   | human prompt | intent-bearing, dense | high value / low cost |
   | assistant prose | reasoning, decisions | high value / low cost |
   | thinking block | already capped at 1000 chars | medium |
   | tool_result | bulk, low information density | high cost |

3. **Keep tokens as the hard constraint.** Charge in real tokens; use the semantic weights as a
   *priority* score for what to evict, not as a replacement currency. See the caveat below.

**Short-term — collapse duplication**

4. Delete the truncation blocks at `facet-extraction.ts:45` and `prompt-quality-analysis.ts:65`;
   both call one budget-driven selector that evicts lowest-priority items, not the tail.
5. Replace `MAX_INPUT_TOKENS = 80000` with a per-model window table; the `0.8` factor becomes one
   named constant (`RESERVE_FRACTION`) owned by `ContextBudget`.
6. Replace the real estimator: `gpt-tokenizer` for OpenAI, Anthropic's `count_tokens`, Gemini's
   `countTokens`. Keep `length/4` only as the offline fallback.

**Short-term — carry the value signal through**

7. `agent.ts:onMemoriesSearch` returns RRF score alongside id. Replace `slice(0,1)` / `LIMIT 20` /
   `slice(0,3)` with: iterate RRF-ranked sessions, charge each against the budget, stop on
   exhaustion. This is the change that makes the fill adaptive instead of tuned-by-hand.
8. Fix the `agent.ts:43` docstring/behavior drift as part of the same edit.

**Long-term**

9. Rolling synthesis: on exhaustion, summarize the charged set, `reset()`, continue — rather than
   dropping. This is the reason `CognitiveGas#reset!` exists and is the highest-value part of the
   design to copy.
10. Emit each charge decision to the telemetry route so budget behavior is observable.

```
┌─────────────────────────────────────────────────────────────┐
│ 6. IMPLEMENTATION PLAN                                      │
└─────────────────────────────────────────────────────────────┘
```

| Phase | Work | Depends on |
|---|---|---|
| 1 | `ContextBudget` + cost function + unit tests | — |
| 2 | Real tokenizers per provider; per-model window table | — (parallel with 1) |
| 3 | Collapse the two duplicate truncations onto the budget selector | 1, 2 |
| 4 | RRF score plumbed through `onMemoriesSearch`; budget-driven fill | 1 |
| 5 | Rolling synthesis on exhaustion | 3, 4 |
| 6 | Telemetry on charge decisions | 1 |

Phases 1 and 2 are independent and are the whole prerequisite set. Phase 3 is where the duplication
actually disappears; phase 4 is where behavior visibly improves.

```
┌─────────────────────────────────────────────────────────────┐
│ 7. FOLLOW-UP (Verification & Prevention)                    │
└─────────────────────────────────────────────────────────────┘
```

**Success metrics**
- Truncation blocks in `server/src/llm/`: 3 → 0 (grep `\[\.\.\. conversation truncated`).
- Hardcoded context limits in `agent.ts`: 3 → 0.
- Token estimate error vs. provider-reported `input_tokens`: measurable, then bounded. Currently
  unmeasured — establish the baseline in phase 2 before claiming improvement.
- Context utilization at analysis time: currently unknown; target a stated floor once observable.

**Verification**
- Unit tests: budget exhausts at the stated point; eviction order matches priority, not position.
- Regression: a long tool-heavy session must retain its final assistant message — the current
  proportional slice does not guarantee this.

**Prevention**
- Any new LLM callsite takes a `ContextBudget`; no callsite computes its own limit.
- `.claude/rules/gotchas.md` records that `length/4` is a fallback, never the accounting unit.

```
┌─────────────────────────────────────────────────────────────┐
│ CAVEAT ON THE CognitiveGas COST MODEL                       │
└─────────────────────────────────────────────────────────────┘
```

Two properties of the pasted design do not transfer cleanly, and one factual note:

1. **`TOKEN_CAP = 20` makes cost sublinear in length.** A 2000-token tool dump and a 20-token one
   charge identically. For SFL clauses — short, roughly uniform — that cap is defensible. For
   code-insights, tool results are the dominant consumer (`chunkMessages` already hard-slices them
   at 500 chars), so an uncapped or weighted-linear token term is required. Copying `TOKEN_CAP`
   verbatim would reproduce the current imprecision in a new costume.

2. **Gas units do not enforce a context window.** An exhausted gas budget does not prove the
   payload fits the model's window, and a non-exhausted one does not prove it overflows. If gas
   replaces tokens as the constraint, overflow becomes possible again. Hence countermeasure 3:
   tokens are the constraint, semantic weight is the prioritizer.

3. **`SFL::Compiler::CognitiveGas` is not implemented in sfl-engine.** The only occurrence in that
   repository is a comment at `lib/sfl/llm/engine.rb:14`. The pasted code is a design, not a
   shipped component with operating history — its weights (3/2/1, `TOKEN_CAP = 20`,
   `DEFAULT_BUDGET = 1000`) are asserted, not measured. Port the structure and calibrate the
   numbers here against real sessions.
```

═══════════════════════════════════════════════════════════════
```
