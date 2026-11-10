# ML and assistant contracts

## Python inference (internal only)

`POST /v1/forecasts` accepts `warehouseId`, `productId` (24-character MongoDB ID strings), `horizonDays` (integer 1–7), and `history` (28–730 records). Each record has `date` (valid YYYY-MM-DD) and `requestedUnits` (integer 0–1,000,000,000). Dates must be consecutive, strictly ordered, and earlier than today in UTC. The forecast starts the day after the final history date. Extra fields, booleans as quantities, duplicate dates, gaps and non-finite numbers are rejected with 422.

Response fields: `productId`, `modelVersion`, `method` (`pytorch` or `baseline`), `baselineMethod` (`moving_average`, `same_weekday`, or null for PyTorch), `fallbackReason` (nullable), `inputThroughDate`, and `predictions` (exactly the requested number of consecutive future dates and finite nonnegative `predictedUnits`). Node validates product identity, dates, length and method metadata before saving. Node uses a ten-second request timeout.

`GET /health` reports readiness, artifact availability and fallback reason. Missing/corrupt/incompatible trusted local artifacts use the moving-average baseline. Fewer than 28 complete days produce insufficient history, not fabricated predictions. Restart the ML service after training to load the newly published CURRENT artifact pointer. Artifacts are internal files, never uploaded by API clients.

## Public Node APIs

All routes use existing session cookies and warehouse authorization. POST requests require the configured Origin and X-CSRF-Token. Success bodies use `{data: ...}`; stock-risk lists additionally return `nextCursor` and `capturedAt`. Errors use the existing `{error: {code, message, requestId}}` envelope.

| Method | Path | Contract |
| --- | --- | --- |
| POST | `/api/v1/forecast-runs` | `{warehouseId}`, Idempotency-Key required; admin/manager; 202 run record |
| GET | `/api/v1/forecast-runs/:id` | Warehouse-scoped run status and product results |
| GET | `/api/v1/forecasts?warehouseId=...&productId=...` | Last successful forecast, freshness and latest refresh result |
| GET | `/api/v1/forecasts/:id` | Immutable saved forecast |
| GET | `/api/v1/stock-risks?warehouseId=...` | Optional productId, limit 1–100 (default 50), cursor; ascending product ID |
| GET | `/api/v1/demand?warehouseId=...&productId=...` | Newest daily demand records; limit 1–730 (default 90), provenance counters |
| POST | `/api/v1/assistant/messages` | `{warehouseId, question, mode, productId?, orderId?}`; mode live/default or demo; 10 requests/minute/user |

Forecast-run status: QUEUED → RUNNING → SUCCEEDED/PARTIAL/FAILED, or WAITING_FOR_INGESTION while retrying incomplete checkpoints. Only one active run per warehouse is permitted (409 on overlap). Idempotency replay returns the original acceptance record; GET the run for current status. Terminal failed/partial runs can be retried by submitting a new key; completed successful records remain immutable. Empty warehouses complete with an empty results list.

The worker schedules one run for each warehouse/reporting day, polls every five seconds, and resumes expired 60-second leases after a crash. Each product result and its forecast event are committed in the same MongoDB transaction. A crash before persistence can repeat inference; it cannot duplicate a saved product result for that run. Failed products preserve their prior forecast. A later explicit refresh is a new version, not a duplicate of an earlier run.

## Observation and completeness

Observation starts with the first complete UTC day after an ordinary receipt or demand request. Seeded history explicitly establishes its historical observation interval. The migration recognizes only the exact original 120-day seed; it does not overwrite quantities. Unrecognized legacy series start observation conservatively after migration. Existing simulator quantities that predate provenance tracking remain unclassified.

The run creation transaction increments the same global sequence counter used by all event writers. This fences in-flight event transactions. Before reading history, the worker verifies that every DemandRequested outbox record for this warehouse, at or below the checkpoint and before the end-of-day cutoff, has a demand-aggregation processed marker. This includes unpublished events. Marker insertion and demand projection effects are atomic. History and completeness are read in one snapshot transaction. Normal commands assign event times after acquiring the sequence counter; callers cannot backdate events.

Missing days become zero only inside that verified observation interval. Incomplete ingestion defers the active refresh and exposes INGESTION_INCOMPLETE. This implementation depends on retaining the outbox and processed ledger; do not prune either without introducing durable completeness checkpoints. Direct database imports/backdated events require an explicit observation/completeness migration.

## Risk and freshness

Freshness is CURRENT only when inputThroughDate equals yesterday in UTC; otherwise STALE or UNAVAILABLE. Failed refresh state is reported independently of the age of the last successful forecast.

Available stock is onHand minus reserved, summed across bins. For lead times up to seven days, compare cumulative predicted demand with available units, report projected shortfall and the first day cumulative demand exceeds availability. Incoming inventory is assumed zero. For longer lead times return UNSUPPORTED_LEAD_TIME with seven-day coverage and fullLeadTimeRiskAvailable=false. Stale forecasts never receive a current shortfall/covered classification. This is a heuristic, not a calibrated probability or purchase-order recommendation. Low-stock threshold status remains a separate field from forecast risk.

Risk is calculated on reads from live stock and the last saved forecast. The frontend must refetch risk after inventory.updated and forecast.updated. Forecast events use the existing Kafka outbox and authorized Socket.IO bridge, with `{id, version}` notifications.

## Assistant grounding

Live mode uses Groq's chat-completions API with six allowlisted local read-only tools. User scope is injected server-side, never accepted from model tool arguments. Queries and result sizes are bounded. The selected product/order IDs are optional request context; no conversation memory is persisted.

The model selects tools and evidence-backed explanation kinds. Its final JSON must reference an actual source ID with the correct explanation kind. The server renders the explanation and every numerical statement from that source. This deliberately constrained natural-language interface supports the six brief question categories, not unrestricted warehouse reasoning. Backlog counts do not establish staffing/capacity causes.

Responses include mode, provider, explanations, sources with timestamps, validated widget descriptors, usage and durationMs. Widget types: inventory_summary, stock_risk_table, demand_chart, order_list. Unknown widget types and ungrounded evidence references are rejected. Frontend rendering is deferred.

Budgets: six tool calls, 20-second total response deadline, 2,000 question characters, 48 KB per tool result, 64 KB Groq response, 1,000 generated tokens per provider call. Live failures do not silently become demo responses. GROQ_API_KEY and GROQ_MODEL are required for live mode. Demo mode must be requested explicitly and is labelled deterministic-demo.

Provider integration follows [Groq local tool calling](https://console.groq.com/docs/tool-use/local-tool-calling). Artifact loading uses [PyTorch weights-only loading](https://docs.pytorch.org/docs/stable/generated/torch.load.html) and inference mode; only locally generated artifacts are supported.
