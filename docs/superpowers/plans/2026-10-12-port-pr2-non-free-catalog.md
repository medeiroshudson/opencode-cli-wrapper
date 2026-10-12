# Port PR #2 onto `serve`: non-free catalog coverage + dead-plumbing removal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the still-valuable parts of upstream PR #2 on `main`: regression tests proving non-free models work with only the wrapper Bearer key, plus removal of the now-unreachable free-tier filter machinery.

**Architecture:** No behavior change. `main` already serves the full catalog (routes hardcode an always-enabled auth context) and `x-opencode-key` no longer exists anywhere. PR #2's original bug is therefore already fixed by another route; what it still contributes is (a) test coverage that a *non-free* model resolves and runs, and (b) deletion of the dead `AuthContext` / `visibleModels` abstraction that only encoded the obsolete free-only promise.

**Tech Stack:** TypeScript (ESM, `NodeNext` — imports carry `.js` specifiers), Fastify 5, Vitest 5, Node >= 22.

**Spec / source:** https://github.com/medeiroshudson/opencode-wrapper/pull/2 (author: mausch). This plan is the re-target of that PR onto the current `serve`-based `main`; the PR's own diff is stale (it still edits `extractAuth` and `visibleModels` call sites that no longer match the current main, and conflicts in 5 files).

## Global Constraints

- ESM + `NodeNext`: any import you add keeps the `.js` extension (`../lib/… .js`).
- Top-level suite is the source of truth: run `npx vitest run tests/*.test.ts` and `npm run typecheck`. (Plain `npx vitest run` also loads `spikes/**`, whose tests fail in this sandbox with `ENOENT: mkdir '/evidence'` — unrelated, ignore.)
- `npm run typecheck` covers `src/` **only** — `tsconfig.json` sets `rootDir: "src"` and `exclude: [..., "tests"]`. Vitest runs through esbuild, which strips types without typechecking. So test-file type/arity mistakes are caught by *running* the tests, not by the typechecker.
- Commit style: conventional, imperative, lowercase scope (`test(routes): …`, `refactor(config): …`).
- No behavior change is intended in either task. If a source edit makes a currently-passing test fail, that is a bug in the edit, not a spec change.
- Do not touch `README.md` in this plan. The PR's README paragraph mentions `x-opencode-key` (a header that no longer exists) and conflicts; README wording is handled separately.

## Review Focus

The five input classes / failure modes most likely to bite a user of this code, each with the test that pins it (in the task noted):

