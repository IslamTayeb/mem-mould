import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import { MODEL_ENV_VAR, parseModelSlug } from "../model";

const execFileAsync = promisify(execFile);

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const projectRoot = path.resolve(process.cwd());
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "mem-mould-context-map-manual-"),
  );
  const repo = path.join(tempRoot, "demo-repo");
  const home = path.join(tempRoot, "home");
  const data = path.join(tempRoot, "data");
  const config = path.join(tempRoot, "config");
  const state = path.join(tempRoot, "state");
  const cache = path.join(tempRoot, "cache");
  await Promise.all(
    [repo, home, data, config, state, cache].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );

  console.log("Creating demo repo...");
  await createDemoRepo(projectRoot, repo);
  const commits = await createDemoCommits(repo);
  console.log(`  ${Object.keys(commits).length} commits created`);

  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    OPENCODE_DB: path.join(tempRoot, "opencode.sqlite"),
    MEM_MOULD_DISABLE_GIT_HOOK_INSTALL: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [
        pathToFileURL(path.join(projectRoot, "src", "server-plugin.ts")).href,
      ],
    }),
  };

  console.log("Starting server to create sessions...");
  const server = await startServer(env, repo);

  const sessions: Record<string, string> = {};
  try {
    const client = createOpencodeClient({ baseUrl: server.url });

    const titles = [
      "Auth queue investigation",
      "API rate limiting implementation",
      "Documentation overhaul",
      "Token expiry clock skew bug",
      "Shared queue utility refactor",
      "Cross-cutting review and cleanup",
      "Historical investigation",
    ];
    for (const title of titles) {
      const key = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      const res =
        ((await client.session.create({ directory: repo, title })) as any)
          ?.data ?? {};
      assert.ok(res.id, `failed to create session: ${title}`);
      sessions[key] = res.id;
      console.log(`  Created: ${title} -> ${res.id}`);
    }
  } finally {
    await server.close();
  }

  // ── Compose synthetic context maps ──────────────────────────────
  console.log("Composing context maps...");
  const mapsDir = path.join(home, ".opencode", "context-maps");
  await fs.mkdir(mapsDir, { recursive: true });

  const maps = composeContextMaps(sessions, repo);
  for (const map of maps) {
    await fs.writeFile(
      path.join(mapsDir, `${map.sessionID}.json`),
      JSON.stringify(map, null, 2),
    );
  }
  console.log(`  ${maps.length} context maps written`);

  // ── Commit map ──────────────────────────────────────────────────
  const commitEntries: Record<string, unknown> = {};
  const commitLinks: Array<[string, string, string]> = [
    [
      commits.authCommit,
      sessions.auth_queue_investigation!,
      "auth_queue_migration",
    ],
    [
      commits.apiCommit,
      sessions.api_rate_limiting_implementation!,
      "rate_limit_design",
    ],
    [commits.docsCommit, sessions.documentation_overhaul!, "docs_audit"],
    [
      commits.bugfixCommit,
      sessions.token_expiry_clock_skew_bug!,
      "clock_skew_fix",
    ],
    [
      commits.refactorCommit,
      sessions.shared_queue_utility_refactor!,
      "shared_queue_design",
    ],
  ];
  for (const [hash, sessionID, blobID] of commitLinks) {
    const map = maps.find((m) => m.sessionID === sessionID);
    commitEntries[hash] = {
      commitHash: hash,
      sessionID,
      timestamp: Date.now(),
      directory: repo,
      worktree: repo,
      activeBlobID: blobID,
      activeBlobLabel: (map?.blobs[blobID] as any)?.label ?? blobID,
      activeBlobIDs: [blobID],
    };
  }
  await fs.writeFile(
    path.join(mapsDir, "_commits.json"),
    JSON.stringify(
      { version: 1, updatedAt: Date.now(), entries: commitEntries },
      null,
      2,
    ),
  );

  // ── Insert synthetic messages into DB ───────────────────────────
  console.log("Inserting synthetic messages...");
  const dbPath = path.join(tempRoot, "opencode.sqlite");

  // Collect all SQL statements to batch-insert
  const stmts: string[] = [];
  let totalMsgs = 0;
  const fixtureModel = parseModelSlug(
    process.env[MODEL_ENV_VAR]?.trim() || "fixture/demo-model",
  );

  // Demo file snippets for realistic tool output
  const fileSnippets: Record<string, string> = {
    "src/auth/rate_limiter.ts":
      'import { enqueueRefresh } from "./queue"\n\nexport async function refreshToken(userID: string) {\n  const current = await loadCurrentToken(userID)\n  if (!current.needsRefresh) return current\n\n  // Rate limiter for token refresh\n  // History: v1 mutex caused deadlocks with 3+ concurrent refreshes\n  // v2: switched to async queue\n  // Rollback flag: revert to mutex with 500ms timeout\n  return await enqueueRefresh(userID, async () => await issueNewToken(userID))\n}\n\nasync function loadCurrentToken(userID: string) {\n  return { userID, needsRefresh: true }\n}\n\nasync function issueNewToken(userID: string) {\n  return { userID, needsRefresh: false }\n}',
    "src/auth/queue.ts":
      "const pending = new Map<string, Promise<unknown>>()\n\nexport async function enqueueRefresh<T>(key: string, job: () => Promise<T>): Promise<T> {\n  const existing = pending.get(key)\n  if (existing) {\n    await existing\n    return job()\n  }\n  const promise = job()\n  pending.set(key, promise)\n  try {\n    return await promise\n  } finally {\n    pending.delete(key)\n  }\n}",
    "src/auth/token_manager.ts":
      'import { loadConfig } from "../config/settings"\n\nexport interface TokenPayload {\n  userID: string; email: string; roles: string[];\n  issuedAt: number; expiresAt: number\n}\n\nexport async function issueToken(userID: string, email: string, roles: string[]): Promise<string> {\n  const config = loadConfig()\n  const payload: TokenPayload = { userID, email, roles, issuedAt: Date.now(), expiresAt: Date.now() + config.tokenTTLMs }\n  return Buffer.from(JSON.stringify(payload)).toString("base64")\n}\n\nexport function decodeToken(token: string): TokenPayload | null {\n  try { const d = JSON.parse(Buffer.from(token, "base64").toString("utf8")); return d.expiresAt < Date.now() ? null : d } catch { return null }\n}\n\nexport function isTokenExpired(p: TokenPayload): boolean {\n  // Fix: handle clock skew with 5-second grace period\n  return p.expiresAt < Date.now() - 5000\n}\n\nexport function tokenNeedsRefresh(p: TokenPayload, bufferMs = 60_000): boolean {\n  return p.expiresAt - Date.now() < bufferMs\n}',
    "src/auth/session_store.ts":
      "const sessions = new Map<string, { userID: string; token: string; createdAt: number }>()\n\nexport function createSession(userID: string, token: string) {\n  const id = `sess_${Date.now()}`\n  sessions.set(id, { userID, token, createdAt: Date.now() })\n  return id\n}\n\nexport function getSession(id: string) { return sessions.get(id) ?? null }\nexport function deleteSession(id: string) { sessions.delete(id) }\n\nexport function cleanExpiredSessions(maxAgeMs = 86_400_000) {\n  const cutoff = Date.now() - maxAgeMs\n  for (const [id, s] of sessions) {\n    if (s.createdAt < cutoff) sessions.delete(id)\n  }\n}",
    "src/middleware/auth_middleware.ts":
      'import { decodeToken, tokenNeedsRefresh } from "../auth/token_manager"\nimport { refreshToken } from "../auth/rate_limiter"\n\nexport async function authMiddleware(headers: Record<string, string>) {\n  const token = headers.authorization?.replace("Bearer ", "")\n  if (!token) return { authenticated: false, error: "No token" as const }\n  const payload = decodeToken(token)\n  if (!payload) return { authenticated: false, error: "Invalid token" as const }\n  if (tokenNeedsRefresh(payload)) {\n    const refreshed = await refreshToken(payload.userID)\n    return { authenticated: true, userID: payload.userID, refreshedToken: refreshed }\n  }\n  return { authenticated: true, userID: payload.userID }\n}',
    "src/middleware/rate_limit_middleware.ts":
      'import { loadConfig } from "../config/settings"\nconst counters = new Map<string, { count: number; resetAt: number }>()\n\nexport function rateLimitMiddleware(clientIP: string) {\n  const config = loadConfig()\n  const now = Date.now()\n  const entry = counters.get(clientIP)\n  if (!entry || entry.resetAt < now) {\n    counters.set(clientIP, { count: 1, resetAt: now + 60_000 })\n    return { allowed: true, remaining: config.rateLimitPerMinute - 1 }\n  }\n  entry.count++\n  if (entry.count > config.rateLimitPerMinute) return { allowed: false, remaining: 0 }\n  return { allowed: true, remaining: config.rateLimitPerMinute - entry.count }\n}',
    "src/config/settings.ts":
      'export interface AppConfig {\n  port: number; tokenTTLMs: number; refreshBufferMs: number;\n  rateLimitPerMinute: number; maxSessionsPerUser: number;\n  enableMetrics: boolean; logLevel: "debug"|"info"|"warn"|"error"\n}\nconst defaults: AppConfig = {\n  port: 3000, tokenTTLMs: 3_600_000, refreshBufferMs: 60_000,\n  rateLimitPerMinute: 60, maxSessionsPerUser: 5,\n  enableMetrics: false, logLevel: "info"\n}\nlet config: AppConfig = { ...defaults }\nexport function loadConfig(): AppConfig { return config }\nexport function updateConfig(overrides: Partial<AppConfig>) { config = { ...config, ...overrides } }',
    "src/api/endpoints.ts":
      'import { refreshToken } from "../auth/rate_limiter"\nimport { decodeToken } from "../auth/token_manager"\nimport { getUser, listUsers, registerUser, loginUser } from "./users"\n\nexport async function handleRequest(req: ApiRequest): Promise<ApiResponse> {\n  if (req.path === "/health") return { status: 200, body: { ok: true } }\n  if (req.path === "/register" && req.method === "POST") { ... }\n  // Auth-protected routes\n  const token = req.headers.authorization?.replace("Bearer ", "")\n  if (!token) return { status: 401, body: { error: "Missing token" } }\n  ...\n}',
    "src/utils/queue.ts":
      "const pending = new Map<string, Promise<unknown>>()\n\nexport async function enqueueJob<T>(key: string, job: () => Promise<T>): Promise<T> {\n  const existing = pending.get(key)\n  if (existing) { await existing; return job() }\n  const promise = job()\n  pending.set(key, promise)\n  try { return await promise } finally { pending.delete(key) }\n}\n\nexport function pendingJobCount(): number { return pending.size }",
    "docs/architecture.md":
      "# Architecture\n\n## Auth Flow\n1. User registers/logs in\n2. Server issues base64 token (JWT in prod)\n3. Client sends token in Authorization header\n4. Middleware validates and auto-refreshes\n\n## Rate Limiting\n- Per-IP in middleware\n- Token refresh uses async queue\n\n## Known Issues\n- Token refresh race condition fixed by queue\n- Session cleanup runs lazily",
    "docs/onboarding.md":
      "# Onboarding\n\n## Quickstart\n1. Clone\n2. npm install\n3. npm test\n\n## Key Concepts\n- Auth tokens are base64 JSON (JWT in prod)\n- Refresh uses async queue to avoid races\n- Rate limiting is per-IP",
    "tests/auth/queue.test.ts":
      'test("queue serializes concurrent calls", async () => {\n  expect(true).toBe(true)\n})',
    "tests/auth/rate_limiter.test.ts":
      'import { refreshToken } from "../../src/auth/rate_limiter"\ntest("refreshToken returns new token", async () => {\n  const r = await refreshToken("u1")\n  expect(r).toBeDefined()\n})',
    "tests/auth/token.test.ts":
      'import { issueToken, decodeToken } from "../../src/auth/token_manager"\ntest("issueToken creates valid token", async () => {\n  const t = await issueToken("u1","t@t.com",["user"])\n  expect(typeof t).toBe("string")\n})\ntest("decodeToken returns payload", async () => {\n  const t = await issueToken("u1","t@t.com",["user"])\n  expect(decodeToken(t)?.userID).toBe("u1")\n})',
    "tests/integration/auth_flow.test.ts":
      'import { handleRequest } from "../../src/api/endpoints"\ntest("full auth flow", async () => {\n  const reg = await handleRequest({ method: "POST", path: "/register", headers: {}, body: { email: "t@t.com", name: "Test" } })\n  expect(reg.status).toBe(201)\n})',
  };

  function expandAssistantText(
    summary: string,
    keyFacts: string[],
    blobKeyFacts: string[],
  ): string {
    const facts = keyFacts.length > 0 ? keyFacts : blobKeyFacts;

    // Build a realistic multi-section assistant response
    const sections: string[] = [];

    // Opening analysis paragraph
    sections.push(summary);
    sections.push("");

    // If there are facts, present them as structured findings
    if (facts.length > 0) {
      sections.push("Here's what I found:\n");
      for (const fact of facts) {
        sections.push(`**${fact}**`);
        // Add a sentence of elaboration per fact
        sections.push(elaborateFact(fact));
        sections.push("");
      }
    }

    // Add contextual analysis - varies based on content keywords
    if (
      summary.includes("queue") ||
      summary.includes("mutex") ||
      summary.includes("concurrent")
    ) {
      sections.push(
        "## Concurrency Analysis\n",
        "The concurrency model here is important to understand. When multiple requests arrive simultaneously " +
          "with near-expired tokens, the system needs to serialize refresh operations per-user while still allowing " +
          "different users to refresh concurrently. The queue achieves this through a `Map<string, Promise>` keyed " +
          "by userID — if a pending promise exists for a key, subsequent callers await it rather than starting a " +
          "duplicate refresh.\n",
        "This is fundamentally different from a mutex, which would block the entire refresh pathway. The mutex " +
          "approach failed because it held a lock across an async boundary (the token issuer network call), meaning " +
          "if the issuer was slow (>2s), all other refresh attempts for ANY user would queue up behind it.\n",
      );
    } else if (
      summary.includes("clock skew") ||
      summary.includes("expir") ||
      summary.includes("401")
    ) {
      sections.push(
        "## Timing Analysis\n",
        "The timing window here is subtle. Consider this sequence:\n",
        "1. Client sends request at T=0 with token expiring at T=5s\n" +
          "2. Network transit takes 200ms, arrives at server at T=0.2s\n" +
          "3. Server checks `isTokenExpired()` — token is valid (5s > 0.2s)\n" +
          "4. But if server clock is 6 seconds ahead of client clock, server sees the token as expired\n",
        "",
        "The 5-second grace period we added handles typical NTP drift (usually <1s) with margin. But in " +
          "environments with poor NTP synchronization (some cloud VMs, edge deployments), you might need to " +
          "increase this. The `clockSkewGraceMs` config option allows tuning per-deployment.\n",
      );
    } else if (
      summary.includes("rate limit") ||
      summary.includes("429") ||
      summary.includes("per-user")
    ) {
      sections.push(
        "## Rate Limiting Architecture\n",
        "The sliding window approach works by maintaining an array of timestamped request entries per key. " +
          "On each request, we:\n",
        "1. Remove entries older than the window (e.g., 60 seconds)\n" +
          "2. Count remaining entries\n" +
          "3. If count exceeds limit, return 429 with `Retry-After` header\n" +
          "4. Otherwise, add new entry and return with `X-RateLimit-Remaining`\n",
        "",
        "This is more accurate than the fixed-window approach (which resets at fixed intervals and allows " +
          "burst at window boundaries) but uses more memory per-key. For a service with 10K concurrent users, " +
          "each with a 60-request/minute limit, we'd store up to 600K timestamp entries in memory. This is " +
          "acceptable for most deployments but might need Redis-backing at scale.\n",
      );
    } else if (
      summary.includes("doc") ||
      summary.includes("onboarding") ||
      summary.includes("architecture")
    ) {
      sections.push(
        "## Documentation Assessment\n",
        "Good documentation should answer three questions for any component: (1) what does it do, (2) why " +
          "does it exist (what problem does it solve), and (3) what are the gotchas. The current docs cover " +
          "#1 reasonably well but are weak on #2 and #3.\n",
        "For example, the queue migration is well-commented in the source code but not mentioned in " +
          "architecture.md. A new developer reading the architecture doc would not understand *why* the queue " +
          "exists, only that it does. The code comments in `rate_limiter.ts` are actually the best documentation " +
          "of this decision — they should be extracted into a proper architecture decision record.\n",
      );
    } else if (summary.includes("test") || summary.includes("coverage")) {
      sections.push(
        "## Test Coverage Gaps\n",
        "The test suite has a common pattern I see in many codebases: good unit tests for the happy path, " +
          "but missing coverage for error handling, concurrency, and edge cases. Specifically:\n",
        "- **Error propagation**: What happens when `issueNewToken` throws? Does the queue clean up correctly?\n" +
          "- **Concurrent access**: The queue test verifies serialization but not what happens with 100 concurrent callers\n" +
          "- **Boundary conditions**: Token expiry at exact boundary, refresh buffer interaction with grace period\n" +
          "- **Integration**: The auth flow test stops at registration — doesn't exercise refresh or rate limiting\n",
        "",
        "I'd prioritize the error propagation tests first since those represent the highest-risk gap. A bug in " +
          "error handling would cause the queue to leak entries in the pending Map, eventually blocking all " +
          "refreshes for affected users.\n",
      );
    } else if (
      summary.includes("security") ||
      summary.includes("unsigned") ||
      summary.includes("forge")
    ) {
      sections.push(
        "## Security Impact Assessment\n",
        "The severity of unsigned tokens depends entirely on the deployment model:\n",
        "- **Internal-only API** (behind VPN/firewall): Low severity. Attackers need network access first.\n" +
          "- **Public API with OAuth gateway**: Medium. The gateway validates tokens before they reach this service.\n" +
          "- **Public API, direct access**: **Critical**. Any HTTP client can forge admin tokens.\n",
        "",
        "The fix path is straightforward:\n",
        "```typescript\n" +
          "// Before (forgeable):\n" +
          "return Buffer.from(JSON.stringify(payload)).toString('base64')\n" +
          "\n" +
          "// After (signed JWT):\n" +
          "import { SignJWT } from 'jose'\n" +
          "return new SignJWT(payload).setProtectionHeader({ alg: 'HS256' }).sign(secret)\n" +
          "```\n",
        "Estimated effort: 2-3 hours for the migration, plus updating all token validation call sites.\n",
      );
    } else if (
      summary.includes("refactor") ||
      summary.includes("duplicat") ||
      summary.includes("unified")
    ) {
      sections.push(
        "## Refactoring Strategy\n",
        "When unifying duplicated code, the key risk is changing behavior for existing callers. The approach " +
          "I'd recommend:\n",
        "1. **Write the shared implementation** with the superset of features from both copies\n" +
          "2. **Add comprehensive tests** for the shared version before migrating callers\n" +
          "3. **Migrate one caller at a time**, running integration tests between each migration\n" +
          "4. **Delete the old implementation** only after all callers are migrated and tests pass\n",
        "",
        "The critical detail is step 2: the shared queue needs tests that cover behaviors from *both* the " +
          "auth-specific and utils versions. If the auth version had implicit retry behavior that the utils " +
          "version didn't, migrating without testing that behavior would introduce a regression.\n",
      );
    } else {
      sections.push(
        "## Analysis\n",
        "Looking at this holistically, the codebase has a solid foundation but shows signs of organic growth " +
          "without periodic consolidation. The duplicated queue implementations, the undocumented architectural " +
          "decisions, and the shallow integration tests all point to a team that's been shipping features " +
          "without dedicated tech debt sprints.\n",
        "The good news is that the individual components are well-structured — the auth system, rate limiting, " +
          "and middleware each have clear boundaries and responsibilities. The gaps are in the connections " +
          "between them (error propagation, configuration management) rather than in the components themselves.\n",
      );
    }

    sections.push(
      "Let me know if you'd like me to proceed with any of these changes, investigate further, or " +
        "move on to the next area.",
    );

    return sections.join("\n");
  }

  function elaborateFact(fact: string): string {
    // Specific matches
    if (fact.includes("mutex") || fact.includes("deadlock"))
      return "Under load testing with 3+ concurrent refresh attempts, the mutex would hold while awaiting the token issuer (a network call), causing a cascading queue of blocked requests that eventually timed out.";
    if (fact.includes("coalesce"))
      return "This is the key correctness property: the second caller gets the result of the first caller's refresh, not a stale token. Without this, the queue would serialize requests but still return expired tokens to waiters.";
    if (fact.includes("rollback"))
      return "The flag is documented in code comments: `// Rollback flag: if queue causes issues, revert to mutex with 500ms timeout and retry logic.` This suggests the team wasn't fully confident in the queue approach at deployment time.";
    if (
      fact.includes("unsigned") ||
      fact.includes("forge") ||
      fact.includes("no signature")
    )
      return "Any client can decode the token with `atob()`, modify the payload (e.g., change roles to `['admin']`), and re-encode it. There's no signature to detect tampering.";
    if (fact.includes("never") && fact.includes("import"))
      return "The function exists in the module's export list but `grep -r` across the entire codebase shows zero import statements for it. This means the sessions Map grows monotonically for the lifetime of the process.";
    if (
      fact.includes("clock skew") ||
      fact.includes("grace") ||
      fact.includes("NTP")
    )
      return "NTP typically keeps clocks within 1-2 seconds, but edge cases exist: VM migration, container restart, poor NTP configuration. The 5-second default provides reasonable coverage.";
    if (fact.includes("dynamic import"))
      return "The `await import(...)` inside the request handler means Node.js resolves the module on every request. While V8 caches resolved modules, the async overhead and microtask scheduling add unnecessary latency.";

    // Broader category matches
    if (
      fact.includes("401") ||
      fact.includes("expir") ||
      (fact.includes("token") && fact.includes("refresh"))
    )
      return "This timing-sensitive behavior means that even a small delay or clock mismatch can cause valid requests to fail authentication, especially under load when refresh latency increases.";
    if (
      fact.includes("queue") ||
      fact.includes("serializ") ||
      fact.includes("pending")
    )
      return "The serialization mechanism ensures only one operation runs per key at a time, preventing duplicate work and race conditions while still allowing different keys to proceed concurrently.";
    if (
      fact.includes("test") ||
      fact.includes("coverage") ||
      fact.includes("auth_flow")
    )
      return "Without targeted tests for this scenario, regressions could slip through CI undetected. The gap between what the test name claims and what it actually exercises creates a false sense of security.";
    if (
      fact.includes("config") ||
      fact.includes("Config") ||
      fact.includes("setting")
    )
      return "Having this as a configurable value means operators can tune it per-deployment without code changes, which is essential for environments with different network characteristics or security requirements.";
    if (
      fact.includes("doc") ||
      fact.includes("README") ||
      fact.includes("onboarding") ||
      fact.includes("architecture")
    )
      return "Documentation that falls out of sync with the code is worse than no documentation — it actively misleads new contributors and creates debugging dead-ends when the described behavior doesn't match reality.";
    if (
      fact.includes("import") ||
      fact.includes("migrat") ||
      fact.includes("refactor")
    )
      return "This migration needs careful sequencing: update imports, verify no remaining references to the old module, run the full test suite, then remove the old file. Skipping any step risks runtime import failures.";
    if (
      fact.includes("endpoint") ||
      fact.includes("middleware") ||
      fact.includes("handler") ||
      fact.includes("subsystem")
    )
      return "Understanding this flow is critical for debugging — when a request fails, you need to know which layer rejected it and why. Each middleware adds context and constraints to the request before the final handler sees it.";
    if (
      fact.includes("validation") ||
      fact.includes("input") ||
      fact.includes("spoofable")
    )
      return "Without proper validation, malicious input can bypass security controls or corrupt internal state. This is especially dangerous for public-facing endpoints where input cannot be trusted.";
    if (
      fact.includes("monitor") ||
      fact.includes("metric") ||
      fact.includes("track") ||
      fact.includes("observ")
    )
      return "Without observability into this behavior, issues will only surface as user-reported bugs rather than being caught by automated alerting. Even basic counters and histograms provide significant debugging value.";
    if (
      fact.includes("session") ||
      fact.includes("cleanup") ||
      fact.includes("unbounded") ||
      fact.includes("grow")
    )
      return "Unbounded growth in a long-running process is a slow-motion incident — it works fine in development and staging but fails after days or weeks in production when memory pressure triggers GC pauses or OOM kills.";
    if (
      fact.includes("blame") ||
      fact.includes("commit") ||
      fact.includes("session")
    )
      return "Having a direct link from code changes back to the decision-making session provides invaluable context for future contributors trying to understand why a particular approach was chosen.";

    // Smart fallback: rephrase the fact as an observation
    return `In practice, ${fact.charAt(0).toLowerCase()}${fact.slice(1).replace(/\.$/, "")} — and this has direct implications for how the system behaves under load.`;
  }

  function toolInput(tool: string, files: string[]): Record<string, unknown> {
    if (tool === "Read")
      return { filePath: files[0] ?? "src/auth/rate_limiter.ts" };
    if (tool === "Edit")
      return {
        filePath: files[0] ?? "src/auth/rate_limiter.ts",
        oldString: "// placeholder",
        newString: "// updated",
      };
    if (tool === "Bash")
      return { command: "grep -r 'cleanExpiredSessions' src/" };
    if (tool === "Grep")
      return { pattern: "cleanExpiredSessions", include: "*.ts" };
    if (tool === "Glob") return { pattern: "tests/**/*.test.ts" };
    return {};
  }

  function toolOutput(tool: string, files: string[]): string {
    if (tool === "Read")
      return (
        fileSnippets[files[0] ?? ""] ?? `// Content of ${files[0] ?? "unknown"}`
      );
    if (tool === "Edit") return "Edit applied successfully.";
    if (tool === "Bash")
      return "src/auth/session_store.ts:export function cleanExpiredSessions";
    if (tool === "Grep")
      return "src/auth/session_store.ts:12: export function cleanExpiredSessions";
    if (tool === "Glob")
      return "tests/auth/token.test.ts\ntests/auth/queue.test.ts\ntests/auth/rate_limiter.test.ts\ntests/api/endpoints.test.ts\ntests/integration/auth_flow.test.ts";
    return "OK";
  }

  // Heuristic: map tool names to likely files based on blob context
  const toolFileHints: Record<string, string[]> = {
    auth_queue_migration: ["src/auth/rate_limiter.ts", "src/auth/queue.ts"],
    session_store_leak: ["src/auth/session_store.ts"],
    auth_testing: ["tests/auth/queue.test.ts", "docs/architecture.md"],
    rate_limit_design: [
      "src/middleware/rate_limit_middleware.ts",
      "src/api/endpoints.ts",
      "src/config/settings.ts",
    ],
    rate_limit_implementation: [
      "src/middleware/rate_limit_middleware.ts",
      "src/api/endpoints.ts",
    ],
    rate_limit_auth_interaction: ["src/auth/rate_limiter.ts"],
    docs_audit: [
      "docs/onboarding.md",
      "docs/api-reference.md",
      "docs/architecture.md",
    ],
    troubleshooting_guide: ["docs/architecture.md"],
    docs_testing_gap: ["tests/integration/auth_flow.test.ts"],
    clock_skew_investigation: [
      "src/auth/token_manager.ts",
      "src/middleware/auth_middleware.ts",
    ],
    queue_suspicion: ["src/auth/queue.ts"],
    clock_skew_fix: ["src/auth/token_manager.ts", "src/config/settings.ts"],
    monitoring_design: ["src/api/endpoints.ts"],
    shared_queue_design: ["src/auth/queue.ts", "src/utils/queue.ts"],
    queue_migration: ["src/auth/rate_limiter.ts"],
    queue_test_migration: ["tests/auth/queue.test.ts"],
    project_overview: ["src/api/endpoints.ts"],
    security_review: [
      "src/middleware/auth_middleware.ts",
      "src/auth/token_manager.ts",
    ],
    test_coverage_assessment: ["tests/auth/token.test.ts"],
    historical_decisions: ["src/auth/rate_limiter.ts"],
    session_discovery: ["src/auth/rate_limiter.ts"],
    auth_migration_history: ["src/auth/rate_limiter.ts", "src/auth/queue.ts"],
    code_archaeology: ["docs/architecture.md", "docs/onboarding.md"],
  };

  for (const map of maps) {
    const msgEntries = Object.values(map.messages) as Array<{
      id: string;
      role: string;
      blobID: string;
      summary: string;
      keyFacts: string[];
      tokenEstimate: number;
      createdAt: number;
      toolNames: string[];
    }>;
    const sorted = msgEntries.sort((a, b) => a.createdAt - b.createdAt);
    let lastUserMsgID: string | undefined;

    for (const msg of sorted) {
      const ts = msg.createdAt;
      const msgID = msg.id;
      const sessionID = map.sessionID;
      const files = toolFileHints[msg.blobID] ?? ["src/auth/rate_limiter.ts"];

      const msgData: Record<string, unknown> = {
        role: msg.role,
        time: {
          created: ts,
          ...(msg.role === "assistant" ? { completed: ts + 3000 } : {}),
        },
        agent: "code",
      };
      if (msg.role === "user") {
        msgData.model = {
          providerID: fixtureModel.providerID,
          modelID: fixtureModel.modelID,
        };
      } else {
        msgData.parentID = lastUserMsgID;
        msgData.modelID = fixtureModel.modelID;
        msgData.providerID = fixtureModel.providerID;
        msgData.mode = "code";
        msgData.path = { cwd: repo, root: repo };
        msgData.cost = 0.003;
        msgData.tokens = {
          input: Math.round(msg.tokenEstimate * 0.6),
          output: Math.round(msg.tokenEstimate * 0.4),
          reasoning: 0,
          cache: { read: Math.round(msg.tokenEstimate * 0.3), write: 0 },
        };
      }
      if (msg.role === "user") lastUserMsgID = msgID;

      // Text content: user messages use summary (strip prefix), assistants get expanded
      const blobEntry = map.blobs[msg.blobID] as
        | { keyFacts?: string[] }
        | undefined;
      const textContent =
        msg.role === "user"
          ? msg.summary.replace(/^User request: /, "")
          : expandAssistantText(
              msg.summary,
              msg.keyFacts,
              blobEntry?.keyFacts ?? [],
            );

      const partID = msgID.replace("msg_", "prt_");
      const esc = (s: string) => s.replace(/'/g, "''");
      stmts.push(
        `INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES ('${msgID}', '${sessionID}', ${ts}, ${ts}, json('${esc(JSON.stringify(msgData))}'));`,
      );
      stmts.push(
        `INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('${partID}', '${msgID}', '${sessionID}', ${ts}, ${ts}, json('${esc(JSON.stringify({ type: "text", text: textContent }))}'));`,
      );

      // Tool parts
      if (msg.role === "assistant" && msg.toolNames.length > 0) {
        for (let ti = 0; ti < msg.toolNames.length; ti++) {
          const tn = msg.toolNames[ti]!;
          const toolPartID = `prt_t${ti}_${msgID.slice(4)}`;
          const td = {
            type: "tool",
            callID: `call_${msgID.slice(4)}_${ti}`,
            tool: tn,
            state: {
              status: "completed",
              input: toolInput(tn, files),
              output: toolOutput(tn, files),
              title: `${tn}${tn === "Read" ? ` ${files[0] ?? ""}` : ""}`,
              metadata: {},
              time: { start: ts, end: ts + 2000 },
            },
          };
          stmts.push(
            `INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('${toolPartID}', '${msgID}', '${sessionID}', ${ts}, ${ts}, json('${esc(JSON.stringify(td))}'));`,
          );
        }
      }
      totalMsgs++;
    }
  }

  // Batch insert via single sqlite3 call
  const sqlPath = path.join(tempRoot, "insert_messages.sql");
  await fs.writeFile(sqlPath, stmts.join("\n"));
  await execFileAsync("sqlite3", [dbPath, `.read ${sqlPath}`]);
  await fs.rm(sqlPath);
  console.log(
    `  ${totalMsgs} messages inserted (${stmts.length} SQL statements)`,
  );

  // ── Save fixtures ──────────────────────────────────────────────
  console.log("Saving fixtures...");
  const fixturesDir = path.join(projectRoot, "fixtures");
  // Clean old fixtures completely before writing new ones
  await fs.rm(fixturesDir, { recursive: true, force: true });
  await fs.mkdir(path.join(fixturesDir, "context-maps"), { recursive: true });

  await execFileAsync(
    "git",
    ["bundle", "create", path.join(fixturesDir, "demo-repo.bundle"), "--all"],
    { cwd: repo },
  );

  // Checkpoint WAL so all data is in the main .sqlite file
  await execFileAsync("sqlite3", [dbPath, "PRAGMA wal_checkpoint(TRUNCATE);"]);
  await fs.copyFile(dbPath, path.join(fixturesDir, "opencode.sqlite"));
  const allMapFiles = await fs.readdir(mapsDir);
  for (const file of allMapFiles) {
    await fs.copyFile(
      path.join(mapsDir, file),
      path.join(fixturesDir, "context-maps", file),
    );
  }

  const metadata = {
    originalRepo: repo,
    originalHome: home,
    sessions,
    commits,
  };
  await fs.writeFile(
    path.join(fixturesDir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
  );

  console.log(`\nDone. Fixtures saved to ${fixturesDir}`);
  console.log("Run 'npm run setup:test-env' to create a test environment.\n");
  console.log(JSON.stringify(metadata, null, 2));
}

// ── Synthetic context maps ────────────────────────────────────────────

type MapBlob = {
  label: string;
  summary: string;
  placeholder: string;
  keyFacts: string[];
  fidelity: "full" | "summary" | "compressed" | "placeholder" | "drop";
  messages: Array<{
    role: "user" | "assistant";
    summary: string;
    keyFacts?: string[];
    tokens: number;
    toolNames?: string[];
  }>;
};

type MapSpec = {
  sessionID: string;
  directory: string;
  blobs: MapBlob[];
};

function composeContextMaps(
  sessions: Record<string, string>,
  directory: string,
) {
  const specs = composeMapSpecs(sessions, directory);
  return specs.map((spec, i) => buildContextMapFromSpec(spec, i));
}

function composeMapSpecs(s: Record<string, string>, dir: string): MapSpec[] {
  return [
    {
      sessionID: s.auth_queue_investigation!,
      directory: dir,
      blobs: [
        {
          label: "auth_queue_migration",
          summary:
            "Investigated why token refresh uses an async queue instead of a mutex. The mutex caused deadlocks under 3+ concurrent refresh attempts because it held a lock while awaiting the token issuer. Queue serializes per-user without blocking.",
          placeholder: "Auth token refresh: mutex→queue migration",
          keyFacts: [
            "Mutex caused deadlocks with 3+ concurrent refreshes",
            "Queue serializes per userID via pending Map",
            "Rollback flag exists in rate_limiter.ts comments",
            "Queue coalesces: second request waits for first, then re-checks",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Read rate_limiter.ts and queue.ts, explain token refresh and mutex vs queue decision",
              tokens: 120,
            },
            {
              role: "assistant",
              summary:
                "Explained token refresh flow: loadCurrentToken → check needsRefresh → enqueueRefresh serializes per userID. Mutex held lock during async issueNewToken, causing deadlocks under concurrency.",
              tokens: 1800,
              toolNames: ["Read"],
            },
            {
              role: "user",
              summary:
                "User request: Trace middleware auto-refresh interaction with queue under 5 concurrent near-expired requests",
              tokens: 150,
            },
            {
              role: "assistant",
              summary:
                "Traced auth_middleware.ts auto-refresh path: tokenNeedsRefresh triggers refreshToken, which enqueues. With 5 concurrent requests, first enters queue, others coalesce and wait. All get the refreshed token.",
              tokens: 2400,
              toolNames: ["Read"],
            },
            {
              role: "user",
              summary:
                "User request: Check test coverage for concurrent refresh scenarios",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Reviewed queue.test.ts and rate_limiter.test.ts. Tests cover basic serialization but miss: error propagation across queued jobs, concurrent different-key execution, and coalescing return value correctness.",
              tokens: 2200,
              toolNames: ["Read"],
            },
          ],
        },
        {
          label: "session_store_leak",
          summary:
            "Discovered that cleanExpiredSessions in session_store.ts is never called by any module. The in-memory session Map grows unbounded in production. Need periodic cleanup or integration with token refresh.",
          placeholder: "Memory leak: session store never cleaned",
          keyFacts: [
            "cleanExpiredSessions exists but is never imported",
            "sessions Map grows unbounded in production",
            "Fix: integrate cleanup with token refresh or add periodic timer",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Check if cleanExpiredSessions is called anywhere — possible memory leak",
              tokens: 80,
            },
            {
              role: "assistant",
              summary:
                "Searched all imports: cleanExpiredSessions is never imported by any file. The sessions Map in session_store.ts grows without bound. Wrote a fix integrating cleanup into the token refresh path.",
              tokens: 1400,
              toolNames: ["Read", "Edit"],
            },
          ],
        },
        {
          label: "auth_testing",
          summary:
            "Wrote new queue tests for error handling and concurrent key execution. Updated architecture docs with queue migration details and session store cleanup.",
          placeholder: "Auth test coverage and docs updates",
          keyFacts: [
            "New test: job throw doesn't break subsequent jobs",
            "New test: different keys execute concurrently",
            "architecture.md updated with queue migration and rollback flag",
          ],
          fidelity: "summary",
          messages: [
            {
              role: "user",
              summary:
                "User request: Write new queue tests for error handling and fix session store leak",
              tokens: 120,
            },
            {
              role: "assistant",
              summary:
                "Added two test cases to queue.test.ts: error isolation and concurrent different-key execution. Fixed session_store.ts with cleanup integration.",
              tokens: 1600,
              toolNames: ["Read", "Edit"],
            },
            {
              role: "user",
              summary:
                "User request: Update architecture docs and summarize everything about auth system",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Updated architecture.md with queue migration history, session store fix, rollback flag. Full summary: key files are rate_limiter.ts, queue.ts, session_store.ts, auth_middleware.ts. Remaining risks: unsigned tokens, no queue timeout.",
              tokens: 3800,
              toolNames: ["Read", "Edit"],
            },
          ],
        },
      ],
    },
    {
      sessionID: s.api_rate_limiting_implementation!,
      directory: dir,
      blobs: [
        {
          label: "rate_limit_design",
          summary:
            "Designed per-user sliding window rate limiting with X-RateLimit-Remaining and Retry-After headers. Falls back to per-IP for unauthenticated requests. Added burstAllowance config.",
          placeholder: "Per-user sliding window rate limiter design",
          keyFacts: [
            "Per-user when authenticated, per-IP fallback",
            "Sliding window instead of fixed window",
            "Headers: X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After",
            "New config: userRateLimitPerMinute, rateLimitWindowMs, burstAllowance",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Read rate_limit_middleware.ts, endpoints.ts, settings.ts — understand current rate limiting",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Current approach: simple per-IP counter with fixed 60s window. No per-user limits, no response headers, no burst handling. Config has rateLimitPerMinute only.",
              tokens: 1600,
              toolNames: ["Read"],
            },
            {
              role: "user",
              summary:
                "User request: Design per-user sliding window with headers and IP fallback",
              tokens: 140,
            },
            {
              role: "assistant",
              summary:
                "Designed sliding window approach: store timestamped request entries per key (userID or IP), count within window. Add X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After headers. Burst allowance allows 2x limit in first second.",
              tokens: 2800,
            },
          ],
        },
        {
          label: "rate_limit_implementation",
          summary:
            "Implemented new rate limiter. Fixed dynamic import performance bug in endpoints.ts (was importing rate_limit_middleware on every request). Wrote comprehensive tests.",
          placeholder: "Rate limiter implementation and perf fix",
          keyFacts: [
            "Fixed dynamic import in endpoints.ts → static import",
            "Sliding window uses timestamped entries array",
            "Tests cover: window rollover, per-user vs per-IP, burst, headers",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Write updated rate_limit_middleware.ts with sliding window and headers",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Rewrote rate_limit_middleware.ts with sliding window, per-user/per-IP fallback, and HTTP response headers. Updated settings.ts with new config fields.",
              tokens: 2200,
              toolNames: ["Read", "Edit"],
            },
            {
              role: "user",
              summary:
                "User request: Fix dynamic import bug in endpoints.ts, integrate new rate limiter",
              tokens: 120,
            },
            {
              role: "assistant",
              summary:
                "Found perf bug: endpoints.ts had `await import('../middleware/rate_limit_middleware')` inside handleRequest — imported on every request. Changed to static import at top. Integrated per-user rate limiting when token is present.",
              tokens: 1400,
              toolNames: ["Read", "Edit"],
            },
            {
              role: "user",
              summary: "User request: Write comprehensive rate limiting tests",
              tokens: 80,
            },
            {
              role: "assistant",
              summary:
                "Created tests/api/rate_limit.test.ts with 6 test cases: sliding window rollover, per-user vs per-IP, burst allowance, header accuracy, config change at runtime, 429 response format.",
              tokens: 1800,
              toolNames: ["Edit"],
            },
          ],
        },
        {
          label: "rate_limit_auth_interaction",
          summary:
            "Analyzed whether API rate limiting should exempt token refresh requests. Recommendation: exempt /refresh endpoint from per-user rate limits to prevent auth deadlocks.",
          placeholder: "Rate limit vs token refresh interaction",
          keyFacts: [
            "Token refresh via queue already self-rate-limits",
            "Counting refresh against API limit could block auth recovery",
            "Recommendation: exempt /refresh from per-user rate limits",
          ],
          fidelity: "compressed",
          messages: [
            {
              role: "user",
              summary:
                "User request: Should API rate limiter exempt token refresh? Think through implications",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Analysis: token refresh already serializes via queue. If refresh counts against API rate limit, a user at their limit can't refresh expired tokens → auth deadlock. Recommend exempting /refresh endpoint from per-user limits but keeping per-IP limits as abuse protection.",
              tokens: 2600,
            },
          ],
        },
      ],
    },
    {
      sessionID: s.documentation_overhaul!,
      directory: dir,
      blobs: [
        {
          label: "docs_audit",
          summary:
            "Audited all docs. Onboarding is incomplete (no quickstart, no auth queue mention). API reference misses rate limiting details. Architecture doc has vague 'Known Issues' section. Rate limiter code comments contain more history than the docs.",
          placeholder: "Documentation audit findings",
          keyFacts: [
            "Onboarding: no quickstart, missing auth queue migration note",
            "API reference: missing rate limiting endpoints and headers",
            "Architecture: 'Known Issues' is vague, code comments are richer",
            "README is bare — no structure, no getting started",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Read all docs, overview what exists and what's missing",
              tokens: 80,
            },
            {
              role: "assistant",
              summary:
                "Three docs exist: onboarding (incomplete quickstart), api-reference (missing rate limiting), architecture (vague known issues). No troubleshooting guide. README is minimal.",
              tokens: 1800,
              toolNames: ["Read"],
            },
            {
              role: "user",
              summary:
                "User request: Compare API reference with actual endpoints.ts, check architecture.md against source",
              tokens: 120,
            },
            {
              role: "assistant",
              summary:
                "API ref missing: /refresh endpoint, rate limiting headers, 429 response format. Architecture doc says 'rate limiting' but doesn't explain sliding window or per-user approach. Code comments in rate_limiter.ts have detailed mutex-to-queue history that docs lack.",
              tokens: 2400,
              toolNames: ["Read"],
            },
            {
              role: "user",
              summary:
                "User request: Should code comment history in rate_limiter.ts live in architecture.md instead?",
              tokens: 80,
            },
            {
              role: "assistant",
              summary:
                "Yes — code comments are the best documentation of the mutex→queue migration but they're buried in source. Architecture.md should have a 'Decision Log' section. Code comments should reference the doc instead of duplicating the full story.",
              tokens: 1600,
            },
          ],
        },
        {
          label: "troubleshooting_guide",
          summary:
            "Wrote troubleshooting.md covering 401 errors (clock skew), rate limiting 429s, concurrent refresh failures, and session store memory growth. Rewrote README with structure and getting started.",
          placeholder: "Troubleshooting guide and README rewrite",
          keyFacts: [
            "troubleshooting.md covers 4 common issues with file references",
            "README rewritten with directory structure and getting started",
            "Onboarding updated with cross-references to all docs",
          ],
          fidelity: "summary",
          messages: [
            {
              role: "user",
              summary:
                "User request: Write troubleshooting.md covering 401 errors, rate limiting, refresh failures, session store growth",
              tokens: 120,
            },
            {
              role: "assistant",
              summary:
                "Created docs/troubleshooting.md with four sections, each referencing specific source files. Covers: clock skew grace period (token_manager.ts), rate limiting headers (rate_limit_middleware.ts), queue serialization (queue.ts), session cleanup (session_store.ts).",
              tokens: 1400,
              toolNames: ["Edit"],
            },
            {
              role: "user",
              summary:
                "User request: Rewrite README and update onboarding with cross-references",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Rewrote README.md with project description, directory structure, getting started steps, and doc links. Updated onboarding.md with cross-references to troubleshooting, architecture, and API reference.",
              tokens: 1200,
              toolNames: ["Read", "Edit"],
            },
          ],
        },
        {
          label: "docs_testing_gap",
          summary:
            "Integration test claims 'full auth flow' but doesn't test token refresh, rate limiting, or session management. Test coverage is shallow across the board.",
          placeholder: "Test coverage gaps found during docs review",
          keyFacts: [
            "auth_flow.test.ts doesn't test token refresh path",
            "No rate limiting tests existed before this work",
            "src/utils/queue.ts used by auth but undocumented",
          ],
          fidelity: "placeholder",
          messages: [
            {
              role: "user",
              summary:
                "User request: Check if integration test actually tests full auth flow, review doc priority",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "auth_flow.test.ts tests register→login→access but skips token refresh, rate limiting interaction, and session management. Prioritized doc changes: (1) architecture decision log, (2) API reference update, (3) troubleshooting guide, (4) queue utility docs.",
              tokens: 2000,
              toolNames: ["Read"],
            },
          ],
        },
      ],
    },
    {
      sessionID: s.token_expiry_clock_skew_bug!,
      directory: dir,
      blobs: [
        {
          label: "clock_skew_investigation",
          summary:
            "Users reporting intermittent 401 errors with fresh tokens around refresh boundaries. Root cause: isTokenExpired uses strict Date.now() comparison with no tolerance for clock skew between client and server.",
          placeholder: "Bug: intermittent 401s from clock skew",
          keyFacts: [
            "401 errors cluster around token refresh boundaries",
            "isTokenExpired: payload.expiresAt < Date.now() — no tolerance",
            "Network latency during refresh round-trip exacerbates the issue",
            "tokenNeedsRefresh buffer (60s) doesn't account for skew",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Users report intermittent 401s with fresh tokens. Investigate token_manager.ts",
              tokens: 120,
            },
            {
              role: "assistant",
              summary:
                "Read token_manager.ts. isTokenExpired does strict comparison: expiresAt < Date.now(). No tolerance for clock skew. tokenNeedsRefresh uses 60s buffer but doesn't account for server-client clock difference.",
              tokens: 1200,
              toolNames: ["Read"],
            },
            {
              role: "user",
              summary:
                "User request: Trace full path from middleware through refresh. Where could timing issues occur?",
              tokens: 120,
            },
            {
              role: "assistant",
              summary:
                "Traced: auth_middleware detects near-expiry → calls refreshToken → queue serializes → issueNewToken → return. Window of vulnerability: between middleware check and queue completion, another request could see the old token as expired. Network latency widens this window.",
              tokens: 2800,
              toolNames: ["Read"],
            },
          ],
        },
        {
          label: "queue_suspicion",
          summary:
            "Initially suspected the refresh queue might cause 401s: if token expires while request waits in queue, it would get rejected. Investigation confirmed queue coalesces correctly — second request waits for first then re-checks. Queue is not the issue.",
          placeholder: "Wrong turn: suspected queue, confirmed OK",
          keyFacts: [
            "Hypothesis: token expires while waiting in queue → 401",
            "Investigation: queue coalesces, second request gets refreshed token",
            "Conclusion: queue works correctly, issue is purely clock skew",
          ],
          fidelity: "compressed",
          messages: [
            {
              role: "user",
              summary:
                "User request: Could this be a queue issue? Token expires while waiting in queue?",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Investigated queue.ts: when a pending promise exists for the same key, subsequent calls await it then re-execute. The refreshed token is returned to all waiters. Queue is not the issue.",
              tokens: 1800,
              toolNames: ["Read"],
            },
          ],
        },
        {
          label: "clock_skew_fix",
          summary:
            "Fixed isTokenExpired with configurable grace period (default 5s). Added clockSkewGraceMs to config. Updated tokenNeedsRefresh to account for grace. Wrote tests for boundary conditions.",
          placeholder: "Fix: 5s grace period for clock skew",
          keyFacts: [
            "isTokenExpired now: expiresAt < Date.now() - graceMs",
            "New config: clockSkewGraceMs (default 5000)",
            "tokenNeedsRefresh uses refreshBufferMs + graceMs",
            "Tests: exact boundary, within grace, outside grace, custom values",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Write fix for clock skew in token_manager.ts with configurable grace period",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Modified isTokenExpired: expiresAt < Date.now() - clockSkewGraceMs. Added clockSkewGraceMs (default 5000) to AppConfig in settings.ts. Updated tokenNeedsRefresh to use combined buffer.",
              tokens: 1600,
              toolNames: ["Read", "Edit"],
            },
            {
              role: "user",
              summary:
                "User request: Write tests for the fix and add integration test for near-expiry auth flow",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Added 5 test cases to token.test.ts: exact boundary, within grace, outside grace, custom grace, interaction with refresh buffer. Added integration test simulating near-expiry token through full middleware flow.",
              tokens: 2000,
              toolNames: ["Read", "Edit"],
            },
          ],
        },
        {
          label: "monitoring_design",
          summary:
            "Designed metrics approach: track refresh counts, 401 rates by cause, and clock skew observations via X-Server-Time response header. Identified other timing assumptions in the codebase.",
          placeholder: "Monitoring design for timing bugs",
          keyFacts: [
            "Track: refresh count, 401 rate by cause, skew observations",
            "X-Server-Time header helps clients detect clock skew",
            "Other timing risks: session store maxAge, rate limit window",
          ],
          fidelity: "summary",
          messages: [
            {
              role: "user",
              summary:
                "User request: Design metrics for refresh counts, 401 rates, clock skew detection",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Proposed three instrumentation points: (1) refreshToken wrapper in rate_limiter.ts for refresh counts, (2) auth_middleware.ts for 401 categorization, (3) X-Server-Time response header in endpoints.ts for client-side skew detection.",
              tokens: 2200,
              toolNames: ["Read", "Edit"],
            },
            {
              role: "user",
              summary:
                "User request: Summarize the bug investigation and scan for other timing assumptions",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Full timeline: report → investigate → wrong turn (queue) → root cause (clock skew) → fix (grace period) → tests → monitoring. Other timing risks found: session store maxAge uses Date.now() without skew tolerance, rate limit window resets could drift.",
              tokens: 3200,
              toolNames: ["Read"],
            },
          ],
        },
      ],
    },
    {
      sessionID: s.shared_queue_utility_refactor!,
      directory: dir,
      blobs: [
        {
          label: "shared_queue_design",
          summary:
            "src/auth/queue.ts and src/utils/queue.ts are nearly identical. Designed unified queue with keyed serialization, try/finally cleanup, TypeScript generics, and pendingJobCount diagnostic.",
          placeholder: "Queue deduplication and unified design",
          keyFacts: [
            "auth/queue.ts and utils/queue.ts are duplicated",
            "Only difference: auth version has key param, utils doesn't",
            "Unified API: enqueueJob<T>(key, job) with try/finally cleanup",
            "Added pendingJobCount() for monitoring integration",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Compare auth/queue.ts and utils/queue.ts, identify differences",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Line-by-line comparison: both use Map<string, Promise>, both have the same coalescing logic. auth/queue uses a string key param, utils/queue doesn't. auth/queue has no error handling. Unified design should add try/finally and generics.",
              tokens: 1800,
              toolNames: ["Read"],
            },
            {
              role: "user",
              summary:
                "User request: Design and write the unified queue utility",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Wrote src/utils/queue.ts: enqueueJob<T>(key: string, job: () => Promise<T>), proper try/finally cleanup to always delete pending entry, pendingJobCount() for diagnostics. TypeScript generics preserve return type.",
              tokens: 1600,
              toolNames: ["Read", "Edit"],
            },
          ],
        },
        {
          label: "queue_migration",
          summary:
            "Migrated rate_limiter.ts from auth/queue to utils/queue. Updated call signature to include key param. Verified integration test conceptually still holds.",
          placeholder: "Auth code migration to shared queue",
          keyFacts: [
            "rate_limiter.ts: import changed from ./queue to ../utils/queue",
            "Call changed: enqueueRefresh(job) → enqueueJob(userID, job)",
            "auth/queue.ts can be removed after migration",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Update rate_limiter.ts to use shared queue, check for other callers",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Updated rate_limiter.ts import to ../utils/queue. Changed call from enqueueRefresh(userID, job) to enqueueJob(userID, job). Searched codebase: only rate_limiter.ts imports from either queue module.",
              tokens: 1200,
              toolNames: ["Read", "Edit"],
            },
          ],
        },
        {
          label: "queue_test_migration",
          summary:
            "Created tests/utils/queue.test.ts with 5 test cases. Migrated relevant tests from auth queue tests. Verified auth/queue.ts safe to remove.",
          placeholder: "Queue test consolidation",
          keyFacts: [
            "5 tests: serialization, concurrent keys, error isolation, cleanup, pendingJobCount",
            "Auth queue tests that tested shared behavior moved to utils",
            "auth/queue.ts confirmed safe to delete",
          ],
          fidelity: "summary",
          messages: [
            {
              role: "user",
              summary:
                "User request: Create shared queue tests, decide which auth tests to migrate",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Created tests/utils/queue.test.ts: (1) basic serialization, (2) different keys concurrent, (3) error isolation, (4) cleanup after error, (5) pendingJobCount accuracy. Moved 2 tests from auth queue, kept 1 auth-specific test.",
              tokens: 1600,
              toolNames: ["Read", "Edit"],
            },
            {
              role: "user",
              summary:
                "User request: Verify integration test, check changed files, call view_context",
              tokens: 120,
            },
            {
              role: "assistant",
              summary:
                "Integration test still valid: refreshToken → enqueueJob → issueNewToken chain preserved. All imports clean, no dead code. Context map shows 3 topics: design, migration, tests — all captured correctly.",
              tokens: 1800,
              toolNames: ["Read"],
            },
          ],
        },
      ],
    },
    {
      sessionID: s.cross_cutting_review_and_cleanup!,
      directory: dir,
      blobs: [
        {
          label: "project_overview",
          summary:
            "Traced request flow: endpoints.ts → rate_limit_middleware → auth_middleware → service handlers. Main components: auth (token, queue, session), API (endpoints, users), config, middleware.",
          placeholder: "Project structure and request flow",
          keyFacts: [
            "Entry point: handleRequest in endpoints.ts",
            "Middleware chain: rate limit → auth → route handler",
            "Four subsystems: auth, api, config, middleware",
          ],
          fidelity: "compressed",
          messages: [
            {
              role: "user",
              summary:
                "User request: Project overview, trace request handling flow",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Read README and directory structure. Traced handleRequest: rate limiting check → public route check → token validation → route handling. Components: src/auth (4 files), src/api (2 files), src/config (1 file), src/middleware (2 files).",
              tokens: 2000,
              toolNames: ["Read"],
            },
          ],
        },
        {
          label: "security_review",
          summary:
            "Critical finding: tokens are unsigned base64 JSON — anyone can forge valid tokens. Rate limiting bypassable via X-Forwarded-For spoofing. No input validation on registration.",
          placeholder: "CRITICAL: unsigned tokens, header spoofing",
          keyFacts: [
            "Tokens are base64 JSON with no signature — trivially forgeable",
            "Rate limiting trusts X-Forwarded-For header — spoofable",
            "No input validation on /register endpoint",
            "Fix path: JWT signing for tokens, trusted proxy config for rate limiting",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Security review of auth middleware and rate limiting",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Critical: token_manager.ts encodes tokens as plain base64 JSON. No HMAC, no JWT signature. Any client can forge: Buffer.from(JSON.stringify(fakePayload)).toString('base64'). Rate limiting uses req.headers['x-forwarded-for'] which is client-controlled.",
              tokens: 2400,
              toolNames: ["Read"],
            },
            {
              role: "user",
              summary:
                "User request: How severe is unsigned tokens? What's the fix path?",
              tokens: 80,
            },
            {
              role: "assistant",
              summary:
                "Severity: critical in production, acceptable in dev/demo. Fix: replace base64 encode/decode with JWT sign/verify using jose or jsonwebtoken library. Rate limiting fix: configure trusted proxy list, fall back to socket remote address.",
              tokens: 1800,
            },
          ],
        },
        {
          label: "test_coverage_assessment",
          summary:
            "Auth has decent test coverage (token, queue, rate limiter). API has basic endpoint tests. Integration tests are shallow. Rate limiting had zero tests before recent work. No tests for config validation or middleware.",
          placeholder: "Test coverage: auth OK, rest shallow",
          keyFacts: [
            "tests/auth/: 3 test files, decent coverage",
            "tests/api/: 1 file, basic happy path only",
            "tests/integration/: 1 file, doesn't test refresh or rate limiting",
            "No tests for: config validation, middleware, session store",
          ],
          fidelity: "summary",
          messages: [
            {
              role: "user",
              summary: "User request: Assess test coverage across the codebase",
              tokens: 80,
            },
            {
              role: "assistant",
              summary:
                "Surveyed tests/: auth/ has 3 files (token, queue, rate_limiter) with reasonable coverage. api/ has 1 file (endpoints) with happy path only. integration/ has 1 file that skips refresh. No middleware or config tests.",
              tokens: 1600,
              toolNames: ["Read"],
            },
          ],
        },
        {
          label: "historical_decisions",
          summary:
            "Used session_lookup to review auth queue and token expiry decisions. Confirmed: queue migration was necessary (mutex deadlocks), clock skew fix added 5s grace, both well-tested. Compressed earlier topics with set_fidelity.",
          placeholder: "Historical context from prior sessions",
          keyFacts: [
            "Auth queue: mutex→queue due to deadlocks, well-documented",
            "Clock skew: 5s grace period, comprehensive tests added",
            "Used set_fidelity to reduce project_overview topic",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Use session_lookup for 'auth queue' and 'token expiry' decisions",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Found 2 relevant sessions via session_lookup. Auth queue investigation confirmed mutex deadlocks and documented rollback flag. Token expiry bugfix session traced the wrong turn (queue suspicion) and landed on clock skew fix.",
              tokens: 2000,
              toolNames: ["session_lookup"],
            },
            {
              role: "user",
              summary:
                "User request: Call view_context, compress done topics with set_fidelity",
              tokens: 80,
            },
            {
              role: "assistant",
              summary:
                "Context map shows 4 topics. Compressed project_overview to placeholder (already captured in summary). Security review and test coverage kept at full — still actively relevant.",
              tokens: 800,
              toolNames: ["view_context", "set_fidelity"],
            },
            {
              role: "user",
              summary:
                "User request: Top 5 tech debt items by risk, and ONE thing to fix before production",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Top 5: (1) unsigned tokens — critical, (2) session store leak — moderate, (3) no config validation — moderate, (4) rate limit header spoofing — moderate, (5) shallow integration tests. #1 to fix before production: token signing. Without it, any client can impersonate any user.",
              tokens: 2800,
            },
          ],
        },
      ],
    },
    {
      sessionID: s.historical_investigation!,
      directory: dir,
      blobs: [
        {
          label: "session_discovery",
          summary:
            "Used session_lookup to discover 6 prior sessions: auth investigation, rate limiting, docs overhaul, token expiry bug, queue refactor, cross-cutting review. Built a map of what work was done.",
          placeholder: "Discovered 6 prior sessions via lookup",
          keyFacts: [
            "6 prior sessions cover auth, rate limiting, docs, bugfix, refactor, review",
            "Auth and bugfix sessions have the most critical decisions",
            "Queue was refactored from auth-specific to shared utility",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: I'm new. Use session_lookup to find all recorded sessions",
              tokens: 80,
            },
            {
              role: "assistant",
              summary:
                "Found 6 sessions via session_lookup. Auth queue investigation (13 msgs, 3 blobs), API rate limiting (6 blobs), Documentation overhaul, Token expiry bugfix (4 blobs), Queue refactor, Cross-cutting review.",
              tokens: 1600,
              toolNames: ["session_lookup"],
            },
            {
              role: "user",
              summary:
                "User request: Search for 'auth' and 'bug' sessions specifically",
              tokens: 80,
            },
            {
              role: "assistant",
              summary:
                "Auth sessions: 'Auth queue investigation' covers mutex→queue migration. Bug sessions: 'Token expiry clock skew bug' covers intermittent 401s. Both have rich context maps with key decisions documented.",
              tokens: 1200,
              toolNames: ["session_lookup"],
            },
          ],
        },
        {
          label: "auth_migration_history",
          summary:
            "Reconstructed full auth migration timeline from code comments and context maps: v1 mutex → deadlocks under concurrency → v2 async queue → refactored to shared utility. Rollback flag documented.",
          placeholder: "Auth migration: mutex→queue→shared timeline",
          keyFacts: [
            "v1: mutex per userID, deadlocked with 3+ concurrent refreshes",
            "v2: async queue, serializes per key, coalesces waiting requests",
            "v3: refactored to shared utils/queue.ts with generic interface",
            "Rollback flag in rate_limiter.ts: revert to mutex with 500ms timeout",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Read rate_limiter.ts history comments, explain full migration story",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Rate_limiter.ts comments document: v1 mutex held lock during async token issuing, caused deadlocks. v2 switched to queue. Rollback flag: revert to mutex with shorter timeout (500ms) and retry. Queue approach is stable.",
              tokens: 2000,
              toolNames: ["Read"],
            },
            {
              role: "user",
              summary:
                "User request: Read auth/queue.ts and utils/queue.ts — which is current, which is legacy?",
              tokens: 80,
            },
            {
              role: "assistant",
              summary:
                "utils/queue.ts is the current shared implementation with generics and pendingJobCount. auth/queue.ts is the legacy version that should be deleted (rate_limiter.ts was migrated to utils/queue in the refactor session).",
              tokens: 1400,
              toolNames: ["Read"],
            },
          ],
        },
        {
          label: "code_archaeology",
          summary:
            "Used blame_lookup on rate_limiter.ts:42. Docs are partially outdated: architecture.md was updated but onboarding still references old structure. Open questions about queue timeout and session cleanup scheduling.",
          placeholder: "Blame lookup and docs freshness check",
          keyFacts: [
            "blame_lookup on line 42 maps to auth queue investigation session",
            "architecture.md updated but onboarding still references old info",
            "Open: queue has no timeout, session cleanup has no scheduler",
          ],
          fidelity: "full",
          messages: [
            {
              role: "user",
              summary:
                "User request: Call view_context, blame_lookup on rate_limiter.ts:42, check docs freshness",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Context map shows 2 topics so far. blame_lookup on rate_limiter.ts:42 maps to auth queue investigation session — the enqueueRefresh call was added there. Docs: architecture.md was updated with queue migration, but onboarding.md still has stale info.",
              tokens: 1800,
              toolNames: ["view_context", "blame_lookup", "Read"],
            },
            {
              role: "user",
              summary:
                "User request: Write timeline of major changes, identify open questions and risks",
              tokens: 100,
            },
            {
              role: "assistant",
              summary:
                "Timeline: (1) initial build with mutex auth, (2) mutex→queue migration after deadlocks, (3) rate limiting implementation, (4) clock skew bugfix, (5) queue refactor to shared utility, (6) docs overhaul. Open questions: queue has no timeout (stuck job blocks forever), session cleanup needs a scheduler not just cleanup-on-refresh.",
              tokens: 3000,
            },
          ],
        },
      ],
    },
  ];
}

