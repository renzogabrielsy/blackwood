# Durable "Run Sync" Background Job — Industry-Standard Patterns & Tools (Research)

**Date:** 2026-07-04
**Author:** Research agent (Opus)
**Type:** Architecture research (no repo code changed)

---

## The problem in one sentence

A user clicks **"Run Sync"** in the Blackwood Next.js app. From that click on, a **Python pipeline** (Gmail IMAP → download xlsx → parse → diff against Supabase → write rows) must **run to completion no matter what the user does** — refresh, close the tab, drop internet, shut the laptop. The *only* acceptable failure is Supabase itself being down. Constraints: **on-demand only** (no always-on cron), **zero (or near-zero) idle cost**, minimal moving parts, and the job is **already idempotent** (re-running is safe; at-least-once is fine).

---

## Plain-language executive summary (for a non-engineer)

Think of clicking "Run Sync" like **mailing a package instead of hand-delivering it**. Right now the work is "hand-delivered": it only finishes if *you* stay on the line the whole time. The moment you close the tab or your laptop sleeps, the courier vanishes and the delivery is abandoned. That is the exact thing we must eliminate.

The whole industry solves this the same way, and it comes down to **one idea: the click and the work must be divorced.** The click's *only* job is to **write down "a sync was requested"** in a durable place — a to-do list — and then it's free to forget about it. A **separate worker** picks up that to-do item and does the real work. Because the to-do list lives in a database (not in the browser, not in the web request), it survives everything short of the database itself dying. If the worker crashes mid-job, the item is still on the list, so another worker just picks it back up. This is called a **job queue with an idempotent worker**, and it's the boring, battle-tested foundation under basically every "background job" you've ever used.

There's a fancier version called **durable execution**, where a framework records every *step* the job completes ("logged into Gmail ✓", "downloaded file ✓", "wrote 12 rows ✓"). If the machine dies at step 3, it resumes at step 3 instead of restarting — like a video game autosave for your program. Nice to have, but for Blackwood it's a **luxury, not a necessity**, because the Python pipeline is already safe to re-run from the top (idempotent). That single fact — "re-running is safe" — quietly removes 80% of the hard problems in this whole field.

For **your exact stack** (on-demand click + zero idle cost + Python + Supabase already the system of record), three shapes fit, and they rank cleanly:

1. **Supabase Queue + a Python worker on Modal** (queue lives in your Postgres, Modal runs Python only when triggered, scales to zero → no idle cost). **Best fit.**
2. **DBOS** — a durable-execution library whose "save file" *is* your Supabase Postgres. Native Python, almost no new infrastructure. Best if you want autosave-style resume.
3. **Inngest / Trigger.dev** — hosted "just works" durability with a generous free tier; least to build, but adds a third-party vendor holding your job state.

The one thing you must **not** do: run the Python inside the Next.js web request (even with `after()`/`waitUntil`). That ties the job's life to a serverless function that gets killed at a hard time limit and isn't meant to survive — it's hand-delivery with extra steps.

---

## Part 1 — The canonical patterns (named, plain, cited)

### Pattern A — Job queue + idempotent worker + at-least-once delivery

