# WarehouseOS

A connected React/Three.js warehouse workspace with an Express backend, MongoDB replica-set transactions, Kafka, Socket.IO, Python/PyTorch forecasting, and independently runnable workers. The backend implements warehouse inventory, reservations, partial picking, packing, dispatch, pre-pick cancellation, durable command replay, demand aggregation, analytics, low-stock alerts, and bounded simulation.

## Start

```sh
touch .env
# Environment files are intentionally excluded from this repository.
# Set SEED_PASSWORD to a development password with at least 16 characters.
docker compose up -d --build
docker compose --profile tools run --rm seed
node --env-file=.env apps/server/src/demo.js
```

Seed runs only against an empty warehouse database. It creates 60 synthetic products, 20 racks in four zones, 60 bins, 120 days of synthetic demand, and admin, manager, operator, and viewer accounts. Account emails follow `admin@warehouse.test`, `manager@warehouse.test`, `operator@warehouse.test`, and `viewer@warehouse.test`. All use SEED_PASSWORD.

Open the UI at **http://localhost:5173**. Sign in with a seeded account and SEED_PASSWORD. The API listens at http://localhost:4000/api/v1. Login returns a CSRF token and sets an HTTP-only session cookie. Send the configured Origin header for login and mutations, and X-CSRF-Token for authenticated mutations. Send a unique Idempotency-Key for business commands. Production cookies require HTTPS and NODE_ENV=production.

## Commands and queries

| Method | Path | Input |
| --- | --- | --- |
| POST | /auth/login | email, password |
| GET | /auth/me | none |
| POST | /auth/logout | empty object |
| GET | /products, /inventory, /orders, /pick-tasks, /alerts | cursor, limit, warehouseId and applicable productId/status/search |
| POST | /products | sku, name, reorderPoint, leadTimeDays, category |
| POST | /inventory/receipts, /inventory/adjustments | warehouseId, productId, binId, signed quantity, reason |
| POST | /orders | warehouseId, items containing productId and quantity |
| GET | /orders/:id | none |
| POST | /pick-tasks/:id/claims | expectedVersion |
| POST | /pick-tasks/:id/picks | expectedVersion, balanceId, quantity |
| GET | /pick-tasks/:id/route | none |
| POST | /orders/:id/cancellations, /packing, /dispatches | expectedVersion |
| POST | /alerts/:id/acknowledgements | expectedVersion |
| GET | /warehouses/:id/layout, /snapshot | none |
| GET | /analytics/overview | warehouseId |
| POST | /simulation/runs | warehouseId, scenario, seed, rate, durationSeconds |
| POST | /simulation/runs/:id/stops | empty object |
| GET | /health/live, /health/ready | none |
| GET | /health/operations | admin session |

Simulation scenarios are normal, surge, low-stock, and backlog. One active run per warehouse is permitted, capped at five orders per second and ten minutes. Simulation uses the same business commands as the API. Orders carry simulationRunId. Run records retain tick progress and errors. Graceful stopping finishes the current tick. Use one simulator process.

## Reliability

Stock updates, audit records, command results, and outbox events share a MongoDB transaction. All-or-nothing allocation checks precede reservation writes. Insufficient-stock outcomes commit demand and their replayable rejection together. Positive integer order quantities and duplicate product rejection simplify demand semantics. Bin-ID ordering determines allocations. Dijkstra paths and nearest-neighbor stop ordering provide heuristic routes.

Command results have seven-day retention. TTL deletion is asynchronous, so a record may remain replayable longer. Use new keys for intentional retries after replenishment. Expired keys can become new commands. Event deduplication markers remain retained.

A transactional counter orders outbox publication. Run exactly one publisher, which blocks later publication on failure. Kafka provides at-least-once delivery. Projection markers and effects commit together before the Kafka offset advances. Daily requested demand is attributed to request date and fulfillment to dispatch date in UTC. Analytics orderCount counts accepted reservations, including orders later cancelled.

After three processing attempts, workers persist a blocked partition and publish a dead-letter record. Other partitions can continue. Fix the underlying problem, then release that partition with:

```sh
docker compose exec workers node apps/server/src/replay.js demand-aggregation warehouse.demand.v1 0
```

The original offset is retried. Restarting workers retains the block. An irreparably malformed source event requires an explicit operator decision about source correction or offset skipping and a rebuild of the affected projection. Automatic skipping is intentionally absent. Monitor /health/operations for blocked partitions and the oldest unpublished event. Inspect Kafka lag with kafka-consumer-groups.sh in the Kafka container.

Socket.IO uses authenticated warehouse rooms and sends entity IDs and versions. Refetch authoritative REST data after notifications and reconnection. Snapshot consumers should buffer notifications during fetch and reconcile afterward. Use one API instance. Sessions are checked again before each delivery.

## Verification