function buildContextMapFromSpec(spec: MapSpec, specIndex: number) {
  const now = Date.now();
  let msgCounter = 0;
  const map = {
    version: 1 as const,
    sessionID: spec.sessionID,
    directory: spec.directory,
    worktree: spec.directory,
    createdAt: now - 3_600_000,
    updatedAt: now,
    totalTokenEstimate: 0,
    lastAnnotatedMessageID: undefined as string | undefined,
    lastActiveBlobID: undefined as string | undefined,
    settings: {
      placeholderIncludesKeyFacts: true,
      placeholderIncludesKeyFactsSource: "system" as const,
      toolHistoryCleanup: true,
    },
    blobOrder: [] as string[],
    blobs: {} as Record<string, unknown>,
    messages: {} as Record<string, unknown>,
    pendingRetroactive: {},
  };

  for (const blobSpec of spec.blobs) {
    const blobID = blobSpec.label;
    const messageIDs: string[] = [];
    let blobTokens = 0;
    const blobCreatedAt = now - 3_600_000 + msgCounter * 60_000;

    for (const msg of blobSpec.messages) {
      msgCounter++;
      const msgID = `msg_s${specIndex}_${msgCounter}`;
      const createdAt = now - 3_600_000 + msgCounter * 60_000;
      messageIDs.push(msgID);
      blobTokens += msg.tokens;

      map.messages[msgID] = {
        id: msgID,
        role: msg.role,
        blobID,
        summary: msg.summary,
        keyFacts: msg.keyFacts ?? [],
        hidden: false,
        hiddenSource: "default",
        fidelityOverride: "inherit",
        fidelitySource: "default",
        tokenEstimate: msg.tokens,
        createdAt,
        updatedAt: createdAt,
        source: "annotation",
        partTypes:
          msg.role === "assistant"
            ? ["text", ...(msg.toolNames ?? []).map(() => "tool")]
            : ["text"],
        toolNames: msg.toolNames ?? [],
      };
      map.lastAnnotatedMessageID = msgID;
    }

    map.blobs[blobID] = {
      id: blobID,
      label: blobID,
      summary: blobSpec.summary,
      placeholder: blobSpec.placeholder,
      keyFacts: blobSpec.keyFacts,
      fidelity: blobSpec.fidelity,
      fidelitySource: "default",
      messageIDs,
      tokenEstimate: blobTokens,
      createdAt: blobCreatedAt,
      lastActiveAt: now - 3_600_000 + msgCounter * 60_000,
      commitHashes: [],
    };
    map.blobOrder.push(blobID);
    map.totalTokenEstimate += blobTokens;
    map.lastActiveBlobID = blobID;
  }

  return map;
}

