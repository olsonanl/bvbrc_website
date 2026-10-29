# Plan: 429/503 coverage for the download path

**Status:** proposal, 2026-10-29. Branch `feature/download-429-coverage`.
**Depends on:** PR #1475 (merged) — `util/retryRequest.js`, `util/throttledRequest.js`,
`widget/ThrottleBanner.js`, and the `enableThrottleRetry` flag are all on alpha.

This is §4 of `PLAN-http-429-throttle-handling.md`, the one gap left after #1465/#1467/#1475.
It is written against measurements taken on alpha, and the measurements changed the shape
of the plan — see "What the server actually does" before reading the proposals.

---

## What the server actually does

**Revised 2026-10-29 (second pass).** The first pass measured a broad download running
past 120 s and built the plan around that. That measurement was already stale when I took
it: BV-BRC-API **#245** (batched join streaming) and **#255** (the distributed path that
was discarding the batched stream) had landed, and alpha now completes those downloads.
Re-measured below. Anything in this document that reads as "the download hangs" is
superseded.

Sources: `Docs/CLIENT-join-too-broad.md`, `Docs/CLIENT-429.md`, and
`Docs/RELEASE_NOTES_DRAFT.md` in BV-BRC-API.

### Downloads are classified heavy, so 429 is real

`middleware/QueryClassifier.js:87` — `req.isDownload` is heavy by construction, before any
`rows` inspection, because *"a download fans out to ~370 secondary lookups per genome"*.

**Admission control is now ENABLED on alpha**, which the first pass listed as an open
question. Measured via `scripts/verify-protections.js`:

```
PASS  admission pools reported at /stats
      heavy 3 slots / 6 queue, interactive 20/20
PASS  enforcement active — queryAdmission.enabled is true
```

Three heavy slots, six queued. A handful of concurrent broad downloads will exhaust that,
and each one now takes *minutes* rather than failing fast — so 429s on the download path
are reachable today, not hypothetical. This makes Items 1 and 3 live work rather than
preparation.

### Broad downloads now COMPLETE — they do not hang

The exemption at `JoinResolution.js:100,119` is real, but the consequence has changed.
#245 added `BatchedJoinStream`, which resolves an over-broad join in bounded slices
instead of refusing it; #255 fixed the distributed path discarding that stream. Measured
on alpha 2026-10-29, Viruses / `genome_sequence`:

| request | result |
|---|---|
| grid-style count query | **400** `join_too_broad` in 1.2 s |
| download, `limit(200)` | **200**, 42 KB, 3.6 s |
| download, `limit(10000)` | **200**, 2.48 MB, **12 s** |

The release notes record the before/after for that last one: **HTTP 524 after 125 s →
HTTP 200 in ~5 s**, and a full 2,500,000-record protein FASTA of taxon 10239 completing
through Chrome and Cloudflare.

So the asymmetry is deliberate and *working*: a page fails fast, a download succeeds
slowly. A client must not read the page's 400 as a prediction about the download. (The
first implementation of Item 4 did exactly that and had to be reverted — see the commit
history.)

### Not every broad taxon is refused any more

`joinResolution.taxonomicRewrite` resolves some large taxa without the join. Measured:

```
taxon 10239 (Viruses)   -> 400 join_too_broad   0.13 s
taxon 1239  (Bacillota) -> 200                  6.0 s
taxon 2     (Bacteria)  -> 400 join_too_broad   0.45 s
```

`verify-protections.js` currently *fails* its own "broad taxon 1239 refused promptly"
check for this reason. The contract's instruction stands: **handle a 400 on any taxon and
let the server decide which** — never hardcode the list.

### What this changes

The original §4 framing — "downloads are unretryable, convert them to XHR+Blob" — solved
the wrong problem, and the "warn the user it will hang" framing of the first revision
solved a problem that no longer exists. What is actually left is narrower and more
ordinary: make the download path honour the 429 contract like everything else, and tell
the user that a long download is progressing rather than stuck.

---

## Item 1 — `DownloadExecutor` bypasses the throttle provider

**Effort: small. Risk: low. Do this first.**

`util/DownloadExecutor.js:6` imports `dojo/request/xhr` directly. Per the provider
mechanism documented in `CLAUDE.md`, that opts out of `throttledRequest` entirely, so none
of its four XHR sites get 429 handling:

| line | call | what it is |
|---|---|---|
| 317 | `xhr.post(sourceUrl, …)` | cross-collection prefetch, 120 s timeout |
| 410 | `xhr.post(DATA_API_URL + …)` | `executeClientSideDownload`, 300 s timeout |
| 508 | `xhr.post(BUNDLER_API_URL + …)` | `executeBundleDownload`, 60 s timeout |
| 614 | `xhr.post(DATA_API_URL + …)` | `executeChunkedDownload` per chunk, 120 s |

(Line numbers as of this revision; they move. `grep -n 'xhr.post' public/js/p3/util/DownloadExecutor.js`.)

`widget/download/RecordSelectorStep.js` has the same direct import.

### Proposed change

Switch both files from `dojo/request/xhr` to `dojo/request`. That is the whole fix for
three of the four sites — the provider matches on data-API URLs and wraps them.

Two caveats that are not optional:

- **The timeouts interact with retry.** A 300 s timeout wrapping 3 retries at up to ~10 s
  backoff each is fine, but `retryRequest` does not currently subtract elapsed time from
  the caller's timeout. Worth confirming a shed-then-retried download still has budget left
  rather than failing on a timeout that was consumed by waiting. This matters much more in
  `unattended` mode (Item 3), where a single backoff can reach 300 s.
- **Line 477's `BUNDLER_API_URL` is broken independently of 429 work.** See Item 1a.

### Item 1a — the bundler URL is computed wrong (latent bug, found while checking the matcher)

```javascript
var BUNDLER_API_URL = window.App && window.App.dataServiceURL
  ? window.App.dataServiceURL.replace('/data', '/bundle')
  : '/api/bundle';
```

The `.replace('/data', '/bundle')` only fires if the configured URL contains the literal
`/data`. It does not in any real deployment:

