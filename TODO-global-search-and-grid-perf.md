# TODO — Global Search & Grid Performance

Consolidated from the 2026-07-31 investigation (Cloudflare data-API connectivity test →
global-search performance analysis). Backing detail:
`query-logs/REPORT-global-search-performance.md` and memory `project_global_search_join`.

Environments referenced:
- **prod** = www.bv-brc.org (3.58.4, production data API) — does NOT have the genome-join code
- **alpha** = alpha.bv-brc.org (3.59.1, production-like API) — newer code, WITHOUT distributed-query changes
- **test** = localhost:3000 (3.59.1, same API as alpha) — newer code, WITH distributed-query changes

---

## ✅ Done (branch `feature/global-search-incremental`, off `alpha`)

- [x] **Incremental global-search rendering** (`4b925a2f9`)
  `public/js/p3/widget/AdvancedSearch.js`. Replaced the single batched `query/` POST (awaited all
  15 categories → page blocked ~16–20s on the slowest) with 15 independent per-category requests.
  Skeleton with spinners paints immediately; each cell + Top Matches block fills as its own
  response arrives. Fastest-first issue order (`resultFetchOrder`), slow join categories
  (genome_feature, sp_gene) last. Per-search token discards superseded responses; failed
  categories show `—`. Verified against test API: fast cells ~3s, join cells ~13s, no console errors.

- [x] **Fixed-width count-grid columns** (`6ee3326fc`)
  `table-layout:fixed; width:100%` + `33.33%` cells + ellipsis, so columns don't reflow as
  results arrive. Verified: column left/width identical loading vs loaded.

---

## 🔧 Client-side, outstanding (this repo)

- [ ] **Drop the genome-join on the global-search COUNT fan-out**
  `public/js/p3/util/buildGlobalSearchQuery.js`. The `genome(and(gt(completion_date,NOW-1YEARS),
  ne(genome_status,Deprecated)))` crossCollection join was added (PR #1330) to speed up large-taxa
  *grid reads*, but Top Matches only needs `numFound`. On the count fan-out the join is net-negative:
  genome_feature ~16.8s / sp_gene ~20.5s (test) vs 2.3s / 7.4s bare (prod). Issue bare counts for
  Top Matches; keep the join for the actual scoped list/grid views where it pays off.
  → Complements the incremental rendering above: incremental hides the perceived stall; this removes
  the actual cost.

- [ ] **Fix the dead-code join-key shadowing for protein_feature / protein_structure**
  `buildGlobalSearchQuery.js`. Both targets are in BOTH `genomeScopeOnlyTargets` and
  `wrappedPropByTarget`. The `genomeScopeOnlyTargets` branch is checked first and returns, so the
  intended typed join (`to(protein_feature_id)` / `to(protein_structure_id)` via
  `wrapGenomeScopedQuery`) is unreachable — those cores get a generic `genome_id` join instead.
  Decide correct join key WITH the data-API session (changes emitted Solr), then either remove them
  from `genomeScopeOnlyTargets` or reorder the dispatch.

- [ ] **Suppress the unfiltered construction-time grid query (GridContainer double-fetch)**
  `public/js/p3/widget/GridContainer.js` `startup()` (~2161). On genome-view tab load the grid
  queries twice: once at construction with NO genome filter (an UNFILTERED query over the whole
  collection — captured `protein_structure` returning `0-200/32,167,507`), then again with
  `eq(genome_id,…)` once state applies. The browser `net::ERR_ABORTED` on the first is cosmetic —
  it does NOT shed backend work (see server item below). Fix: don't issue the grid query until the
  state-derived query is set (construct with no query / guard `onFirstView` when state is pending).
  Likely affects all grid tabs; cost scales with collection size.

- [ ] **Fix broken `.eslintrc.json`** (pre-existing, unrelated but blocks `npm test`)
  Invalid rule entry `_comment_reactivate_later` has a severity of `"block-scoped-var"` instead of
  0/1/2, so ESLint fails config validation for every file. One-line fix (remove/repair the key).

---

## 🗄️ Backend / data-API session (separate Claude context)

- [ ] **protein_feature distributed-query regression**
  Identical Solr query (byte-for-byte params) is **29ms on alpha vs 15,675ms on test**, both
  returning 0. Regression is entirely in the distributed-query backend path, not the query.
  Runnable queries + bisection cases + questions are in
  `query-logs/REPORT-global-search-performance.md` (section "🔴 protein_feature regression").
  Key question: why does protein_feature regress 540× while the structurally identical
  protein_structure join *improves* 870× (9.6s→11ms) on the same stack?

- [ ] **genome_feature (16.8s) / sp_gene (20.5s) join cost**
  Distributed-query changes barely help these (vs the 28–870× wins on pathway/subsystem/
  protein_structure). Determine whether the crossCollection join can be pushed down / cached for
  these cores the way it is for the others. (Client-side mitigation above may make this moot for
  Top Matches, but the join still matters for scoped grid views.)

- [ ] **(Defense-in-depth) Make client abort shed backend work**
  data_api `querySOLR` (paginated path) has no `res.on('close')` / `req.aborted` handling, so a
  browser abort never destroys the upstream Solr socket and Solr has no `timeAllowed` /
  task-cancellation — aborted queries run to completion. Adding `res.on('close')` → destroy Solr
  socket, plus Solr `timeAllowed`, would cap wasted work. Note: the client GridContainer fix above
  is the real remedy; this only limits damage.

---

## Notes / non-issues (ruled out during investigation)

- Cloudflare is NOT implicated anywhere: all envs returned via CF (`server: cloudflare`, `cf-ray`),
  all HTTP 200 / Solr status:0. All slow times are Solr `QTime` (server compute), not edge latency.
- Empty categories (strain/serology/surveillance, sometimes protein_structure) are near-instant
  zeros → unpopulated cores in that dataset, not bugs.
- The genome-join code is on alpha + feature branches only, NOT on `main` — so prod is unaffected
  by the count-fan-out slowdown today; it ships when the alpha line is released.