// ── Demo repo structure ───────────────────────────────────────────────

async function createDemoRepo(projectRoot: string, repo: string) {
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Context Map Demo"], {
    cwd: repo,
  });
  await execFileAsync(
    "git",
    ["config", "user.email", "context-map-demo@example.com"],
    { cwd: repo },
  );

  // Plugin wiring (not tracked by git — setup-test-env recreates these)
  await fs.mkdir(path.join(repo, ".opencode", "plugins"), { recursive: true });
  await fs.writeFile(path.join(repo, ".gitignore"), ".opencode/\n");
  await fs.symlink(
    path.join(projectRoot, "src", "server-plugin.ts"),
    path.join(repo, ".opencode", "plugins", "context-map.ts"),
  );
  await fs.symlink(
    path.join(projectRoot, "src", "tui-plugin.tsx"),
    path.join(repo, ".opencode", "plugins", "context-map-tui.tsx"),
  );
  await fs.writeFile(
    path.join(repo, ".opencode", "tui.json"),
    `${JSON.stringify({ plugin: ["./plugins/context-map-tui.tsx"] }, null, 2)}\n`,
  );

  // Source directories
  for (const dir of [
    "src/auth",
    "src/api",
    "src/config",
    "src/middleware",
    "src/utils",
    "tests/auth",
    "tests/api",
    "tests/integration",
    "docs",
  ]) {
    await fs.mkdir(path.join(repo, dir), { recursive: true });
  }

  await writeInitialFiles(repo);
}