| configured `dataServiceURL` | result |
|---|---|
| `https://alpha.bv-brc.org/api` | unchanged — **no-op** |
| `/alpha/api` | unchanged — **no-op** |
| `https://www.bv-brc.org/api` | unchanged — **no-op** |
| `/api/data` (the hardcoded fallback's shape) | `/api/bundle` ✓ |

So `executeBundleDownload` POSTs its JSON bundle request to `<apiRoot>/genome/` — the
ordinary data-type route — instead of `<apiRoot>/bundle/genome/`. Verified against alpha:

```
POST /api/genome/        {"genome_ids":…,"types":…}  -> hangs, no response at 60 s
POST /api/bundle/genome/ {"genome_ids":…,"types":…}  -> 400 "Missing Bundled Types"
```

The 400 is the *correct* endpoint rejecting a deliberately-wrong body shape
(`routes/download.js:168` wants `bundleTypes`); the hang is the wrong endpoint trying to
parse a bundle request as an RQL query.

**It is latent, not live.** `execute()` reaches `executeBundleDownload` only when
`format.category === 'package'` or `spec.bundleConfig` is set, and `DownloadFormats.js`
defines no `package` category at all — only `accession` (6), `sequence` (7) and `table` (3).
No format is type `'bundle'`, so `GenomeBundleConfiguratorStep` never runs and
`bundleConfig` is never populated. The path is unreachable today.

Fix it anyway, before anyone enables a bundle format and hits a 60 s hang with no error.
The matcher question that prompted this resolves itself: once the URL is right, it is still
under `dataServiceURL`, so `isDataApi()` matches and the provider wraps it. Whether a
*job-submission* call should be retried is a separate judgement — probably not, since a
resubmitted job is worse than a failed one. If so it needs an explicit opt-out rather than
relying on an accident of URL shape.

### Verification

Inject 429s for `/alpha/api/` as in the #1465 work, run a client-side-forced download, and
confirm the retry fires and the banner shows. The banner already subscribes to the right
topics, so no UI work is needed here.

---

## Item 2 — `executeServerSideDownload` is unreachable by any wrapper

**Effort: medium. Risk: medium. This is the real decision.**

`DownloadExecutor.js:270` builds a hidden form and calls `form.submit()`. The response goes
to the browser, not to JS, so no amount of client code can see its status, retry it, or
report it. The user gets a browser-rendered error page or a failed download.

### It is the default for everything

`execute()` at line 807:

```javascript
var preferServerSide = format.serverSide !== false;
…
if (options.forceServerSide || preferServerSide) {
  return executeServerSideDownload(spec);
}
```

**All 16 formats in `DownloadFormats.js` set `serverSide: true`; none set `false`.** So
`executeClientSideDownload` and `executeChunkedDownload` are reachable only via an explicit
`options.forceClientSide`, which nothing passes. The retryable paths exist and are
effectively dead code.

### Why "just switch the formats to client-side" is wrong

Measured: `genome_feature` CSV is **~289 bytes/row**. The widgets request `limit(2500000)`.

| rows | Blob size |
|---|---|
| 25,000 | 7 MB |
| 100,000 | 29 MB |
| 500,000 | 144 MB |
| **2,500,000** | **~722 MB** |

Buffering that to gain retry would trade a rare failure for a reliable tab crash. It also
loses the browser's native download UI — progress, cancel, resume, and the ability to
navigate away.

### Three options, in the order I would consider them

**(a) Do nothing to the transport.** This is now the strongest option, and the second-pass
measurements are why.

The server-side streaming path is the one the API team has been hardening: batched joins
(#245), the distributed-path fix (#255), deterministic results (#254), and a 2,500,000-row
protein FASTA verified end to end through Chrome and Cloudflare. A client-side Blob path
reproduces none of that and inherits none of the fixes.

Three concrete costs of moving off it, from the release notes:

- **No resume, and no way to signal it.** Interrupted downloads must be restarted.
  Chrome offers a Resume button regardless, which yields a zero-byte file. A client-side
  path has the same limitation with *less* of the server's streaming behaviour behind it.
- **Determinism is a server property.** Repeated downloads of the same query now return
  identical records (#254) because the batched join passes the caller's `sort` to Solr.
  Re-chunking client-side with our own `limit(n,offset)` loop does not inherit that, and
  offset paging over a batched join is not obviously stable at all.
- **Cloudflare's ~100 s silence limit** is survived by the streaming serializers emitting
  early. A client-side path that assembles then saves has a different failure profile
  against the same proxy.

Retry on a download is worth having, but not at the price of leaving the path the server
actually supports.

**(b) Raise `CLIENT_SIDE_LIMIT` and flip the small formats.** `CLIENT_SIDE_LIMIT` is 25,000,
which at 289 B/row is ~7 MB — comfortably safe. Flipping `serverSide: false` on tabular
formats *for result sets under that limit* routes the common case through the retryable
chunked path while leaving genuinely large exports on the stream. This is the smallest
change that makes retry real for anyone.

Needs data first: **what fraction of actual downloads are under 25,000 rows?** If it is
most of them, (b) is clearly worth it. If downloads are overwhelmingly bulk, (b) adds a
code path that rarely runs. I cannot answer this from the client — it wants API access
logs.

**(c) Full conversion to XHR + streaming assembly.** Only sensible with a streaming writer
(File System Access API, or `showSaveFilePicker` + `WritableStream`) so nothing buffers.
Browser support is uneven and it is a large change. I would not do this without (b) having
proven the demand.

---

## Item 3 — chunked downloads want `unattended` mode

**Effort: small, once Item 1 lands. Risk: low.**

`executeChunkedDownload` pages sequentially via recursive `fetchChunk` at
`FETCH_CHUNK_SIZE = 5000`. A 500,000-row export is 100 sequential requests.

The interactive 3-retry cap is the wrong policy there. If the server sheds request 60 of
100, failing the whole export after ~30 s of backoff discards the five minutes already
spent. `retryRequest`'s `mode: 'unattended'` (spec §3a — escalate to a 300 s ceiling, never
give up, optional wall-clock budget) exists for exactly this and currently has **no
caller**.

### Proposed change

Pass `{ mode: 'unattended', maxTotalWaitMs: <operator budget> }` for chunk fetches, keep
interactive for the single-shot paths. The sequential recursion is already correct for
this — it never escalates concurrency, which is what the spec prohibits.

### Two things to fix while there

- **`allData = allData.concat(data)` per chunk is O(n²).** 100 chunks of 5,000 rebuilds the
  array 100 times. Use `push(...chunk)` or collect and flatten once.
- **No progress for the retry wait.** The existing `/Download/progress` topic reports chunk
  completion; a chunk that is backing off looks identical to one that is slow. The
  `/throttle/retrying` topic already carries `waitMs`, so `DownloadProgressDialog` can say
  "server busy, retrying in N s" rather than appearing to stall.

---

## Item 4 — set expectations for a long download (DONE, after one wrong turn)

**Status: implemented.** Worth reading the correction, because the mistake is the kind
this codebase invites.

The first implementation read the count query's `400 join_too_broad` as a prediction that
the download would fail, and **blocked the Download button**. That was wrong: the download
succeeds (see above), so it denied users a file the server was willing to produce. The
contract says so explicitly — *"If the UI offers 'download these results' next to a
too-broad grid, the download is worth offering even when the grid is refused."* Reverted.

What ships instead: `RecordSelectorStep` notes that the selection could not be counted up
front and warns the download may take several minutes, then gets out of the way. No gate,
no drill-down — offering "narrow your filter" beside a working download would mislead.

Two things make the note worth having rather than noise:

- **There is genuinely no count.** A batched join never computes `numFound`
  (`CLIENT-join-too-broad.md`), so "All matching" is the honest label and the step cannot
  show a number even in principle.
- **The wait is real.** Minutes, not seconds, for a large taxon.

### Still open in this area

- **Cloudflare cuts a response after ~100 s of silence.** The streaming serializers emit
  early and keep emitting, so this holds — but the *client* must show indeterminate
  progress, not a spinner that looks hung. `DownloadProgressDialog` currently has no
  signal for a batched download, which is Item 3 territory.
- **Interrupted downloads cannot be resumed, and Chrome offers a Resume button anyway.**
  Clicking it produces a zero-byte file with no error. The release notes treat this as
  documentation-only — `Accept-Ranges: none` does not suppress the affordance, and
  advertising `Accept-Ranges` while ignoring `Range` makes Chrome **retry forever without
  advancing**. If the wizard ever grows post-download guidance, "restart, do not resume"
  belongs there. **Do not** attempt a client-side range/resume feature.
- **Batched downloads are deterministic but not globally sorted.** `sort()` orders within
  each slice, not across the file (release notes, PR #254). If any UI copy promises sorted
  output for a large export, it is wrong for this path.

---

## Suggested order

1. **Item 1 + 1a — DONE.** Mechanical; 1a was an unrelated latent bug found while
   checking Item 1 and fixed in the same pass.
2. **Item 4 — DONE**, after one wrong turn (see that section).
3. **Item 3** — small, but only meaningful once chunked downloads are actually reachable.
4. **Item 2** — needs usage data before committing; (b) is the likely answer.

Items 1 and 3 together make retry real for the chunked path. Item 4 addresses the failure
users actually hit. Item 2 is the only one that needs a product decision rather than an
engineering one.

---

## Open questions

- **What fraction of real downloads are under 25,000 rows?** Decides Item 2. Wants API
  access-log analysis, not client-side guessing.
- **Should the bundler endpoint (`BUNDLER_API_URL`) be retried?** It is job submission, not
  a Solr query. My instinct is no — a resubmitted job is worse than a failed one — but that
  is the bundler team's call.
- **Does `retryRequest` need timeout-budget awareness?** Relevant wherever a caller sets an
  explicit `timeout:` and retries eat into it. Not a problem today at 3 retries, but it
  becomes one in `unattended` mode where backoff can reach 300 s.
- ~~**Is admission control actually enabled on alpha?**~~ **Answered: yes.**
  `verify-protections.js` reports `queryAdmission.enabled is true`, heavy 3 slots / 6
  queue, interactive 20/20. Note those are **per worker** — alpha runs 3, so published
  figures must be slots x workers, and production's worker count must be confirmed
  separately rather than assumed to match (release notes).
- **Should `enableThrottleRetry` be turned on for the website?** It is still `false` by
  default client-side. With admission control live on alpha and three heavy slots, a few
  concurrent broad downloads can shed — so the retry contract is now load-bearing rather
  than speculative. This is a deployment decision, not a code one.
- **Does the download progress UI survive a multi-minute batched download?** Cloudflare
  cuts after ~100 s of silence; the server keeps emitting, but
  `DownloadProgressDialog` has no signal for a batched stream and may look hung. Item 3.
- **Should any UI copy promise sorted output for large exports?** Batched downloads sort
  *within* slices, not globally (#254). If it does, it is wrong for that path.
