# ML phase verification — 2026-11-10

## Executed checks

- Node suite against a real isolated MongoDB replica set: 28 passed, 0 failed, 0 skipped.
- Python Docker suite: 4 passed. Includes chronological target boundaries, past-only feature behavior, reproducible training, artifact round-trip, missing-model fallback, invalid inputs and zero-demand WAPE handling.
- Default 100-epoch synthetic training completed and selected PyTorch on validation MAE. Exact evaluation is in ml-evaluation.json.
- Existing demo migration recognized all 60 original synthetic seed series without modifying their quantities. One prior verification fixture received a conservative observation start.
- ML /health returned ready=true, artifactLoaded=true, fallbackReason=null.
- Headless HTTP demo against real MongoDB, Kafka, Python service and Socket.IO passed:
  - warehouseId: 6af2cab775c3f66b559a1818
  - forecastRunId: 6af31add725f87bc02d9d155
  - successful product forecasts: 60
  - matching Socket.IO forecast notifications: 60
  - surgeRunId: 6af31adf725f87bc02d9d280
  - live stock depleted and projected shortfalls increased for the three surge products while forecast IDs stayed fixed
  - explicit deterministic assistant returned validated stock-risk widgets
- API, ML, MongoDB and Kafka health checks passed. Outbox, workers, forecast worker and simulator were running.

The first surge verification exposed global simulator product selection: an unrelated warehouse fixture displaced one demo SKU. The simulator now selects products stocked in the run's warehouse. The corrected full-stack verification passed.

## Test coverage distinctions

Node database tests verify checkpoint gating on unpublished events, zero filling after projection, idempotent concurrent job submission, overlap rejection, partial results, preservation after failed inference, expired-lease recovery and owner fencing. Provider transport is mocked in the Groq tool-loop tests; these cover grounding, unsupported tools, scope overrides, call budgets, unavailable configuration and provider failures.

Follow-up live Groq verification passed all six supported questions using openai/gpt-oss-120b and the user's configured key, supplied only to an ephemeral test process. Tests invoked the assistant service inside the API container against the real demo database and Groq API; they did not configure credentials in the persistent HTTP service. Configuration files were unchanged.

The live tests exposed and fixed two issues: tool-enabled final JSON generation could cause an invalid `json` tool call, and full demand history exceeded the account's request token allowance. Evidence retrieval now uses tools, then final response generation uses JSON mode without tools. Provider requests receive compact evidence while API responses retain full history. Regression tests cover both behaviors.

Final live results: stock risk 1655 ms; flagged product 1841 ms; pending orders 1673 ms; bin locations 1389 ms; demand history 1350 ms; backlog 1633 ms. These are individual observed test durations, not a performance benchmark. All returned validated evidence-backed responses and appropriate widget descriptors. The full Node suite after these fixes passed 29 tests, with no failures or skips.

The test dataset is synthetic. No production-scale throughput, high availability, real-world forecast accuracy or calibrated stockout probability is claimed.