async function writeInitialFiles(repo: string) {
  const files: Record<string, string> = {
    "README.md": `# Demo API Service\n\nA small HTTP API service with auth, rate limiting, and user management.\n\n## Structure\n- \`src/auth/\` - Authentication and token management\n- \`src/api/\` - API endpoint handlers\n- \`src/config/\` - Configuration management\n- \`src/middleware/\` - Express middleware\n- \`src/utils/\` - Shared utilities\n- \`tests/\` - Test suites\n- \`docs/\` - Documentation\n`,
    "src/auth/rate_limiter.ts": renderRateLimiter(false),
    "src/auth/token_manager.ts": [
      'import { loadConfig } from "../config/settings"',
      "",
      "export interface TokenPayload { userID: string; email: string; roles: string[]; issuedAt: number; expiresAt: number }",
      "",
      "export async function issueToken(userID: string, email: string, roles: string[]): Promise<string> {",
      "  const config = loadConfig()",
      "  const payload: TokenPayload = { userID, email, roles, issuedAt: Date.now(), expiresAt: Date.now() + config.tokenTTLMs }",
      "  return Buffer.from(JSON.stringify(payload)).toString('base64')",
      "}",
      "",
      "export function decodeToken(token: string): TokenPayload | null {",
      "  try { const d = JSON.parse(Buffer.from(token, 'base64').toString('utf8')); return d.expiresAt < Date.now() ? null : d as TokenPayload } catch { return null }",
      "}",
      "",
      "export function isTokenExpired(p: TokenPayload): boolean { return p.expiresAt < Date.now() }",
      "export function tokenNeedsRefresh(p: TokenPayload, bufferMs = 60_000): boolean { return p.expiresAt - Date.now() < bufferMs }",
      "",
    ].join("\n"),
    "src/auth/session_store.ts": [
      "const sessions = new Map<string, { userID: string; token: string; createdAt: number }>()",
      "export function createSession(userID: string, token: string) { const id = `sess_${Date.now()}`; sessions.set(id, { userID, token, createdAt: Date.now() }); return id }",
      "export function getSession(id: string) { return sessions.get(id) ?? null }",
      "export function deleteSession(id: string) { sessions.delete(id) }",
      "export function listUserSessions(userID: string) { return [...sessions.entries()].filter(([,v]) => v.userID === userID).map(([k,v]) => ({ id: k, ...v })) }",
      "export function cleanExpiredSessions(maxAgeMs = 86_400_000) { const cutoff = Date.now() - maxAgeMs; for (const [id, s] of sessions) { if (s.createdAt < cutoff) sessions.delete(id) } }",
      "",
    ].join("\n"),
    "src/api/users.ts": [
      'import { issueToken } from "../auth/token_manager"',
      'import { createSession } from "../auth/session_store"',
      "type User = { id: string; email: string; name: string; roles: string[] }",
      "const users = new Map<string, User>()",
      "export async function registerUser(email: string, name: string) { const id = `user_${Date.now()}`; const user: User = { id, email, name, roles: ['user'] }; users.set(id, user); const token = await issueToken(id, email, user.roles); const sessionID = createSession(id, token); return { user, token, sessionID } }",
      "export async function loginUser(email: string) { const user = [...users.values()].find(u => u.email === email); if (!user) throw new Error('User not found'); const token = await issueToken(user.id, user.email, user.roles); const sessionID = createSession(user.id, token); return { user, token, sessionID } }",
      "export function getUser(id: string) { return users.get(id) ?? null }",
      "export function listUsers() { return [...users.values()] }",
      "",
    ].join("\n"),
    "src/api/endpoints.ts": [
      'import { refreshToken } from "../auth/rate_limiter"',
      'import { decodeToken } from "../auth/token_manager"',
      'import { getUser, listUsers, registerUser, loginUser } from "./users"',
      "",
      "export type ApiRequest = { method: string; path: string; headers: Record<string, string>; body?: unknown }",
      "export type ApiResponse = { status: number; body: unknown }",
      "",
      "export async function handleRequest(req: ApiRequest): Promise<ApiResponse> {",
      "  if (req.path === '/health') return { status: 200, body: { ok: true } }",
      "  if (req.path === '/register' && req.method === 'POST') { const { email, name } = req.body as any; return { status: 201, body: await registerUser(email, name) } }",
      "  if (req.path === '/login' && req.method === 'POST') { const { email } = req.body as any; return { status: 200, body: await loginUser(email) } }",
      "  const token = req.headers.authorization?.replace('Bearer ', ''); if (!token) return { status: 401, body: { error: 'Missing token' } }",
      "  const payload = decodeToken(token); if (!payload) return { status: 401, body: { error: 'Invalid or expired token' } }",
      "  if (req.path === '/me') return { status: 200, body: getUser(payload.userID) }",
      "  if (req.path === '/users' && payload.roles.includes('admin')) return { status: 200, body: listUsers() }",
      "  if (req.path === '/refresh' && req.method === 'POST') return { status: 200, body: await refreshToken(payload.userID) }",
      "  return { status: 404, body: { error: 'Not found' } }",
      "}",
      "",
    ].join("\n"),
    "src/config/settings.ts": [
      "export interface AppConfig { port: number; tokenTTLMs: number; refreshBufferMs: number; rateLimitPerMinute: number; maxSessionsPerUser: number; enableMetrics: boolean; logLevel: 'debug'|'info'|'warn'|'error' }",
      "const defaults: AppConfig = { port: 3000, tokenTTLMs: 3_600_000, refreshBufferMs: 60_000, rateLimitPerMinute: 60, maxSessionsPerUser: 5, enableMetrics: false, logLevel: 'info' }",
      "let config: AppConfig = { ...defaults }",
      "export function loadConfig(): AppConfig { return config }",
      "export function updateConfig(overrides: Partial<AppConfig>) { config = { ...config, ...overrides } }",
      "export function resetConfig() { config = { ...defaults } }",
      "",
    ].join("\n"),
    "src/middleware/auth_middleware.ts": [
      'import { decodeToken, tokenNeedsRefresh } from "../auth/token_manager"',
      'import { refreshToken } from "../auth/rate_limiter"',
      "export async function authMiddleware(headers: Record<string, string>) {",
      "  const token = headers.authorization?.replace('Bearer ', ''); if (!token) return { authenticated: false, error: 'No token' as const }",
      "  const payload = decodeToken(token); if (!payload) return { authenticated: false, error: 'Invalid token' as const }",
      "  if (tokenNeedsRefresh(payload)) { const refreshed = await refreshToken(payload.userID); return { authenticated: true, userID: payload.userID, refreshedToken: refreshed } }",
      "  return { authenticated: true, userID: payload.userID }",
      "}",
      "",
    ].join("\n"),
    "src/middleware/rate_limit_middleware.ts": [
      'import { loadConfig } from "../config/settings"',
      "const counters = new Map<string, { count: number; resetAt: number }>()",
      "export function rateLimitMiddleware(clientIP: string): { allowed: boolean; remaining: number } {",
      "  const config = loadConfig(); const now = Date.now(); const entry = counters.get(clientIP)",
      "  if (!entry || entry.resetAt < now) { counters.set(clientIP, { count: 1, resetAt: now + 60_000 }); return { allowed: true, remaining: config.rateLimitPerMinute - 1 } }",
      "  entry.count++; if (entry.count > config.rateLimitPerMinute) return { allowed: false, remaining: 0 }",
      "  return { allowed: true, remaining: config.rateLimitPerMinute - entry.count }",
      "}",
      "",
    ].join("\n"),
    "src/utils/queue.ts":
      "// TODO: extract shared async queue helper\nexport async function enqueueJob<T>(job: () => Promise<T>): Promise<T> { return await job() }\n",
    "tests/auth/token.test.ts":
      'import { issueToken, decodeToken } from "../../src/auth/token_manager"\ntest("issueToken creates valid token", async () => { const t = await issueToken("u1","t@t.com",["user"]); expect(typeof t).toBe("string") })\ntest("decodeToken returns payload", async () => { const t = await issueToken("u1","t@t.com",["user"]); expect(decodeToken(t)?.userID).toBe("u1") })\n',
    "tests/auth/rate_limiter.test.ts":
      'import { refreshToken } from "../../src/auth/rate_limiter"\ntest("refreshToken returns new token", async () => { const r = await refreshToken("u1"); expect(r).toBeDefined() })\n',
    "tests/auth/queue.test.ts":
      'test("queue serializes concurrent calls", async () => { expect(true).toBe(true) })\n',
    "tests/api/endpoints.test.ts":
      'import { handleRequest } from "../../src/api/endpoints"\ntest("health returns 200", async () => { const r = await handleRequest({ method: "GET", path: "/health", headers: {} }); expect(r.status).toBe(200) })\n',
    "tests/integration/auth_flow.test.ts":
      'import { handleRequest } from "../../src/api/endpoints"\ntest("full auth flow", async () => { const reg = await handleRequest({ method: "POST", path: "/register", headers: {}, body: { email: "t@t.com", name: "Test" } }); expect(reg.status).toBe(201) })\n',
    "docs/onboarding.md":
      "# Onboarding\n\nStart with repo setup and local development basics.\n\n## Prerequisites\n- Node.js 20+\n- TypeScript 5+\n\n## Getting Started\n1. Clone the repo\n2. Install dependencies\n3. Run the test suite\n",
    "docs/api-reference.md":
      "# API Reference\n\n## Endpoints\n\n### GET /health\nReturns service health.\n\n### POST /register\nRegister a new user. Body: `{ email, name }`\n\n### POST /login\nAuthenticate. Body: `{ email }`\n\n### GET /me\nGet current user. Requires auth.\n\n### POST /refresh\nRefresh auth token. Requires auth.\n\n### GET /users\nList users. Requires admin.\n",
    "docs/architecture.md":
      "# Architecture\n\n## Auth Flow\n1. User registers/logs in\n2. Server issues base64 token (JWT in prod)\n3. Client sends token in Authorization header\n4. Middleware validates and auto-refreshes\n\n## Rate Limiting\n- Per-IP in middleware\n- Token refresh uses async queue\n\n## Known Issues\n- Token refresh race condition fixed by queue\n- Session cleanup runs lazily\n",
  };

  for (const [filePath, content] of Object.entries(files)) {
    await fs.writeFile(path.join(repo, filePath), content);
  }
}

