# Architecture: Live Paths vs Unwired Libraries

This backend currently has two runtime paths started from [`src/index.ts`](/home/trinnex/Documents/CodeBase/drips/newcatch/escrow-backend/src/index.ts):

- **Request path**: incoming HTTP request handling and Soroban RPC calls.
- **Indexer path**: background polling, event persistence, and webhook delivery.

Anything not statically reachable from [`src/index.ts`](/home/trinnex/Documents/CodeBase/drips/newcatch/escrow-backend/src/index.ts) is treated as **unwired library code** in this document.

## Runtime paths

```mermaid
flowchart TD
  A[src/index.ts] --> B[Express middleware]
  B --> C[routes/jobs.ts]
  C --> D[Stellar SDK / Soroban RPC]
```

```mermaid
flowchart TD
  A[src/index.ts] --> B[startPoller]
  B --> C[pollEvents]
  C --> D[insertEventBatch]
  D --> E[deliverWebhooks]
```

## How to tell if a module is live or unwired

Run the static import walk:

```bash
node scripts/reachability.mjs
```

The script starts from [`src/index.ts`](/home/trinnex/Documents/CodeBase/drips/newcatch/escrow-backend/src/index.ts), follows relative imports, and prints each `src/**/*.ts` module as `live` or `unwired`. The table below matches that output.

## Source module reachability

Legend:
- **live**: reachable from [`src/index.ts`](/home/trinnex/Documents/CodeBase/drips/newcatch/escrow-backend/src/index.ts) by static imports.
- **unwired**: not currently reachable in runtime; tracked in [Goldii-locks/escrow-backend#718](https://github.com/Goldii-locks/escrow-backend/issues/718).

| Module | Status | Tracking issue |
|---|---|---|
| `src/financial_report_exporter.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/index.ts` | live | — |
| `src/indexer/database-writer-pool.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/indexer/db.ts` | live | — |
| `src/indexer/duplicate-prevention.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/indexer/event_type_filter.ts` | live | — |
| `src/indexer/failover-recovery.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/indexer/indexer_metrics_collector.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/indexer/indexer_runner.ts` | live | — |
| `src/indexer/ledger-range-tracker.ts` | live | — |
| `src/indexer/poller.ts` | live | — |
| `src/indexer/rpc-poller-client.ts` | live | — |
| `src/indexer/sqlite_schema_manager.ts` | live | — |
| `src/indexer/sqlite_vacuum_cleaner.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/indexer/status.ts` | live | — |
| `src/indexer/webhook_dispatcher.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/indexer/webhook-delivery.ts` | live | — |
| `src/middleware/adminAuth.ts` | live | — |
| `src/middleware/create-job-draft-validation.ts` | live | — |
| `src/middleware/financial-report-exporter-rate-limit.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/middleware/job-contract-rate-limit.ts` | live | — |
| `src/middleware/job-contract-security.ts` | live | — |
| `src/middleware/rateLimiter.ts` | live | — |
| `src/middleware/refund-ratio-rate-limit.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/middleware/tax-deduction-rate-limit.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/middleware/validate.ts` | live | — |
| `src/routes/admin.ts` | live | — |
| `src/routes/jobs.ts` | live | — |
| `src/routes/webhooks.ts` | live | — |
| `src/routes/whitelist.test.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/schemas/jobs.ts` | live | — |
| `src/stablecoin_cents_multiplier.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/api-response.ts` | live | — |
| `src/utils/audit_ledger_sum_checker.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/conversion_rate_math.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/csv-serializer.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/digit-limit-validator.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/email_sender_activity_log.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/email_sender_retry_policy.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/email_sender_service.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/email_sender_templates.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/fee_deduction_calculator.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/fee-deduction-calculator.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/financial_report_exporter.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/financial_report_math.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/format-error.ts` | live | — |
| `src/utils/interest_yield_estimator.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/logger.ts` | live | — |
| `src/utils/partial_payment_allocator.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/partial-payment-allocator.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/refund_ratio_helper.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/stablecoin_cents_multiplier.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/stellar.ts` | live | — |
| `src/utils/tax_deduction_estimator.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/token_decimals_converter.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/validation.ts` | unwired | [#718](https://github.com/Goldii-locks/escrow-backend/issues/718) |
| `src/utils/webhook_dispatcher.ts` | live | — |
