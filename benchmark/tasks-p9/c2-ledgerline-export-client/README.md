# c2-ledgerline-export-client

An API-client handoff. The developer pastes a long section of the Ledgerline partner docs covering headers, `limit`/`cursor` pagination, de-duplication, per-status retry rules and error class names. Agent A implements only the pagination loop. Its first version stopped on an empty page, and the developer's sandbox run returned 1,400 of 2,013 records. Agent A fixes that. A rerun returns 2,019 records, which points to duplicates across page boundaries. The developer then corrects the `X-Ledgerline-Version` header from the doc's `2024-11-01` to `2025-03-15`, rejects a shared retry policy for 429 and 5xx, and stops Agent A before retries and error handling.

These requirements exist only in the conversation: the 429 policy (Retry-After seconds, 5 retries), the 5xx backoff (200/400/800, 3 retries), no retries for 401/404, the error class names `LedgerAuthError`, `LedgerNotFoundError`, `LedgerRateLimitError` and `LedgerHttpError` with `.requestId`, de-duplication by id, and the corrected version header. The code in `session-changes/` still sends the stale `2024-11-01`.

Unavailable: the developer mentions the tenant's per-minute rate limit but never states it. Agent B should not invent a number or add client-side pacing.