// ── Demo commits ──────────────────────────────────────────────────────

async function createDemoCommits(repo: string) {
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial demo repo"], {
    cwd: repo,
  });

  // Auth: mutex → queue
  await fs.writeFile(
    path.join(repo, "src", "auth", "rate_limiter.ts"),
    renderRateLimiter(true),
  );
  await fs.writeFile(
    path.join(repo, "src", "auth", "queue.ts"),
    "const pending = new Map<string, Promise<unknown>>()\nexport async function enqueueRefresh<T>(key: string, job: () => Promise<T>): Promise<T> {\n  const existing = pending.get(key); if (existing) { await existing; return job() }\n  const promise = job(); pending.set(key, promise)\n  try { return await promise } finally { pending.delete(key) }\n}\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync(
    "git",
    ["commit", "-m", "fix: switch auth refresh from mutex to async queue"],
    { cwd: repo },
  );
  const authCommit = await gitHead(repo);

  // API rate limiting
  const endpoints = await fs.readFile(
    path.join(repo, "src", "api", "endpoints.ts"),
    "utf8",
  );
  await fs.writeFile(
    path.join(repo, "src", "api", "endpoints.ts"),
    endpoints.replace(
      "if (req.path === '/health')",
      "// Rate limiting\nconst { rateLimitMiddleware } = await import('../middleware/rate_limit_middleware')\nconst rateCheck = rateLimitMiddleware(req.headers['x-forwarded-for'] ?? 'unknown')\nif (!rateCheck.allowed) return { status: 429, body: { error: 'Rate limited' } }\n\nif (req.path === '/health')",
    ),
  );
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync(
    "git",
    ["commit", "-m", "feat: add per-IP rate limiting"],
    { cwd: repo },
  );
  const apiCommit = await gitHead(repo);

  // Docs expansion
  await fs.writeFile(
    path.join(repo, "docs", "onboarding.md"),
    "# Onboarding\n\n## Quickstart\n1. Clone\n2. `npm install`\n3. `npm test`\n\n## Key Concepts\n- Auth tokens are base64 JSON (JWT in prod)\n- Refresh uses async queue to avoid races\n- Rate limiting is per-IP\n\n## Auth Rollback\nSee `src/auth/queue.ts` and the rollback flag in `rate_limiter.ts`.\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "docs: expand onboarding"], {
    cwd: repo,
  });
  const docsCommit = await gitHead(repo);

  // Bugfix: clock skew
  const tm = await fs.readFile(
    path.join(repo, "src", "auth", "token_manager.ts"),
    "utf8",
  );
  await fs.writeFile(
    path.join(repo, "src", "auth", "token_manager.ts"),
    tm.replace(
      "export function isTokenExpired(p: TokenPayload): boolean { return p.expiresAt < Date.now() }",
      "export function isTokenExpired(p: TokenPayload): boolean {\n  // Fix: handle clock skew with 5-second grace period\n  return p.expiresAt < Date.now() - 5000\n}",
    ),
  );
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync(
    "git",
    ["commit", "-m", "fix: clock skew grace period for token expiry"],
    { cwd: repo },
  );
  const bugfixCommit = await gitHead(repo);

  // Refactor: shared queue
  await fs.writeFile(
    path.join(repo, "src", "utils", "queue.ts"),
    "const pending = new Map<string, Promise<unknown>>()\nexport async function enqueueJob<T>(key: string, job: () => Promise<T>): Promise<T> {\n  const existing = pending.get(key); if (existing) { await existing; return job() }\n  const promise = job(); pending.set(key, promise)\n  try { return await promise } finally { pending.delete(key) }\n}\nexport function pendingJobCount(): number { return pending.size }\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync(
    "git",
    ["commit", "-m", "refactor: shared queue utility"],
    { cwd: repo },
  );
  const refactorCommit = await gitHead(repo);

  return { authCommit, apiCommit, docsCommit, bugfixCommit, refactorCommit };
}

