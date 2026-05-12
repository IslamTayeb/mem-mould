# SWE-Bench Context Stress Prelude

Each block below is sent as one user turn before the target SWE-bench issue. The turns are intentionally realistic but unrelated to the target issue. The benchmark harness disables normal coding tools during these turns so they shape conversation history without changing the checked-out SWE-bench repository.

--- turn ---
We are investigating an auth rate limiter race in a separate service. The suspected hot spot is `src/auth/rate_limiter.ts:42`, where two concurrent refresh requests can both observe an expired token and schedule duplicate refresh work. Think through the likely root cause, but do not edit files yet.

--- turn ---
Stay on the auth race. I tried a mutex-oriented design earlier, but I am worried it serializes too much of the request path and may still fail if the lock is scoped per handler instance instead of per tenant. Explain what would make that failure mode plausible.

--- turn ---
The mutex attempt did fail under a concurrent test. Preserve this as an important fact for later: the failed approach was `MutexRefreshCoordinator`, and the failing test name was `auth_refresh_deduplicates_parallel_requests`. We are leaning toward an async queue instead.

--- turn ---
Switch topics. For onboarding docs, outline a contributor quickstart for API developers. It should mention local environment setup, a short smoke test command, where API route files live, and how to find feature-flag documentation. This docs work is low priority compared with auth.

--- turn ---
Still on docs: the quickstart wording got noisy. We renamed the section from "Setup" to "First local run", then back to "Quickstart", then to "Contributor quickstart". Also mention that the docs cleanup should not affect runtime behavior.

--- turn ---
Switch again. For the auth work, assume the final approach is an async queue helper extracted to `src/auth/queue.ts`. The rollback flag is `FLAG_AUTH_QUEUE_ROLLBACK`. The helper should deduplicate per tenant and expose a narrow `enqueueRefresh` API.

--- turn ---
Now discuss tests, but keep it separate from docs. We need concurrency tests for same-tenant refresh dedupe, different-tenant parallelism, rollback flag behavior, and failure propagation when a queued refresh rejects. The same-tenant test is the most important.

--- turn ---
Add a stale note that should not be reused unless explicitly relevant: in an old prototype, we thought the bug was caused by a markdown parser caching issue in docs generation. That hypothesis was wrong and belongs to the docs cleanup thread, not the auth fix.

--- turn ---
Return to auth. Summarize the important facts: mutex failed tests, async queue is the final direction, rollback is behind `FLAG_AUTH_QUEUE_ROLLBACK`, helper lives in `src/auth/queue.ts`, and the docs/markdown parser idea is unrelated noise.

--- turn ---
Return to docs one last time. The contributor quickstart should link to API route ownership docs and should not mention the mutex, async queue, or rollback flag. This is a good example of a completed low-value thread that can be compressed later.

--- turn ---
Return to tests. The test plan is complete enough: `auth_refresh_deduplicates_parallel_requests`, `auth_refresh_allows_parallel_tenants`, `auth_refresh_uses_rollback_flag`, and `auth_refresh_propagates_queue_errors`. This thread can be summarized later unless we explicitly work on auth tests again.

--- turn ---
We are about to switch to a completely different open-source bug. The old auth/docs/test discussion is only historical context. Do not let those details leak into the next repository unless a context-management tool explicitly says they are relevant.
