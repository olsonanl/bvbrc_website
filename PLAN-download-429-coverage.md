# Plan: 429/503 coverage for the download path

**Status:** proposal, 2026-10-29. Branch `feature/download-429-coverage`.
**Depends on:** PR #1475 (merged) — `util/retryRequest.js`, `util/throttledRequest.js`,
`widget/ThrottleBanner.js`, and the `enableThrottleRetry` flag are all on alpha.

This is §4 of `PLAN-http-429-throttle-handling.md`, the one gap left after #1465/#1467/#1475.
It is written against measurements taken on alpha, and the measurements changed the shape
of the plan — see "What the server actually does" before reading the proposals.

---

## What the server actually does

The earlier plan assumed downloads were the *most* exposed path: heaviest requests, no
retry, so the first thing to fix. Half of that is right and half is wrong.

### Downloads are classified heavy, and that is deliberate

`p3_api/middleware/QueryClassifier.js:87` — `req.isDownload` is heavy by construction,
before any `rows` inspection. The comment explains why: *"a download fans out to ~370
secondary lookups per genome"*, and admission control exists to bound concurrent
amplification. So under admission control a download **can** be shed with a 429.

### But downloads are exempt from the join guard, on purpose

`middleware/JoinResolution.js:100,119` exempt `isDownload` from the `join_too_broad`
rejection. The comment is explicit:

> *A grid page must stay fast or fail fast — nobody wants a 25-row page that takes five
> minutes — whereas a download is already understood to be a long operation, and "slow but
> reliable" beats "refused".*

Measured on alpha, same filter (Viruses, `genome_sequence`):

```
grid-style  POST /genome_sequence/            -> 400 join_too_broad in ~1.5 s
download    POST /genome_sequence/?http_download=true -> still running at 120 s (client timeout)
```

**This matters more than the 429 question.** The failure a user actually hits on a broad
download today is not a 429 — it is a request that runs until something times out. Adding
retry logic to that does nothing.

### What this changes

The original §4 framing — "downloads are unretryable, convert them to XHR+Blob so they can
retry" — solves the smaller problem. The ordering below reflects that: the cheap mechanical
fixes first, the genuinely useful UX work second, and the expensive conversion last and
only if the evidence supports it.

---

## Item 1 — `DownloadExecutor` bypasses the throttle provider

**Effort: small. Risk: low. Do this first.**

`util/DownloadExecutor.js:6` imports `dojo/request/xhr` directly. Per the provider
mechanism documented in `CLAUDE.md`, that opts out of `throttledRequest` entirely, so none
of its four XHR sites get 429 handling:

| line | call | what it is |
|---|---|---|
| 303 | `xhr.post(sourceUrl, …)` | cross-collection prefetch, 120 s timeout |
| 396 | `xhr.post(DATA_API_URL + …)` | `executeClientSideDownload`, 300 s timeout |
| 477 | `xhr.post(BUNDLER_API_URL + …)` | `executeBundleDownload`, 60 s timeout |
| 583 | `xhr.post(DATA_API_URL + …)` | `executeChunkedDownload` per chunk, 120 s |

`widget/download/RecordSelectorStep.js` has the same direct import.

### Proposed change

Switch both files from `dojo/request/xhr` to `dojo/request`. That is the whole fix for
three of the four sites — the provider matches on data-API URLs and wraps them.

Two caveats that are not optional:

- **Line 477 posts to `BUNDLER_API_URL`, not the data API.** Check whether the provider's
  matcher covers it; if the bundler is a different host/prefix it will fall through
  unwrapped, which is correct (it is a job-submission call, not a Solr query) but should be
  a deliberate decision rather than an accident.
- **The timeouts interact with retry.** A 300 s timeout wrapping 3 retries at up to ~10 s
  backoff each is fine, but `retryRequest` does not currently subtract elapsed time from
  the caller's timeout. Worth confirming a shed-then-retried download still has budget left
  rather than failing on a timeout that was consumed by waiting.

### Verification

Inject 429s for `/alpha/api/` as in the #1465 work, run a client-side-forced download, and
confirm the retry fires and the banner shows. The banner already subscribes to the right
topics, so no UI work is needed here.

---

## Item 2 — `executeServerSideDownload` is unreachable by any wrapper

**Effort: medium. Risk: medium. This is the real decision.**

`DownloadExecutor.js:256` builds a hidden form and calls `form.submit()`. The response goes
to the browser, not to JS, so no amount of client code can see its status, retry it, or
report it. The user gets a browser-rendered error page or a failed download.

### It is the default for everything

`execute()` at line 783:

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

**(a) Do nothing to the transport; fix the user-visible failure instead.** See Item 4. The
honest observation is that a browser-handled download already *has* a failure UI — the
browser's own — and the thing users actually lack is any signal before they commit to a
download that will not work.

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

## Item 4 — tell the user before they commit to a download that cannot work

**Effort: medium. Risk: low. Highest user value of the four.**

This is the item the measurements promoted. The actual failure today is not a 429 — it is a
broad download that runs until something times out, with no indication it was doomed.

The wizard already knows `spec.totalCount` before submitting (it drives `isLargeDataset`).
So it can tell the user what they are about to do:

- **Under `CLIENT_SIDE_LIMIT`** — proceed silently, as now.
- **Large but bounded** — "This will export ~N rows and may take several minutes." Set
  expectations rather than letting a long wait read as a hang.
- **Over the join guard's limit, with a `genome(...)` filter** — this is the case that will
  hang. The grid behind it has already been refused with `join_too_broad` and knows the
  genome count and limit. Reuse `util/joinTooBroad.js` and `widget/JoinTooBroadMessage.js`
  from #1475 to say so *in the wizard*, with the same taxon drill-down, instead of
  submitting a form that will time out.

That last point is the strongest connection between this work and what already shipped: the
machinery to explain it is written, tested, and on alpha. It just is not wired into the
download path.

---

## Suggested order

1. **Item 1** — mechanical, unblocks everything else, low risk.
2. **Item 4** — biggest user-visible improvement, reuses shipped code.
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
- **Is admission control actually enabled on alpha for downloads?** `enableThrottleRetry` is
  off by default client-side, and the API ships admission control disabled. Items 1 and 3
  are untestable end-to-end until both are on somewhere.
