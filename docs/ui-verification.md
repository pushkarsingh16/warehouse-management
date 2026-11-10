# Frontend verification — 2026-11-10

React/Vite production build passed. The frontend Docker image and the backend image with the new npm workspace both built successfully. Browser tests ran against the production Nginx frontend at localhost:5173 with the existing real MongoDB/Kafka/API/ML stack.

Five Playwright scenarios passed (49.4 seconds total in this run):

1. Login, live connection, rendered WebGL scene, SKU search and bin inspection, 2D/3D switching, forecast chart and accessible data table, desktop screenshot and 390-pixel mobile overflow check. No uncaught page errors were observed in this scenario.
2. Create an order, claim the task, confirm a partial pick, display the backend route, complete picking, pack and dispatch through UI controls.
3. Viewer login, deterministic assistant response with validated risk-table widget, Escape dismissal of the dialog, and absence of order/stock mutation controls.
4. Audited stock receipt, offline/reconnect behavior, a second external receipt reflected through live updates before the 30-second reconciliation interval, and order cancellation releasing its reservation.
5. Forced WebGL failure at 375-pixel width with reduced motion enabled; the bin map remained usable and no page-level horizontal overflow occurred.

Tests create small demo orders and receipts; these are retained in the operational audit trail. They do not reset the warehouse. Credentials come from SEED_PASSWORD or the local Compose demo fallback. Groq credentials were not moved, read into frontend assets, or configured by this UI phase. Browser assistant verification used explicitly labelled demo mode; prior live-provider verification is documented separately.

Corrections found during testing: same-origin Socket.IO polling did not supply the Origin header required by the backend, so the browser now uses WebSocket transport; form hint text is now separated from the input's accessible label; offline/online browser events immediately update connection state and trigger reconnection. One intermediate development test was interrupted by hot reload, so the final complete run used the production build.

Screenshots are available under apps/web/test-results after running the suite. That directory and Playwright traces are ignored by Git. Browser tests cover the seeded single-warehouse topology and are not a throughput, device performance or full accessibility certification.

The frontend container health probe was corrected to use 127.0.0.1, matching the IPv4 Nginx listener; `localhost` selected IPv6 in this Alpine image. The corrected probe succeeded.