// ── File content ──────────────────────────────────────────────────────

function renderRateLimiter(useQueue: boolean) {
  return (
    [
      useQueue
        ? 'import { enqueueRefresh } from "./queue"'
        : '// import { enqueueRefresh } from "./queue"',
      "",
      "export async function refreshToken(userID: string) {",
      "  const current = await loadCurrentToken(userID)",
      "  if (!current.needsRefresh) return current",
      "",
      "  // Rate limiter for token refresh",
      "  // History: v1 mutex caused deadlocks with 3+ concurrent refreshes",
      "  // v2: switched to async queue — serializes per userID without blocking",
      "  // Rollback flag: revert to mutex with 500ms timeout if queue issues arise",
      ...Array.from({ length: 20 }, (_, i) => `  // filler ${i + 20}`),
      useQueue
        ? "  return await enqueueRefresh(userID, async () => await issueNewToken(userID))"
        : "  return await withMutex(userID, async () => await issueNewToken(userID))",
      "}",
      "",
      "async function loadCurrentToken(userID: string) { return { userID, needsRefresh: true } }",
      "async function issueNewToken(userID: string) { return { userID, needsRefresh: false } }",
      "async function withMutex(userID: string, job: () => Promise<unknown>) { return await job() }",
    ].join("\n") + "\n"
  );
}

// ── Server utilities ──────────────────────────────────────────────────

function shellQuote(v: string) {
  return JSON.stringify(v);
}

async function gitHead(repo: string) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
  });
  return stdout.trim();
}

async function startServer(env: NodeJS.ProcessEnv, cwd: string) {
  const proc = spawn(
    "opencode",
    ["serve", "--hostname=127.0.0.1", "--port=0"],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  proc.stderr.on("data", (c) => {
    stderr += c.toString();
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Server timeout\n${stderr}`)),
      20_000,
    );
    proc.stdout.on("data", (c) => {
      const m = c
        .toString()
        .match(/opencode server listening on (http:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timeout);
        resolve(m[1]!);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited ${code}\n${stderr}`));
    });
    proc.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });

  return {
    url,
    async close() {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
    },
  };
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