```sh
npm ci
npm test
TEST_MONGODB_URI='mongodb://localhost:27019/warehouse_test?replicaSet=rs0' npm test
```

Integration tests require a real replica set and a database name beginning with warehouse_test. They add isolated fixtures without deleting existing data. Unit tests run without infrastructure. The demo script exercises login, an order through dispatch, cancellation, routing, and a demand-surge run through HTTP.

To demonstrate recovery, stop workers, run the demo to accumulate events, start workers, then inspect analytics and /health/operations. Kafka remains real infrastructure throughout.

## Scope and operating assumptions

One warehouse, one API, one outbox publisher, one worker process per consumer group, and one simulator are the supported demo topology. MongoDB and Kafka use persistent single-node volumes. Readiness checks the authoritative database; Kafka outages delay projections while inventory commands continue. Kafka startup creates topics programmatically.

The ML phase implements the forecast contract, forecasting jobs, and assistant APIs described below. The React frontend and interactive Three.js warehouse now consume those APIs and the backend layout/routing data.

Seeded stock is initialization data rather than an audited live receipt. Seed data must be clearly described as synthetic. Current snapshot and analytics payloads are bounded for the seeded single-warehouse demo. Editable layouts, cross-instance fan-out, and automated projection rebuilding remain outside this implementation. Admins can list and create warehouse-scoped users at /users.


## Verified locally

Fourteen unit and real MongoDB integration checks passed. The Compose stack completed the HTTP demo, a 15-second demand-surge simulation, Kafka duplicate delivery and dead-letter recovery verification, worker stop/start catch-up, and authenticated Socket.IO notifications across reconnects. These are functional checks, not throughput benchmarks.

Additional verification commands:

```sh
node apps/server/src/verify-realtime.js
docker compose exec workers node apps/server/src/verify-events.js
```

Event verification adds isolated synthetic warehouse fixtures. It intentionally creates a recoverable missing-product event and checks that replay succeeds after the missing data is repaired. Keep these commands confined to the demo installation.

## ML and Groq assistant

The ML phase, frontend, and 3D warehouse are implemented. Full contracts and failure semantics are in [docs/ml-contract.md](docs/ml-contract.md).

For the existing seeded installation, annotate known seed history once (safe to repeat):

```sh
docker compose --profile tools run --rm --build ml-migrate
```

A fresh installation uses the updated seed command and does not need that migration. Train the reproducible synthetic benchmark, then start/restart inference:

```sh
docker compose --profile tools run --rm --build model-training
docker compose up -d --build ml api workers outbox forecast-worker simulator
docker compose restart ml
```

Training creates an immutable-by-convention version directory in the model-data volume containing dataset.json, metadata.json and weights.pt, then atomically publishes CURRENT. Training is a separate job, never an inference side effect. Inference runs on CPU. The service is internal to Compose and has no host port. Without an artifact it serves an explicitly identified moving-average fallback.

The fixed synthetic generator produces 60 series over 365 days, including weekly patterns, trends, intermittent demand, surges and zero-demand products. Features are lag 1/7/14, rolling 7/14-day means, rolling variability and weekday encoding. Chronological target windows stay within train/validation/test partitions. Training-only preprocessing is persisted; validation MAE selects PyTorch or one of two baselines. Test results never select the method. This benchmark demonstrates engineering and evaluation, not real-world predictive accuracy.

The first measured 100-epoch run selected PyTorch. Synthetic test MAE was **3.9618 units**, WAPE **28.4127%**, compared with same-weekday MAE **5.0765**, WAPE **36.4074%** and moving-average MAE **5.5388**, WAPE **39.7229%**. Exact results, dataset digest and cutoffs are in [docs/ml-evaluation.json](docs/ml-evaluation.json). The pre-existing operational seed remains intact and is explicitly tagged; its arithmetic pattern differs from the separate training scenarios.

Configure Groq locally in `.env` (ignored by Git), without putting the key in source or chat:

```dotenv
GROQ_API_KEY=your-local-key
GROQ_MODEL=your-tool-capable-groq-model
```

Then run `docker compose up -d api` to apply configuration. Choose an available model supporting local function calling using Groq's model documentation. No default model is silently selected. Only the API container receives the Groq key. Live mode requires both values. Explicit `mode: "demo"` needs no credentials and returns labelled deterministic responses. The assistant renders numerical explanations from tool results; it does not return unchecked model-generated numerical prose.

After login, request a forecast with `POST /api/v1/forecast-runs`, body `{"warehouseId":"..."}`, and a fresh Idempotency-Key. GET the returned run ID for progress. Read `/api/v1/forecasts?warehouseId=...&productId=...` and `/api/v1/stock-risks?warehouseId=...`. POST `/api/v1/assistant/messages` with `{"warehouseId":"...","question":"Which products might run out?","mode":"demo"}`. Use the existing Origin/session/CSRF headers for all POST requests.

