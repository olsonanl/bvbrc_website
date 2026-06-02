# Plan: Handle HTTP 429 (Throttling) from Data API

## Context

The Data API is adding support for HTTP 429 (Too Many Requests) responses when the Solr database cannot immediately handle a request. The website needs to handle these gracefully: automatically retry with backoff, and show a persistent banner to the user indicating the database is under load.

Currently, 429 responses are treated the same as any other error — the request fails, the grid shows no data, and the user sees a generic error toast that auto-dismisses in 3 seconds. There is no retry logic anywhere in the frontend.

## Approach

Two layers:

1. **Request layer** — retry with exponential backoff in the two main API request paths (`P3JsonRest` store and `bvbrc_js_client`), respecting the `Retry-After` header
2. **UI layer** — a persistent throttle banner below the site header that appears when any request is being throttled and disappears when all retries succeed or are exhausted

---

## 1. Throttle-Aware Request Wrapper

Create a shared utility `public/js/p3/util/retryRequest.js` that wraps any request function with 429-aware retry logic. This avoids duplicating retry code across P3JsonRest, bvbrc_client, and individual xhr calls.

**Behavior:**
- On HTTP 429: read `Retry-After` header (seconds), wait that long, retry
- If no `Retry-After` header: use exponential backoff starting at 2 seconds (2s, 4s, 8s, 16s)
- Max retries: 4 attempts (configurable)
- On each 429: publish `Topic.publish('/throttle/active')` to trigger the banner
- On successful retry: publish `Topic.publish('/throttle/resolved')`
- After max retries exhausted: publish `Topic.publish('/throttle/failed')` and reject the promise with the 429 error

**Interface:**
```javascript
// retryRequest(requestFn, options) -> Promise
// requestFn: a function that returns a promise (the actual request)
// options: { maxRetries: 4, baseDelay: 2000 }

retryRequest(function() {
  return dojo.rawXhrPost({ ... });
}, { maxRetries: 4 });
```

**File:** `public/js/p3/util/retryRequest.js`

---

## 2. Integrate into P3JsonRest

**File:** `public/js/p3/store/P3JsonRest.js`

P3JsonRest uses `dojo.rawXhrPost()` to make API calls. Wrap the XHR call with `retryRequest`:

- In the `query()` method (the main entry point for grid data fetches), wrap the `dojo.rawXhrPost()` call
- The retry wrapper handles 429 transparently — the store's existing success/error callbacks work unchanged for non-429 errors
- No changes needed to GridContainer, PageGrid, or any consumers of the store

---

## 3. Integrate into BVBRCClient

**File:** `public/js/bvbrc_js_client/dist/bvbrc_client.js` (or its source)

The client uses `fetch()`. Wrap the fetch call with retry logic:

- Check `response.status === 429` before throwing
- Read `response.headers.get('Retry-After')`
- Wait and retry using the same backoff strategy
- Publish throttle topics

---

## 4. Persistent Throttle Banner

Create a lightweight banner widget that listens for throttle events and manages visibility.

**File:** `public/js/p3/widget/ThrottleBanner.js`

**Behavior:**
- Subscribes to `/throttle/active`, `/throttle/resolved`, `/throttle/failed`
- Maintains a counter of active throttled requests
- On `/throttle/active`: increment counter, show banner if not already visible
- On `/throttle/resolved`: decrement counter, hide banner when counter reaches 0
- On `/throttle/failed`: decrement counter, update message to indicate some requests could not be completed
- Auto-hides 3 seconds after the last throttled request resolves

**Appearance:**
- Yellow/amber warning bar below the site header (above page content)
- Message: "Database access is currently limited due to high demand. Requests are being retried automatically..."
- If retries exhausted: "Some requests could not be completed due to high database load. Please try refreshing the page."
- Subtle animated indicator (pulsing dot or spinner) while retries are active
- Does not block interaction — user can continue navigating

**Mounting point:** Added in `p3app.js` after the header, before the main content area. Listens to Topic events — no coupling to stores or grids.

---

## 5. Integration Points

### p3app.js
- Instantiate `ThrottleBanner` and place it after the header
- No other changes needed — the banner is self-contained via Topic subscriptions

### Direct xhr calls in widgets
- For the initial implementation, do NOT wrap every individual `xhr.get()` call scattered across widgets
- These are less common than store-based queries and can be addressed incrementally
- If a direct xhr call gets a 429, it will fail as it does today (no retry) — acceptable for the initial rollout

### Workspace API calls
- WorkspaceManager talks to the workspace service, not the data API
- No 429 handling needed there unless the workspace service also starts returning 429

---

## Files to Create

| File | Purpose |
|------|---------|
| `public/js/p3/util/retryRequest.js` | Retry wrapper with backoff and Retry-After support |
| `public/js/p3/widget/ThrottleBanner.js` | Persistent warning banner |

## Files to Modify

| File | Change |
|------|--------|
| `public/js/p3/store/P3JsonRest.js` | Wrap XHR call with `retryRequest` |
| `public/js/bvbrc_js_client/dist/bvbrc_client.js` | Add 429 retry to `fetch()` calls |
| `public/js/p3/app/p3app.js` | Instantiate and place `ThrottleBanner` |

## Files NOT Modified

- `GridContainer.js` — no changes, retries happen transparently in the store
- `app.js` (server) — proxy passes 429 through, no server-side changes needed
- Individual widget files — addressed incrementally if needed

---

## Verification

1. **Simulate 429:** Add a test middleware to the Express proxy that returns 429 with `Retry-After: 3` for a percentage of `/api/` requests
2. **Verify retry:** Watch network tab — should see the initial 429, a pause, then a successful retry
3. **Verify banner:** Banner appears on first 429, stays visible during retries, disappears after success
4. **Verify max retries:** After 4 failed retries, banner updates to "could not complete" message, grid shows appropriate error state
5. **Verify no retry storm:** When multiple grids on the same page all get 429, verify requests don't pile up — the backoff delay should stagger them naturally
6. **Verify non-429 errors unaffected:** 401, 403, 500 errors should not trigger retries or the throttle banner
