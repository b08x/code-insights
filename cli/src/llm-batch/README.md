# llm-batch

Batch clients for Mistral and OpenRouter plus `submitAndAwait`, the provider-independent driver.
Everything below was read from the live docs on 2026-09-30. Nothing was called with a real key.

```
submitAndAwait(backend, requests, { resync, pollIntervalMs, timeoutMs, signal })
  split into jobs (backend.maxRequestsPerJob) -> submit -> poll to terminal state
  -> reconcile rows by custom_id -> failed/missing rows re-run via `resync` (normal sync transport)
```

Job-level failure (failed / expired / cancelled) throws `BatchJobError` (carries `partialRows`);
a missed deadline throws `BatchTimeoutError` after a best-effort cancel. Row-level failure never throws.
Each request body is `{ messages, temperature? }`: the same body the sync transports send
(temperature 0.7). `stream`, empty input, and `max_tokens < 1` are rejected by OpenRouter batch.

## Mistral (verified)

Sources: https://docs.mistral.ai/capabilities/batch/ , https://docs.mistral.ai/api/endpoint/batch , https://docs.mistral.ai/openapi.yaml

| Step | Request | Notes |
|---|---|---|
| Create | `POST https://api.mistral.ai/v1/batch/jobs` body `{ endpoint: "/v1/chat/completions", model, requests: [{custom_id, body}], timeout_hours, metadata }` | Inline `requests` max 10,000 per OpenAPI (docs: "fewer than 10,000"); client uses 9,999. `model` is per job (one model per batch). `model` inside `body` is optional. `timeout_hours` 1-168, default 24; the job becomes `TIMEOUT_EXCEEDED` if not done. `metadata` keys <= 32 chars, values <= 512 chars. |
| Poll | `GET /v1/batch/jobs/{id}?inline=true` | Status enum: `QUEUED RUNNING SUCCESS FAILED TIMEOUT_EXCEEDED CANCELLATION_REQUESTED CANCELLED`. Job fields: `output_file`, `error_file`, `outputs` (inline results), `errors[{message,count}]`, `total/completed/succeeded/failed_requests`. Results are only accessible once the whole batch completes. |
| Download | `GET /v1/files/{file_id}/content` | JSONL, one row per request. |
| Cancel | `POST /v1/batch/jobs/{id}/cancel` | |

Success row (from the docs' sample output):
`{"id":"batch-...","custom_id":"0","response":{"status_code":200,"body":{<chat.completion incl. usage>}},"error":null}`

Limits and pricing: no maximum number of jobs; up to 1M requests per job via file upload (not implemented here);
batches may slightly exceed a workspace spend limit; available for all models; 50% discount
(https://docs.mistral.ai/capabilities/batch/ intro and FAQ). Cost per row = 0.5 x `calculateAnalysisCost` list price.
Mistral models in `constants/llm-providers.ts` carry no prices, so that cost is currently 0 (same as sync).

## OpenRouter (verified; launched 2026-09-22)

Sources: https://openrouter.ai/docs/batch-quickstart , https://openrouter.ai/blog/announcements/batch-api/ ,
https://openrouter.ai/docs/api/api-reference/batch/create-a-batch , https://openrouter.ai/docs/api/api-reference/batch/get-a-batch

| Step | Request | Notes |
|---|---|---|
| Create | `POST https://openrouter.ai/api/v1/batches` body `{ endpoint: "/v1/chat/completions", model, completion_window: "24h", requests: [{custom_id, body}] }` | `custom_id` unique per batch. `requests` must be serialized LAST (the server stream-parses; `requests` first gives 400). `completion_window` only accepts `24h`. Optional `provider: {only: [...]}`. Returns 202 with `status: "validating"`. |
| Poll | `GET /api/v1/batches/{id}` | Status: `validating -> in_progress -> finalizing -> completed`; also `failed`, `expired`, `cancelling`, `cancelled`. Terminal: completed, failed, expired, cancelled. `results` is non-null ONLY on `completed` (inline array, no download endpoint). `error: {code, message}`. `request_counts {total, completed, failed}`. `usage {prompt_tokens, completion_tokens, total_tokens, cost, is_byok}`. |
| Delete | `DELETE /api/v1/batches/{id}` | Not used. Results are kept 30 days (then 410). |

Result row: `{id, custom_id, response: {status_code, request_id, body: <chat.completion>}, error: null}`; exactly one of `response`/`error` is set.
A batch runs on a single provider (cheapest eligible by default). Per-request rule violations (stream, empty input,
max token cap < 1, web search plugins, `:online` models, ...) are rejected AFTER the 202: the whole batch becomes `failed`
with `error.message`; an `:online` model is rejected at submit with 422.

Pricing: typically 50% of standard per-token pricing; `usage.cost` is the amount OpenRouter charges (BYOK: only the BYOK fee,
estimated provider cost in `usage.cost_details`). The client splits `usage.cost` across successful rows by token share
so per-session costs sum to the authoritative total; without `usage.cost` it falls back to 0.5 x list price.

## Unverified (isolated behind the backend interface, covered by fixture tests)

- Mistral output/error JSONL row layout beyond the documented success sample. Error rows are parsed leniently:
  any non-null `error`, non-200 `response.status_code`, or missing content is a failed row. The fixture in
  `__tests__/mistral.test.ts` encodes the assumption `{custom_id, response: null, error: {message}}`.
- Mistral: whether `outputs` is actually populated for inline jobs with `?inline=true` (OpenAPI says "return results inline");
  the client uses it when present and otherwise downloads `output_file`. Whether FAILED/TIMEOUT_EXCEEDED/CANCELLED jobs expose partial output files.
- OpenRouter: maximum requests or payload size per batch (none documented; `maxRequestsPerJob` is unbounded),
  the cancel endpoint (`POST /batches/{id}/cancel` is a guess; errors are swallowed), per-row error object shape
  (`{code, message}` assumed from the batch-level `error`), which models have a batch endpoint (docs mention a `:batch` model filter; not needed to submit).
- Rate limits on the batch endpoints themselves (neither provider documents them on the pages read; 429 during polling is retried up to 3 times).
- Context7 (plugin server) did not load in this session (`ToolSearch` found no `mcp__plugin_context7_*` tools); all facts come from the pages above via ctx_fetch_and_index and the Mistral OpenAPI YAML.