Verification commands:

```sh
npm test
TEST_MONGODB_URI='mongodb://127.0.0.1:27019/warehouse_test_ml?replicaSet=rs0' npm test
docker compose run --rm --no-deps ml python -m unittest discover -s tests -v
node apps/server/src/verify-ml.js
```

The database integration command requires a separate running replica set with a database name starting warehouse_test; it does not delete existing data. The headless ML verifier uses the seeded demo stack, creates a forecast run, replenishes the first three demo products through audited receipts, then runs a bounded surge. It verifies stock-risk changes with fixed forecast IDs, the explicit demo assistant and real Kafka-to-Socket.IO forecast notifications. It deliberately leaves those demo operations in the audit trail.

Limits: daily completed-day forecasts do not learn intraday surges immediately; stock depletion still changes risk immediately. Lead times above seven days have only seven-day coverage. The completeness check requires retained outbox and processed-event records. The trained artifact is loaded at process startup; restart inference after training. Live Groq calls require your credentials and are separately verifiable from the mocked provider tests.

Executed ML verification: **28 Node tests and 4 Python tests passed**, followed by the real-stack 60-product forecast/Socket.IO/surge demonstration. See [docs/ml-verification.md](docs/ml-verification.md) for exact scope and limitations. Follow-up testing passed all six live Groq assistant scenarios with openai/gpt-oss-120b; two provider integration fixes were regression-tested with a final 29-test Node suite. Credentials and model were supplied temporarily to the test process; persistent service configuration remains unchanged.


## Frontend and interactive warehouse

The frontend lives in `apps/web`, using React/JSX, Vite, Three.js, TanStack Query, Zustand and Socket.IO. It includes overview, warehouse, inventory, orders, picking, forecasts, assistant, stock alerts and administrator simulator screens. All operational data comes from the existing APIs; no separate mock dataset is presented as live warehouse state.

The warehouse scene uses instanced meshes, authoritative bin positions and backend-generated picking routes. It supports orbit/zoom, bin selection, SKU search and camera focus, top-down view, stock coloring, route visualization and a moving route marker. The 2D bin map and keyboard-accessible bin list provide alternatives to WebGL. Reduced-motion preferences stop the moving route marker. The existing seeded layout is one long aisle of twenty racks; the scene intentionally preserves that geometry.

TanStack Query owns fetched state. Zustand holds scene selection, route display, view mode and navigation only. WebSocket notifications invalidate affected authoritative reads rather than writing event payloads into inventory state. Reconnect invalidates cached server state; periodic reconciliation runs every 30 seconds. Forecast and simulator run progress polls every two seconds. The UI shows connection status and explicit loading, empty and error states.

The browser can reserve an order, claim its picking task, confirm partial picks, display its route, pack, dispatch, or cancel before picking. Inventory receipts and signed adjustments require a reason and respect role permissions. Command retries preserve their idempotency key after transport/server failures. Version conflicts ask the user to retry against refreshed state. Viewer accounts have no mutation controls; authorization remains enforced by the backend.

The assistant has an explicit Demo/Live selector. Demo mode is labelled deterministic. Live Groq configuration remains server-side. Validated widget descriptors render inventory/bin references, stock-risk tables, demand charts and order lists; unknown descriptors show an error. Source timestamps and evidence tool names are inspectable. A missing live configuration produces an honest error instead of a demo substitution.

Production UI:

```sh
docker compose up -d --build web
```

The frontend container serves static assets with Nginx and proxies `/api` and `/socket.io` to the API, preserving HTTP-only cookie sessions and Origin/CSRF checks. Port 5173 matches APP_ORIGIN. API keys are not frontend environment variables.

Frontend development (stop the web container first to free port 5173):

```sh
docker compose stop web
npm ci
npm run dev --workspace @warehouse/web
```

The development server proxies API and WebSocket traffic to localhost:4000. Production build and browser tests:

```sh
npm run build --workspace @warehouse/web
npx playwright install chromium
npm test --workspace @warehouse/web
```

Browser tests target the running demo stack at localhost:5173 (override WEB_URL if needed). They use the seeded password from SEED_PASSWORD or the documented local Compose fallback. They create small audited demo orders and receipts, and leave those operations in the audit trail. Screenshots and failure traces are written to ignored `apps/web/test-results`.

The suggested external 3d-ui skill was not present in the linked repository's default branch. Implementation used Three.js directly and the available UI/UX guidance. The UI is responsive at desktop and 375/390-pixel mobile widths. Google Fonts have local sans-serif fallbacks. Three.js is a separately lazy-loaded chunk; this is a local demo, not a device-wide performance benchmark.

Frontend verification: **five production-browser scenarios passed** against the real local stack. See [docs/ui-verification.md](docs/ui-verification.md) for the tested flows, screenshots, and limitations.