The bedrock pattern. The web request does one tiny, fast thing: **enqueue a job** (write a row: "sync requested, status=pending"). A **separate worker process** polls the queue, claims a job, runs it, marks it done. Delivery is **at-least-once**: a job is guaranteed to be *picked up at least once*, but a crash after doing work but before marking "done" means it may be picked up **again** — so the worker must be **idempotent** (safe to re-run). ([digitalapplied.com — Background Jobs & Queues 2026 reference](https://www.digitalapplied.com/blog/background-job-queue-patterns-2026-engineering-reference), [event-driven.io — delivery guarantees](https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/))

> "The correct pattern is to push a job descriptor to a queue and process it in a separate, persistent worker process… In production serverless deployments, use a durable queue and worker instead of relying on work started inside the same API route invocation." — Next.js/Vercel community + Render ([Render](https://render.com/articles/nextjs-background-jobs-postgresql-production))

**Blackwood relevance:** This is the minimum viable answer, and it's a near-perfect fit because Blackwood's pipeline is *already idempotent*. The queue can literally be a Postgres table in Supabase.

### Pattern B — Transactional outbox (a refinement of A)

Solves the "dual-write problem": if your code must both **write to the DB** and **trigger a job**, doing them as two separate operations risks one succeeding and the other failing. The outbox pattern writes *both* the business data **and** the "job to run" into the **same database transaction** — so they commit atomically or not at all. A relay/worker then reads the outbox table and dispatches. ([AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html), [milanjovanovic.tech](https://www.milanjovanovic.tech/blog/implementing-the-outbox-pattern/), [npiontko.pro](https://www.npiontko.pro/2025/05/19/outbox-pattern))

> "The outbox and the idempotency key are two halves of one design: the outbox makes sure the message is never lost, and the idempotency key makes sure a message delivered twice is only acted on once." — ([event-driven.io](https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/))

**Blackwood relevance:** Because the enqueue IS the whole action (a click just says "sync please"), the classic dual-write problem barely applies — but the *lesson* does: if the queue lives in the same Postgres as your data, the enqueue write is trivially durable and transactional. This is why a **Postgres-native queue (Supabase Queues / pgmq)** is such a clean fit.

### Pattern C — Durable execution / workflow engines

A step above queues. The framework **checkpoints every step** of a workflow to durable storage. If the process crashes, it **transparently resumes from the last completed step** in a fresh process — "as if the failure never happened." ([Temporal — What is Durable Execution](https://temporal.io/blog/what-is-durable-execution), [thenewstack.io](https://thenewstack.io/temporal-durable-execution-platform/))

> "When a process crashes, Durable Execution ensures that work transparently resumes in a new process, with the application state recreated so execution continues as if the failure never happened." — Temporal

Different engines, same core promise:
- **Inngest:** "each step… saves successful results, and if retried, skips already-completed steps and retrieves their saved results." ([Inngest docs](https://www.inngest.com/docs/learn/inngest-functions))
- **Trigger.dev:** "automatically checkpoints the state of a task at await points… if the execution environment is about to time out, the task can be safely stopped and resumed later on a new instance." ([Trigger.dev](https://trigger.dev/product))
- **DBOS:** "on restart the DBOS library launches a background thread that resumes all incomplete workflows from the last completed step" — by querying Postgres for PENDING workflows. ([Supabase × DBOS](https://supabase.com/blog/durable-workflows-in-postgres-dbos))

**Blackwood relevance:** Overkill *strictly for correctness* (idempotent pipeline doesn't NEED step-resume), but hugely valuable for **observability** and for not re-doing an expensive Gmail download on every retry. DBOS specifically stores its checkpoints in **your Supabase Postgres**, which is the tightest possible fit.

### Pattern D — "Trigger from web app, run in background" serverless job

The on-demand shape: an HTTP trigger (the click) kicks off a job on a **serverless executor that spins up on the trigger and scales to zero when idle**. No always-on server, no cron. Modal is the archetype for Python: "every terminal command spins up a Modal function, runs in a fresh container, and shuts down when done… Scale to zero between requests." ([Modal docs](https://modal.com/docs/guide), [Modal pricing analysis](https://blaxel.ai/blog/modal-pricing-alternatives-guide))

**Blackwood relevance:** This is the piece that delivers **zero idle cost** while running **Python** — the executor for the actual work.

---

## Part 2 — The real tools (comparison table)

Dimensions: what it is · completion guarantee · Python fit · Postgres/Supabase fit · managed vs self-host · **idle cost** · on-demand trigger fit · maturity.

| Tool | What it is | Completion / crash survival | Python fit | Postgres/Supabase fit | Managed vs self-host | Idle cost | On-demand trigger | Maturity |
|---|---|---|---|---|---|---|---|---|
| **Supabase Queues (pgmq)** | Postgres-native durable message queue ("guaranteed delivery"), built on Tembo's `pgmq` | Message persists in Postgres w/ **visibility timeout** — unacked messages reappear for retry; survives worker crash | Enqueue from anywhere; **needs a Python worker** you supply | **Native** — it *is* your Supabase DB | Managed (in Supabase) or self-host pgmq | **~Zero** — just rows in a DB you already pay for | Enqueue via RPC/SQL from Next.js server action | GA in Supabase; pgmq mature ([blog](https://supabase.com/blog/supabase-queues)) |
| **DBOS (Transact)** | Durable-execution *library* backed by Postgres (Stanford/MIT origin) | Checkpoints each step to Postgres `operation_outputs`; on restart resumes PENDING workflows from last step; "exactly-once" for transactional steps | **First-class Python** (`@DBOS.workflow/@DBOS.step`) | **Native — stores state in your Supabase Postgres** | Library (self-run worker) + optional hosted Conductor | **~Zero** (library; cost = wherever the worker runs) | Call a workflow function from your trigger | Production: Dosu, Notion, Roche cited ([Supabase×DBOS](https://supabase.com/blog/durable-workflows-in-postgres-dbos), [Dosu](https://dosu.dev/blog/migrate-celery-to-dbos-dosu)) |
| **Modal** | Python-first serverless compute; spin-up-on-call, scale-to-zero | Retries + timeouts on functions; durability of *state* still needs your queue/DB (Modal is the executor, not the ledger) | **Best-in-class Python** (`@app.function`, Secrets for creds) | Reaches Supabase over network; not a queue itself | Fully managed | **Zero idle** — "No paying for idle time," per-second billing, $30/mo free credits | HTTP/function trigger; ideal | Mature; ETL case studies ([Modal ETL](https://modal.com/blog/etl), [pricing](https://blaxel.ai/blog/modal-pricing-alternatives-guide)) |
| **Inngest** | Hosted durable-functions platform; event/webhook triggered | Steps checkpointed; completed steps skipped on retry; runs on your compute | **Python SDK** (Flask/etc.), "durable functions in a few lines" | Agnostic; state held by Inngest, not your DB | Managed (self-host core exists) | **Zero idle** (serverless model); free tier **50k runs/mo** | POST/webhook/SDK event | Mature ([Inngest](https://www.inngest.com/), [py SDK](https://github.com/inngest/inngest-py)) |
| **Trigger.dev** | Open-source durable background-jobs platform (TS-first) | Checkpoint/resume at await points; survives timeouts | Python via **build extension** (calls Python from a TS task) — indirect | Agnostic; needs its own Postgres+Redis if self-hosted | Managed **or** self-host (Apache-2.0) | Managed: **per-second + $0.25/10k invocations**, free tier $5 credits; self-host = run Postgres/Redis/worker | SDK trigger from Next.js | Mature, popular for Next.js ([pricing](https://trigger.dev/pricing), [v3](https://trigger.dev/blog/v3-open-access)) |
| **Temporal** | The reference durable-execution engine; event-history replay | Strongest guarantees; every step in durable Event History; exactly-once activity semantics | Python SDK (good) | Not Postgres-coupled (own persistence store) | Managed (Temporal Cloud) or heavy self-host | Self-host = **always-on cluster (not zero-idle)**; Cloud = usage-based | Start workflow via client | Very mature, heaviest ([Temporal](https://temporal.io/)) |
| **Restate** | Newer durable-execution engine (single binary) | Durable, log-based, journal replay | Python SDK | Own log store | Managed or self-host | Self-host = running service | HTTP trigger | Emerging ([kai-waehner.de](https://www.kai-waehner.de/blog/2025/06/05/the-rise-of-the-durable-execution-engine-temporal-restate-in-an-event-driven-architecture-apache-kafka/)) |
| **Windmill** | Fastest self-host workflow engine; Postgres-backed; multi-language | Steps checkpointed to Postgres (~0.5ms); durable resume | **Native Python** (runs scripts directly) | Uses its **own** Postgres as backing store | Self-host (Docker) or cloud | Self-host = **server + worker running (not zero-idle)** | Webhook/UI/schedule trigger | Mature; 13× Airflow ([Windmill](https://github.com/windmill-labs/windmill)) |
| **Procrastinate** | Python-native Postgres task queue (Celery alt.) | At-least-once; job stays in Postgres until done; retries | **Native Python** | **Native Postgres** (could target Supabase) | Self-host library + worker | Worker must be running to poll (**not zero-idle** unless you gate it) | `defer` a task from code | Mature OSS ([GitHub](https://github.com/procrastinate-org/procrastinate)) |
| **Graphile Worker** | Node Postgres job queue (`SKIP LOCKED`) | At-least-once; Postgres-backed | **Node, not Python** (would shell out) | Native Postgres | Self-host worker | Worker running to poll | `add_job` SQL | Mature (Node world) |
| **Oban** (reference) | Elixir/Postgres job queue | Robust at-least-once, Postgres-backed | Elixir only | Native Postgres | Self-host | Worker running | enqueue | Gold standard in Elixir |
| **Celery + broker** | Classic Python task queue | At-least-once; needs Redis/RabbitMQ broker | **Native Python** | Broker ≠ Postgres (extra infra) | Self-host | **Broker + worker always on** (idle cost) | `.delay()` | Very mature but heavy ([Procrastinate contrast](https://github.com/procrastinate-org/procrastinate)) |
| **BullMQ** | Node/Redis job queue | At-least-once; Redis-backed | Node, not Python | Needs Redis, not Postgres | Self-host | Redis + worker always on | `add` | Mature (Node) |

**Reading the table for Blackwood:** the rows that light up on **all four** constraints (Python ✓, Supabase-native ✓, zero-idle ✓, on-demand ✓) are **Supabase Queues + Modal worker**, and **DBOS**. Celery/BullMQ/Graphile/Windmill/Temporal/Procrastinate all fail *at least one* — usually zero-idle (they need an always-running worker or broker) or Python (Node-only).

---

## Part 3 — Recommended architectures for THIS stack (ranked)

### 🥇 #1 — Supabase Queue (pgmq) + Python worker on Modal  *(best fit)*

**End-to-end flow of one click:**
1. User clicks **Run Sync** → Next.js **server action** calls `queues.send({ queue_name: 'ictc_sync', message: {...} })` (RPC/SQL). This is one fast, transactional write into your **Supabase** Postgres. The action returns immediately; the UI shows "queued." **The browser can now close — its job is done.**
2. The enqueue triggers a **Modal** Python function — either via a Supabase Database Webhook / `pg_net` call on insert, or a lightweight Modal endpoint the server action pings fire-and-forget.
3. **Modal spins up a fresh Python container** (scale-from-zero), reads the message, and runs your existing IMAP → xlsx → diff → write pipeline. Gmail app password + Supabase service key live in **Modal Secrets**.
4. Worker `archive()`s the message on success. If the container dies mid-run, the message's **visibility timeout** expires and it **reappears** for another worker — safe because the pipeline is idempotent.
5. Worker writes status/progress back to a `sync_runs` row in Supabase → UI polls or subscribes (Realtime) to show live progress, independent of the original request.

**Where durability comes from:** the message sits in **your Supabase Postgres** the entire time (guaranteed delivery + visibility-timeout redelivery). The only single point of failure is Supabase — exactly the stated acceptable failure. ([Supabase Queues](https://supabase.com/blog/supabase-queues), [consuming w/ workers](https://supabase.com/docs/guides/queues/consuming-messages-with-edge-functions))

**Idle cost:** ~**zero**. The queue is rows in a DB you already run; Modal bills **per-second only while running** ("No paying for idle time," $30/mo free credits). ([Modal](https://blaxel.ai/blog/modal-pricing-alternatives-guide))

**Effort:** Medium. You keep your Python as-is, wrap it in one Modal function, add a queue table, wire one webhook. Fewest *new vendors* holding your state (state stays in Supabase).

**Honest downside:** you assemble the pieces yourself (queue + trigger + worker + status table). No built-in step-level resume — but you don't need it (idempotent). Modal is a second cloud account to manage; the Supabase→Modal trigger (webhook/`pg_net`) is the one bit to get right and monitor.

> **Why it wins:** it satisfies every hard constraint simultaneously — Python-native execution, job state in Supabase, zero idle cost, pure on-demand — with the fewest moving parts that hold durable state outside your DB.

---

### 🥈 #2 — DBOS durable workflows, checkpointed in Supabase Postgres

**End-to-end flow:**
1. Click → server action invokes a **DBOS workflow** (your pipeline decorated `@DBOS.workflow()`, each stage `@DBOS.step()`).
2. DBOS writes a PENDING workflow + per-step outputs into **your Supabase Postgres**.
3. Worker process runs the steps; each completed step is checkpointed. If it crashes, on restart DBOS "launches a background thread that resumes all incomplete workflows from the last completed step." ([Supabase×DBOS](https://supabase.com/blog/durable-workflows-in-postgres-dbos))
4. On finish, workflow marked complete; observability is just **SQL over the checkpoint tables**.

**Where durability comes from:** DBOS's checkpoint tables **in your Supabase DB**. Same single-point-of-failure profile (Supabase) as #1, plus you get **autosave-style resume** — an expensive Gmail download completed before a crash isn't repeated.

**Idle cost:** ~**zero** for the library/state (it's your DB). Cost = wherever the DBOS worker runs. To keep it truly on-demand/zero-idle, run the DBOS worker **on Modal or a scale-to-zero container** triggered by the click — otherwise a small always-on process polls.

**Effort:** Low-Medium. Most native Python fit of any *durable-execution* option; minimal new infra ("add durable workflows in a few lines… entirely backed by your Supabase database"). Real production adoption: **Dosu runs ~20,000 DBOS workflows/hour** for 50k+ projects, migrated off Celery, state in Postgres. ([Dosu](https://dosu.dev/blog/migrate-celery-to-dbos-dosu))

**Honest downside:** to hit *strict* zero-idle you still need a scale-to-zero host for the worker (DBOS solves durability, not "who runs the process on demand"). Slightly more framework buy-in (decorators, determinism rules) than a plain queue. The step-resume benefit is partly wasted given idempotency — you're paying complexity for observability more than correctness.

---

### 🥉 #3 — Hosted durable platform (Inngest, or Trigger.dev)

**End-to-end flow:**
1. Click → server action sends an **event** (POST/SDK) to Inngest/Trigger.dev.
2. The platform durably enqueues + runs your **Python** function (Inngest Python SDK; Trigger.dev via its Python build extension), checkpointing steps, retrying automatically, surviving crashes/timeouts on their infra.
3. Status visible in their dashboard; webhook/DB write back to Supabase for your UI.

**Where durability comes from:** the vendor's managed durable store (not your Supabase). Least to build — "durability as a service."

**Idle cost:** **zero idle** (serverless usage-based). Inngest free tier **50k runs/mo**; Trigger.dev free $5 credits then per-second + $0.25/10k invocations. ([Inngest](https://www.inngest.com/), [Trigger.dev pricing](https://trigger.dev/pricing))

**Effort:** **Lowest** — SDK + a function; they own retries, queueing, dashboards.

**Honest downside:** a **third-party vendor now holds your job state** (violates the "state lives in Supabase" ideal), adds a dependency/account, and Trigger.dev's Python path is *indirect* (Python-from-TS) unless you self-host — and self-hosting means **you run their Postgres+Redis+worker**, which reintroduces idle infra. Inngest's Python SDK is more direct.

---

**Ranking rationale:** #1 keeps *all* durable state in Supabase, runs Python natively, and is genuinely zero-idle — the exact 4-way fit. #2 is essentially #1 with autosave, at the cost of framework buy-in you don't strictly need. #3 is fastest to ship but externalizes your job state and (for Python) is cleanest only on Inngest.

---

## Part 4 — Documented real-world precedents (cited)

1. **Dosu — Celery → DBOS, durable Python pipelines, state in Postgres.** Dosu (AI for 50,000+ software projects) migrated ingestion/RAG pipelines from Celery to DBOS for durable execution + observability, now running **~20,000 workflows/hour**, ingesting hundreds of thousands of documents daily, "running within their existing Cloud Run setup and storing state in Postgres, eliminating the need for extra infrastructure." Direct analog to Blackwood: a Python data pipeline made crash-durable with Postgres as the ledger. ([dosu.dev](https://dosu.dev/blog/migrate-celery-to-dbos-dosu), [dbos.dev/case-studies/dosu](https://www.dbos.dev/case-studies/dosu))

2. **Supabase's own engineering blog — "Running Durable Workflows in Postgres using DBOS."** Supabase officially documents using **your Supabase Postgres as a durable workflow engine**: "add durable workflows and queues in just a few lines of code, entirely backed by your Supabase database," with crash-resume ("on restart… resumes all incomplete workflows from the last completed step") and SQL-based observability. This is Supabase itself endorsing the #2 architecture for exactly this class of problem. ([supabase.com/blog](https://supabase.com/blog/durable-workflows-in-postgres-dbos))

3. **Supabase Queues + Edge Functions "queue worker" pattern (widely reproduced).** Multiple independent write-ups build the click→durable-job→completion loop on **pgmq + pg_cron/webhook + a worker**: "a database table that acts as a queue, where jobs are inserted by your Next.js app, processed by a worker (Edge Function or pg_cron), and their status is tracked in the same table… If a job fails, it will remain in the queue and be retried." This is the documented, community-validated shape of #1 (swap the Edge-Function worker for a Modal Python worker to run the heavy Python pipeline past Edge time limits). ([Supabase docs — consuming with Edge Functions](https://supabase.com/docs/guides/queues/consuming-messages-with-edge-functions), [Supabase blog — large jobs](https://supabase.com/blog/processing-large-jobs-with-edge-functions), [dev.to queue worker](https://dev.to/suciptoid/build-queue-worker-using-supabase-cron-queue-and-edge-function-19di))

*Supporting:* **Modal ETL case studies** show Python data-sync jobs triggered and run serverlessly at near-zero idle cost (a 12M-row sync costing **$0.29** on Modal), validating Modal as the on-demand Python executor. ([Modal — Why move your ETL to Modal](https://modal.com/blog/etl)) **Cyrille — "Background Jobs using Next.js, Inngest, Supabase, and Vercel"** documents the #3 shape end-to-end (Next.js click → Inngest durable job → Supabase). ([Medium](https://medium.com/@cyri113/background-jobs-for-node-js-using-next-js-inngest-supabase-and-vercel-e5148d094e3f))

---

## Part 5 — Idempotency & safety (why at-least-once is fine here)

Blackwood's pipeline is **already idempotent** — this is the single most de-risking fact in the whole design. At-least-once delivery (the guarantee every Postgres queue and durable engine provides) is only dangerous when re-running causes double effects. Because re-running is safe, you can accept the simplest, cheapest guarantee and still get **effectively-once outcomes**. The industry recipe:

- **At-least-once delivery + idempotent processing = effectively-once end-to-end.** ("At-least-once publishing… plus idempotent processing on the consuming side, equals effectively-once end to end." — [event-driven.io](https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/))
- **Dedup / idempotency key:** give each sync run a stable key (e.g. a `run_id`, or natural keys per row as Blackwood's syncs already use). A redelivered job with the same key is a no-op. Blackwood's classifiers already do NEW/NOOP/VALUE_CHANGED diffing — that *is* the idempotency layer.
- **Inbox/outbox tables** (optional): if you ever need to guard against duplicate *side effects* (e.g., Gmail labeling), record processed message-IDs in an inbox table and skip seen ones. Blackwood already uses the `Blackwood-Processed` Gmail label for exactly this.
- **Visibility timeout** (pgmq / SQS-style): a claimed-but-unfinished message reappears after the timeout — the mechanism that turns "worker crashed" into "job retried."

**Bottom line:** because the pipeline is idempotent, you do **not** need Temporal-grade exactly-once machinery. A durable Postgres queue + your existing diff-based writes is provably safe.

---

## Part 6 — Anti-patterns & gotchas (honest)

- **❌ Running the job inside the Next.js request (even with `after()` / `waitUntil`).** These extend a serverless invocation's life only until the platform's **max duration**, then the function is **killed mid-task**. Vercel: 10s (Hobby default historically) up to 300s Pro / 800s Enterprise — a Gmail-download-parse-diff-write job can exceed this, and *nothing* guarantees survival past the response. "Making the client periodically call a serverless function… is unreliable — if the client closes the browser tab or gets disconnected, the tracking stops." ([Next.js `after`](https://nextjs.org/docs/app/api-reference/functions/after), [Vercel discussion #34266](https://github.com/vercel/next.js/discussions/34266), [oneuptime](https://oneuptime.com/blog/post/2026-01-24-fix-api-route-timeout-errors-nextjs/view)) — **This is the exact failure mode Blackwood must avoid.**
- **❌ Tying the job to the HTTP/SSE connection (stream progress = keep working).** If the socket dies (tab close, laptop sleep, wifi drop), the work dies. Progress must be **read from a durable status row**, never *be* the work.
- **⚠️ Serverless execution-time limits.** Even Supabase Edge Functions cap at ~150s (free) — fine for enqueue/orchestration, **too short for the full Python pipeline**. Run the heavy work on a real Python executor (Modal / container), not an Edge Function.
- **⚠️ Cold starts.** Modal cold-starts are sub-second for the container, but **Python imports + IMAP login add seconds**. Acceptable for an on-demand sync; just don't promise instant.
- **⚠️ Always-on workers reintroduce idle cost.** Procrastinate/Celery/Graphile/Windmill/Temporal-self-host all need a **process polling 24/7** → violates zero-idle unless you gate it behind a scale-to-zero trigger. This is the main reason they rank below Modal/DBOS-on-Modal for *this* constraint. ([Railway/Render/Fly cost comparison](https://devtoolpicks.com/blog/railway-vs-render-fly-io-solo-developers-2026))
- **🔒 Secrets.** Gmail app password + Supabase **service role key** must live in the executor's secret store (Modal Secrets / platform env), **never** in the browser or a Next.js public env. The worker reaches Gmail + Supabase directly, server-side only.

---

## Sources

- Temporal — *What is Durable Execution*: https://temporal.io/blog/what-is-durable-execution
- Temporal — homepage / guarantees: https://temporal.io/
- The New Stack — Temporal durable execution: https://thenewstack.io/temporal-durable-execution-platform/
- Supabase × DBOS — *Running Durable Workflows in Postgres*: https://supabase.com/blog/durable-workflows-in-postgres-dbos
- DBOS — homepage: https://www.dbos.dev/
- DBOS Transact (Python) — GitHub: https://github.com/dbos-inc/dbos-transact-py
- Dosu — *Celery → DBOS* case study: https://dosu.dev/blog/migrate-celery-to-dbos-dosu
- DBOS — Dosu case study: https://www.dbos.dev/case-studies/dosu
- Supabase — *Supabase Queues* blog: https://supabase.com/blog/supabase-queues
- Supabase docs — consuming queue messages with Edge Functions: https://supabase.com/docs/guides/queues/consuming-messages-with-edge-functions
- Supabase — *Processing large jobs with Edge Functions, Cron, Queues*: https://supabase.com/blog/processing-large-jobs-with-edge-functions
- Supabase docs — Edge Function background tasks: https://supabase.com/docs/guides/functions/background-tasks
- dev.to — Build Queue Worker w/ Supabase Cron, Queue, Edge Function: https://dev.to/suciptoid/build-queue-worker-using-supabase-cron-queue-and-edge-function-19di
- Modal — guide/docs: https://modal.com/docs/guide
- Modal — *Why move your ETL to Modal*: https://modal.com/blog/etl
- Modal — pricing analysis (Blaxel): https://blaxel.ai/blog/modal-pricing-alternatives-guide
- Inngest — homepage: https://www.inngest.com/
- Inngest — Python SDK: https://github.com/inngest/inngest-py
- Inngest — functions docs: https://www.inngest.com/docs/learn/inngest-functions
- Trigger.dev — product: https://trigger.dev/product
- Trigger.dev — pricing: https://trigger.dev/pricing
- Trigger.dev — v3 open access: https://trigger.dev/blog/v3-open-access
- Windmill — GitHub: https://github.com/windmill-labs/windmill
- Windmill vs Airflow: https://www.windmill.dev/compare/airflow
- Restate / durable-execution landscape (Kai Waehner): https://www.kai-waehner.de/blog/2025/06/05/the-rise-of-the-durable-execution-engine-temporal-restate-in-an-event-driven-architecture-apache-kafka/
- Procrastinate — GitHub: https://github.com/procrastinate-org/procrastinate
- Transactional outbox — AWS Prescriptive Guidance: https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html
- Transactional outbox — Milan Jovanović: https://www.milanjovanovic.tech/blog/implementing-the-outbox-pattern/
- Outbox/inbox & delivery guarantees — event-driven.io: https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/
- Background jobs & queues 2026 reference — digitalapplied.com: https://www.digitalapplied.com/blog/background-job-queue-patterns-2026-engineering-reference
- Next.js `after()` docs: https://nextjs.org/docs/app/api-reference/functions/after
- Vercel/Next.js — long-running background functions discussion: https://github.com/vercel/next.js/discussions/34266
- Render — *Next.js Background Jobs & PostgreSQL: Production in 2026*: https://render.com/articles/nextjs-background-jobs-postgresql-production
- OneUptime — fixing Next.js API route timeouts: https://oneuptime.com/blog/post/2026-01-24-fix-api-route-timeout-errors-nextjs/view
- Railway vs Render vs Fly.io (idle cost): https://devtoolpicks.com/blog/railway-vs-render-fly-io-solo-developers-2026
- Cyrille — Background Jobs w/ Next.js, Inngest, Supabase, Vercel: https://medium.com/@cyri113/background-jobs-for-node-js-using-next-js-inngest-supabase-and-vercel-e5148d094e3f