1. **A non-free model id (short and canonical) must resolve and run** — the whole point of PR #2. Test: Task 1 (`tests/auth-routes.test.ts`), plus a unit test in Task 2 (`tests/config.test.ts`).
2. **A short id duplicated across `opencode` and `opencode-go` must still prefer ZEN** after the plumbing removal. Test: the "ZEN model preference" block kept in Task 2.
3. **A pathological catalog entry with an empty id** (`id: ""`) must still be listed and resolvable without throwing. Test: the existing `id: ""` expectations kept in Task 2 and Task 1.
4. **A model absent from the catalog must yield 404, not 500.** Test: "rejects a model absent from the catalog with 404" in `tests/routes.test.ts` (kept, exercised by Task 1's suite run).
5. **Route error mappings must survive the signature change** (catalog failure → 500). Test: "GET /v1/models maps catalog failure to an [OI] 500 error" (kept, exercised by Task 2's suite run).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `tests/auth-routes.test.ts` | Route-level chat turns through the serve client, incl. auth | Add a non-free entry to the fixture; add a non-free chat test |
| `tests/routes.test.ts` | Route surface: models list, 404s, error mapping | Add a non-free listing test |
| `tests/config.test.ts` | Unit tests for `listModels` / `resolveModel` / env helpers | Update calls to new signatures; add a non-free unit test |
| `src/config/index.ts` | Catalog listing/resolution helpers | Delete `visibleModels`; drop the `auth` param from `listModels` / `resolveModel` |
| `src/routes/models.ts` | `GET /v1/models`, `GET /models.dev.json` | Drop `AuthContext` import + `CATALOG_AUTH`; call `listModels(entries)` |
| `src/routes/chat.ts` | `POST /v1/chat/completions` | Drop the inline `auth` object; call `resolveModel(body.model, entries)` |
| `src/lib/opencode/auth.ts` | **Delete** — defined only the now-unused `AuthContext` interface | Removed |

Task 1 is test-only and must land first: it pins the behavior *before* Task 2 removes the machinery that encodes the old rule, so the refactor is provably safe. Task 2 depends on Task 1 only in ordering, not in interfaces.

---

### Task 1: Regression coverage for non-free models

**Files:**
- Modify: `tests/auth-routes.test.ts:37-39` (fixture), append a test inside the `describe` (after line 127)
- Modify: `tests/routes.test.ts` (append a test inside the `describe`, after line 145)

**Interfaces:**
- Consumes: `buildServer` (`src/server.js`), `postMessageMock` / `getCatalogMock` (already hoisted mocks in each file).
- Produces: nothing other tasks import — this task only adds tests.

- [ ] **Step 1: Add the non-free fixture entry in `tests/auth-routes.test.ts`**

Replace the `catalog` constant (currently lines 37-39) with:

```ts
const catalog = [
  { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free", limits: null },
  { canonical: "openai/gpt-6-luna", provider: "openai", id: "gpt-6-luna", limits: null },
];
```

- [ ] **Step 2: Write the failing-to-be-meaningful test in `tests/auth-routes.test.ts`**

Append inside `describe("Global route authentication", …)`, right after the existing "routes the chat turn through the serve client…" test (after line 127):

```ts
  it.each(["gpt-6-luna", "openai/gpt-6-luna"])(
    "runs the non-free model %s through the serve client with only the wrapper Bearer key",
    async (model) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authorization,
        payload: { ...chatPayload, model },
      });

      expect(response.statusCode).toBe(200);
      // A non-free model resolves to its canonical provider/id and runs on the
      // server's existing OpenCode credentials: there is no per-request key header.
      expect(postMessageMock).toHaveBeenCalledWith("ses_test", {
        model: { providerID: "openai", modelID: "gpt-6-luna" },
        parts: [{ type: "text", text: expect.any(String) }],
      });
    },
  );
```

- [ ] **Step 3: Add the non-free listing test in `tests/routes.test.ts`**

Append inside `describe("Routes (P6/P7)", …)`, right after "GET /v1/models returns the full catalog" (after line 145):

```ts
  it("GET /v1/models lists a non-free model without an extra header", async () => {
    getCatalogMock.mockResolvedValueOnce([
      { canonical: "openai/gpt-6-luna", provider: "openai", id: "gpt-6-luna", limits: null },
    ]);

    const res = await app.inject({ method: "GET", url: "/v1/models", headers: inboundHeaders });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([{ id: "gpt-6-luna", object: "model", owned_by: "openai" }]);
  });
```

- [ ] **Step 4: Run the two files and confirm they pass**

Run:

```bash
npx vitest run tests/auth-routes.test.ts tests/routes.test.ts
```

Expected: PASS. These tests characterize behavior that already exists on `main`, so they must pass immediately — a *green* run is the expected result here, not the usual red-then-green. The next step proves they are not vacuous.

- [ ] **Step 5: Prove the tests actually guard the behavior (mutation check, then revert)**

Temporarily reintroduce the free-only rule and confirm both new tests fail.

In `src/routes/models.ts`, change line 10 from `{ enabled: true, token: null }` to `{ enabled: false, token: null }`.
In `src/routes/chat.ts`, change line 87 from `{ enabled: true, token: null }` to `{ enabled: false, token: null }`.

Run:

```bash
npx vitest run tests/auth-routes.test.ts tests/routes.test.ts
```

Expected: FAIL — the non-free chat test gets a 404 (model filtered out of the visible catalog) and the non-free listing test omits `gpt-6-luna`.

**Revert both edits** (both lines back to `enabled: true`), then re-run the same command and confirm PASS again.

- [ ] **Step 6: Commit**

```bash
git add tests/auth-routes.test.ts tests/routes.test.ts
git commit -m "test(routes): cover non-free models without a per-request key"
```

---

### Task 2: Remove the unreachable free-tier plumbing

**Files:**
- Modify: `src/config/index.ts` (delete import line 1; delete `visibleModels` lines 152-157; change `listModels` line 159-161 and body line 176; change `resolveModel` lines 227-237)
- Modify: `src/routes/models.ts` (delete import line 3 and const lines 8-10; change call line 18)
- Modify: `src/routes/chat.ts` (delete comment + const lines 85-87; change call line 111)
- Delete: `src/lib/opencode/auth.ts`
- Modify: `tests/config.test.ts` (imports lines 2/17; delete `noAuth`/`withAuth` lines 26-27; delete `visibleModels` tests lines 30-36; update calls; add a non-free unit test)

**Interfaces:**
- Consumes: `CatalogEntry` (`src/lib/opencode/models.js`), `preferZen` / `dedupeById` (module-private in `src/config/index.ts`).
- Produces: `listModels(entries: CatalogEntry[])`, `resolveModel(id: string, entries: CatalogEntry[]): string` — the `auth: AuthContext` parameter is gone from both. `AuthContext` no longer exists.

- [ ] **Step 1: Update the unit tests to the target signatures (failing test first)**

In `tests/config.test.ts`:

Delete the `AuthContext` import (line 2) and `visibleModels` from the import list (line 17). Delete the two constants (lines 26-27):

```ts
const noAuth: AuthContext = { enabled: false, token: null };
const withAuth: AuthContext = { enabled: true, token: "key" };
```

Delete the two `visibleModels` tests (lines 30-36):

```ts
  it("shows only free ids without auth", () => { … });
  it("shows every catalog entry with auth", () => { … });
```

Update every remaining call to drop the `auth` argument, and rename the two titles that say "visible":

- `listModels(withAuth, entries)` → `listModels(entries)`
- `resolveModel("mimo-v2.6-flash-free", noAuth, entries)` → `resolveModel("mimo-v2.6-flash-free", entries)`
- `resolveModel("opencode/mimo-v2.6-flash-free", noAuth, entries)` → `resolveModel("opencode/mimo-v2.6-flash-free", entries)`
- `resolveModel("gpt-4", withAuth, entries)` → `resolveModel("gpt-4", entries)`
- `resolveModel("mimo-v2.6-flash-free", withAuth, [])` → `resolveModel("mimo-v2.6-flash-free", [])`
- `it("resolves a visible short id to its canonical id", …)` → `it("resolves a short id to its canonical id", …)`
- `it("rejects a model outside the visible catalog", …)` → `it("rejects a model outside the catalog", …)`
- In `describe("ZEN model preference", …)`: `resolveModel("space-bunny-free", noAuth, dual)` → `resolveModel("space-bunny-free", dual)`; `resolveModel("opencode-go/space-bunny-free", noAuth, dual)` → `resolveModel("opencode-go/space-bunny-free", dual)`; `listModels(noAuth, dual)` → `listModels(dual)`.

Add a focused non-free test inside `describe("config module", …)`, after the "rejects every id when the catalog is empty" test:

```ts
  it("resolves a non-free model id without a credential", () => {
    const catalog: CatalogEntry[] = [
      { canonical: "openai/gpt-6-luna", provider: "openai", id: "gpt-6-luna", limits: null },
    ];
    expect(resolveModel("gpt-6-luna", catalog)).toBe("openai/gpt-6-luna");
    expect(resolveModel("openai/gpt-6-luna", catalog)).toBe("openai/gpt-6-luna");
  });
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run:

```bash
npx vitest run tests/config.test.ts
```

Expected: FAIL with a **runtime** error, not a type error — vitest/esbuild does not typecheck. The 2-arg calls reach the still-3-arg `resolveModel(id, auth, entries)`, so the array lands in `auth` and `entries` is `undefined`; the body then throws `TypeError: Cannot read properties of undefined (reading 'filter')`. Same for `listModels(entries)`. The suite must not be green yet. (`npm run typecheck` stays clean here because it does not read `tests/`.)

- [ ] **Step 3: Change `src/config/index.ts`**

Delete the `AuthContext` import (line 1). The file now opens with:

```ts
import type { CatalogEntry } from "../lib/opencode/models.js";
```

Delete the `visibleModels` function and its comment (lines 152-157).

Change `listModels` — signature and body:

```ts
export function listModels(
  entries: CatalogEntry[],
): {
```

and, in the returned object:

```ts
    data: dedupeById(entries).map((entry) => {
```

Change `resolveModel` to:

```ts
export function resolveModel(id: string, entries: CatalogEntry[]): string {
  const exact = entries.find((entry) => entry.canonical === id);
  if (exact) return exact.canonical;

  const matches = entries.filter((entry) => entry.id === id);
  if (matches.length > 0) return matches.reduce(preferZen).canonical;

  throw new ModelNotFoundError(`Model '${id}' not found in the model catalog.`);
}
```

- [ ] **Step 4: Change the two route call sites**

`src/routes/models.ts`: delete the `AuthContext` import (line 3) and the comment plus `CATALOG_AUTH` (lines 8-10). Change the call (line 18) to:

```ts
      reply.status(200).send(listModels(entries));
```

`src/routes/chat.ts`: delete the comment and inline auth object (lines 85-87). Change the call (line 111) to:

```ts
        canonicalModel = resolveModel(body.model, entries);
```

- [ ] **Step 5: Delete the now-dead type module**

```bash
git rm src/lib/opencode/auth.ts
```

(It exported only `AuthContext`, and every import of it was `import type`; nothing imports it now.)

- [ ] **Step 6: Run typecheck and the unit tests to verify they pass**

Run:

```bash
npm run typecheck && npx vitest run tests/config.test.ts
```

Expected: typecheck clean for `src/` (no dangling `AuthContext` import there — note it cannot see `tests/`); all `tests/config.test.ts` tests PASS, including the new non-free test and the ZEN preference tests.

- [ ] **Step 7: Run the full top-level suite**

Run:

```bash
npx vitest run tests/*.test.ts
```

Expected: PASS — all files green (the count rises by the tests added in Task 1 and this task; integration tests remain skipped unless `INTEGRATION=1`).

- [ ] **Step 8: Commit**

```bash
git add src/config/index.ts src/routes/models.ts src/routes/chat.ts tests/config.test.ts
git commit -m "refactor(config): drop the unreachable free-tier filter"
```

(The `git rm` from Step 5 is already staged; `git add` the rest.)

---

## Self-Review

**Spec coverage.** PR #2's three components, against this plan:
- *Remove the free-only filter so existing logins work* → already true on `main`; this plan locks it with tests (Task 1) and deletes the dead machinery that could reintroduce it (Task 2).
- *Tests for non-free resolution* → Task 1 (route level) + Task 2 (unit level).
- *README paragraph* → intentionally excluded (see Global Constraints); it references `x-opencode-key`, which does not exist.
- *Removed `visibleModels`* → Task 2, Step 3.

**Placeholder scan.** No "TODO"/"handle edge cases"/"similar to Task N"; every code step shows the exact final text; every run step shows the exact command and expected result.

**Type consistency.** `listModels(entries)` and `resolveModel(id, entries)` are used with identical arity in Task 2 Steps 1, 3, and 4 (tests, definition, call sites). `AuthContext` is referenced only in the "delete" instructions.

**Review Focus coverage.** (1) Task 1 Step 2 + Task 2 Step 1; (2) Task 2 Steps 1/6 (ZEN block); (3) Task 2 Step 7 (existing `id: ""` expectations unchanged); (4) Task 1 Step 4/5 suite run; (5) Task 2 Steps 6/7.

**Deliberately out of scope.** README wording; the `opencode-cli-wrapper` → `opencode-wrapper` rename sweep (badges, GHCR, README title); validating the Nix flake from PR #1.
