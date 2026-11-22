# Rate Limiter

`@stimulcross/rate-limiter` controls when outgoing requests and other async work can start in Node.js and browsers. Choose a quota policy, then pass each operation as a callback to `run()`. When a callback has to wait for quota or a free execution slot, the limiter can queue it or reject it immediately.

Each instance keeps its state in memory. Use keys to give different accounts or endpoints independent quotas within one instance. The queue and concurrency limit are shared across those keys.

## Installation

Run the command for your package manager.

### npm

```sh
npm install @stimulcross/rate-limiter
```

### pnpm

```sh
pnpm add @stimulcross/rate-limiter
```

### yarn

```sh
yarn add @stimulcross/rate-limiter
```

Use ESM on Node.js 22.13 or later. Browser runtimes need `Promise.withResolvers()` and `AbortSignal.any()`.

## Quick start

Import a limiter from its own subpath. This instance allows up to five starts per second for each key, runs up to four callbacks at a time, and gives waiting callbacks up to two seconds to start.

```ts
import { Priority } from '@stimulcross/rate-limiter'
import { FixedWindowLimiter } from '@stimulcross/rate-limiter/fixed-window'

const limiter = new FixedWindowLimiter({
	limitOptions: { limit: 5, windowMs: 1000 },
	limitBehavior: 'enqueue',
	queue: { capacity: 20, concurrency: 4, maxWaitMs: 2000 },
})

const response = await limiter.run(() => fetch('https://example.com/api/items'), {
	key: 'items',
	priority: Priority.High,
})

console.log(response.status, await limiter.getStatus('items'))
```

Reuse the instance across calls so they share quota and queue state. Choose a key that matches the real quota scope. For example, use the account ID if several endpoints share one account-wide quota. Tasks without a key use the default quota.

## Limiter interfaces

`RateLimiter` and `FixedResultRateLimiter` are exported from the package root. They describe the shared API for built-in and custom limiters. Both provide `run()` to schedule a callback and `clear()` to reset quota and cancel pending work. Implementations can also provide `getStatus()` and `destroy()`. Both accept callbacks that return a value or a promise-like value and return a promise for the result.

### RateLimiter

Use `RateLimiter` when callbacks on the same instance can return different types. Each `run()` call infers its own result type. The time-based limiters implement this interface.

```ts
import type { RateLimiter } from '@stimulcross/rate-limiter'

function createResourceClient(limiter: RateLimiter) {
	return {
		get: (url: string) => limiter.run(() => fetch(url)),
		checkStatus: (url: string) => limiter.run(async () => {
			const response = await fetch(url, { method: 'HEAD' })
			return response.status
		}),
	}
}
```

Here `get()` returns `Promise<Response>` and `checkStatus()` returns `Promise<number>`.

### FixedResultRateLimiter

Use `FixedResultRateLimiter<TResult, TStatus>` when a group of callbacks shares a result type. Set `TResult` to that type so every call to `run()` returns `Promise<TResult>`. The second type argument defaults to `object`. Supply it when you need the algorithm-specific status type from `getStatus()`.

A parameter typed as `FixedResultRateLimiter<Response>` accepts a `RateLimiter` because its `run()` supports any result type. It also accepts an HTTP limiter configured for `Response`. A parameter typed as `RateLimiter` requires support for arbitrary callback results, so TypeScript rejects passing that HTTP limiter to it.

```ts
import type { FixedResultRateLimiter } from '@stimulcross/rate-limiter'
import { TokenBucketLimiter } from '@stimulcross/rate-limiter/token-bucket'

function createJsonClient(limiter: FixedResultRateLimiter<Response>) {
	return {
		async get<T = unknown>(url: string, init?: RequestInit): Promise<unknown> {
			const response = await limiter.run(() => fetch(url, init))

			if (!response.ok)
				throw new Error(`HTTP ${response.status}`)

			return (await response.json()) as T
		},
	}
}

const bucket = new TokenBucketLimiter({
	limitOptions: { capacity: 10, refillRate: 2 },
})
const client = createJsonClient(bucket)
```

For an API that reports quota in response headers, pass its configured HTTP limiter to the same factory. For example, use `createJsonClient(twitchLimiter)` with the limiter from the [Twitch Helix example](#example-with-twitch-helix). Both options pass the raw `Response` through `run()`. The HTTP limiter reads the headers before the client parses the body.

## Choosing a limiter

| Limiter                                           | Use it when                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Fixed Window](#fixed-window)                     | You have a budget that resets at fixed intervals.                                         |
| [Token Bucket](#token-bucket)                     | You want a steady long-term rate with room for short bursts.                              |
| [Sliding Window Log](#sliding-window-log)         | You need an exact limit over any rolling time interval.                                   |
| [Sliding Window Counter](#sliding-window-counter) | An approximate rolling limit is sufficient and you want to store only two counts per key. |
| [Generic Cell (GCRA)](#generic-cell-gcra)         | You want a target spacing between starts with a configurable burst allowance.             |
| [Leaky Bucket](#leaky-bucket)                     | You want a minimum gap between starts, even after an idle period.                         |
| [HTTP Response Based](#http-response-based)       | The upstream API reports its remaining quota, reset time, or when to retry.               |

Fixed Window, Token Bucket, Sliding Window Log, and Generic Cell accept one profile or a nonempty array in `limitOptions`. Each start consumes one unit from every profile for its key. For example, two Fixed Window profiles can enforce both 5 starts per second and 100 per minute.

### Fixed Window

`FixedWindowLimiter` from `@stimulcross/rate-limiter/fixed-window` counts starts in windows of `windowMs` and resets the count at the end of each window. Traffic can bunch up around a reset because each window has its own budget.

Configure `limitOptions: { limit: 100, windowMs: 60_000 }` for 100 starts per minute. By default, the first admitted start opens the window, and the first start after expiry opens the next one. Use `alignment: 'grid'` for fixed boundaries measured from the Unix epoch, with optional `offsetMs` to shift the grid.

### Token Bucket

`TokenBucketLimiter` from `@stimulcross/rate-limiter/token-bucket` starts with a full bucket. Each callback takes one token, and tokens refill continuously up to capacity. Idle time restores the ability to handle a burst.

Configure `limitOptions: { capacity: 10, refillRate: 2 }` to allow an initial burst of up to 10 starts and replenish two tokens per second.

### Sliding Window Log

`SlidingWindowLogLimiter` from `@stimulcross/rate-limiter/sliding-window-log` records the time of each start. A start counts against the quota until it is `windowMs` old, so capacity returns as individual starts expire.

Configure `limitOptions: { limit: 30, windowMs: 60_000 }` to allow at most 30 starts in any rolling minute. The exact count requires keeping recent start timestamps for each key.

### Sliding Window Counter

`SlidingWindowCounterLimiter` from `@stimulcross/rate-limiter/sliding-window-counter` estimates rolling usage with two counts per key. It adds the current window's count to a share of the previous window's count. That share decreases as the current window progresses.

Configure a single profile with `limitOptions: { limit: 30, windowMs: 60_000 }`. A start is eligible when adding one keeps the unrounded estimate within the limit. Set `offsetMs` to shift the window grid relative to the Unix epoch. Use the Log variant if you need an exact rolling count.

### Generic Cell (GCRA)

`GenericCellLimiter` from `@stimulcross/rate-limiter/generic-cell` keeps track of when the next start would occur at the configured rate. Each start advances that schedule. The burst allowance lets callbacks start ahead of it when the key has recovered enough capacity.

Configure `limitOptions: { intervalMs: 100, burst: 3 }` for a nominal rate of one start every 100 ms and up to three starts together after full recovery. Set `burst: 1` to require the configured gap between starts.

### Leaky Bucket

`LeakyBucketLimiter` from `@stimulcross/rate-limiter/leaky-bucket` keeps starts at least one interval apart. The next interval begins when a callback actually starts. After a long enough idle period, the next callback can start immediately.

Configure `limitOptions: { intervalMs: 100 }` for at least 100 ms between starts on the same key. Fractional intervals are supported. Callbacks can overlap up to the instance's concurrency limit.

### HTTP Response Based

`HttpResponseBasedLimiter` uses the upstream API's responses to decide when more requests can start. For each key, the first request probes the quota. Once the API reports a budget, each start spends one unit and requests can overlap up to the instance's concurrency limit. Later responses for the same window can lower the budget. After the reset and once in-flight requests settle, the next request probes again.

#### extractFeedback

`extractFeedback(response, settledAt)` receives the value returned by your HTTP callback, or `null` when there is no response. Read the status and headers using your client's response shape, then tell the limiter what to do with the **next** request for that key. Return `null` when there is no quota or cooldown information.

| Return value                            | Effect on later requests                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `{ kind: 'quota', remaining, resetAt }` | Records how many units remain **after** the request and when the server window ends.                 |
| `{ kind: 'rate-limited', retryAt }`     | Pauses starts until `retryAt`. Omit it to use `fallbackResetDelayMs` (60,000 ms by default).         |
| `null`                                  | Supplies no new quota information. If the quota is still unknown, the next request is another probe. |

`settledAt`, `resetAt`, and `retryAt` are Unix epoch milliseconds. For quota snapshots, use the same `resetAt` for every response in the same server window.

With `HttpResponseBasedLimiter<TResponse>`, each callback passed to `run()` must return a `TResponse` or a promise of one. `run()` always returns `Promise<TResponse>`. The response type defaults to `unknown` when TypeScript cannot infer it. For an instance shared by several clients, use a union of their response types and handle each shape in the extractor.

If your client rejects with an HTTP response inside the error, supply `extractResponseFromError(error)` to recover that response or return `null`. The limiter uses the recovered response for feedback and propagates the original rejection to the caller.

#### Example with Twitch Helix

This example calls Get Streams with one app access token and uses the default key for that app's quota. Twitch reports the remaining points in `Ratelimit-Remaining` and the reset in Unix epoch seconds in `Ratelimit-Reset`. On a quota-related 429, use that reset as the next retry time.

```ts
import type { HttpFeedback } from '@stimulcross/rate-limiter/http-response-based'
import { HttpResponseBasedLimiter } from '@stimulcross/rate-limiter/http-response-based'

const twitchLimiter = new HttpResponseBasedLimiter<Response>({
	extractFeedback: (response): HttpFeedback | null => {
		if (response === null)
			return null

		const { headers, status } = response
		const resetAt = Number(headers.get('Ratelimit-Reset') || NaN) * 1000

		if (status === 429)
			return Number.isFinite(resetAt)
				? { kind: 'rate-limited', retryAt: resetAt }
		        : { kind: 'rate-limited' }

		const remaining = Number(headers.get('Ratelimit-Remaining') || NaN)

		if (Number.isSafeInteger(remaining) && remaining >= 0 && Number.isFinite(resetAt))
			return { kind: 'quota', remaining, resetAt }

		return null
	},
})

function getStreams(clientId: string, accessToken: string): Promise<Response> {
	return twitchLimiter.run(() =>
		fetch('https://api.twitch.tv/helix/streams', {
			headers: { 'Client-Id': clientId, Authorization: `Bearer ${accessToken}` },
		}),
	)
}
```

#### Example with Axios and `extractResponseFromError`

`run()` preserves the callback's outcome. With `fetch`, it resolves with the 429 response. With Axios's default status handling, it rejects with the original `AxiosError`. In both cases, `extractFeedback` uses the 429 to delay subsequent requests for the same key. The Axios example uses `extractResponseFromError` to pass `error.response` to the extractor.

```ts
import type { AxiosResponse } from 'axios'
import axios from 'axios'
import { HttpResponseBasedLimiter } from '@stimulcross/rate-limiter/http-response-based'

const twitchLimiter = new HttpResponseBasedLimiter<AxiosResponse<unknown>>({
	extractResponseFromError: error => {
		if (axios.isAxiosError<unknown>(error) && error.response)
			return error.response

		return null
	},
	extractFeedback: response => {
		if (response === null)
			return null

		const { headers, status } = response
		const resetAt = Number(headers['ratelimit-reset'] ?? NaN) * 1000

		if (status === 429)
			return Number.isFinite(resetAt)
				? { kind: 'rate-limited', retryAt: resetAt }
				: { kind: 'rate-limited' }

		// Read ratelimit-remaining and report quota as in the fetch example above.
		return null
	},
})

function getStreams(clientId: string, accessToken: string): Promise<AxiosResponse<unknown>> {
	return twitchLimiter.run(() =>
		axios.get<unknown>('https://api.twitch.tv/helix/streams', {
			headers: { 'Client-Id': clientId, Authorization: `Bearer ${accessToken}` },
		}),
	)
}
```

#### Other header formats

Use these snippets inside `extractFeedback` after reading `headers` from the response.

**Structured `RateLimit`.** Read the available units from `a` and the window in seconds from `w`. The snippet matches the single policy shown here. Use a Structured Fields parser for general header values. [IETF draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-12#section-3)

```http
Date: Sat, 21 Nov 2026 12:30:00 GMT
RateLimit-Policy: "items";q=100;w=60
RateLimit: "items";a=12;w=30
```

```ts
const policy = /^"items";a=(\d+);w=(\d+)$/.exec(headers.get('RateLimit') ?? '')
const remaining = Number(policy?.[1])
const resetAt = Date.parse(headers.get('Date') ?? '') + Number(policy?.[2]) * 1000

return Number.isSafeInteger(remaining) && Number.isFinite(resetAt)
	? { kind: 'quota', remaining, resetAt }
	: null
```

**Split headers with a relative reset.** In this format, the reset is 30 seconds after the response time. For a fixed window, the server's `Date` plus the duration can identify the same reset across responses. [Earlier IETF draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-03#section-5)

```http
Date: Sat, 21 Nov 2026 12:30:00 GMT
RateLimit-Remaining: 12
RateLimit-Reset: 30
```

```ts
const remaining = Number(headers.get('RateLimit-Remaining') || NaN)
const seconds = Number(headers.get('RateLimit-Reset') || NaN)
const resetAt = Date.parse(headers.get('Date') ?? '') + seconds * 1000

return Number.isSafeInteger(remaining) && remaining >= 0 && seconds >= 0 && Number.isFinite(resetAt)
	? { kind: 'quota', remaining, resetAt }
	: null
```

**GitHub-style `X-RateLimit` headers.** Multiply the reset by 1000 to convert epoch seconds to epoch milliseconds. [GitHub REST API docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#checking-the-status-of-your-rate-limit)

```http
X-RateLimit-Remaining: 12
X-RateLimit-Reset: 1795269030
```

```ts
const remaining = Number(headers.get('X-RateLimit-Remaining') || NaN)
const resetAt = Number(headers.get('X-RateLimit-Reset') || NaN) * 1000

return Number.isSafeInteger(remaining) && remaining >= 0 && Number.isFinite(resetAt)
	? { kind: 'quota', remaining, resetAt }
	: null
```

**`Retry-After` on a throttled response.** For a delay in seconds, compute `retryAt = settledAt + delaySeconds * 1000`. For an HTTP date, parse the date directly. [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
```

```ts
const value = headers.get('Retry-After') ?? ''
const retryAt = /^\d+$/.test(value) ? settledAt + Number(value) * 1000 : Date.parse(value)

return Number.isFinite(retryAt) && retryAt > settledAt
	? { kind: 'rate-limited', retryAt }
	: { kind: 'rate-limited' }
```

> [!IMPORTANT]
> Consult the official documentation for your target API and endpoint. Check the header names, reset units, quota scope, request cost, and throttling responses before writing your extractor.

## Shared API

### Methods

| Method                    | Behavior                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `run(callback, options?)` | Starts the callback when admitted and returns a promise for its result. A start uses quota even if the callback throws or rejects. |
| `getStatus(key?)`         | Reads quota status without spending or reserving quota. Omit the key to inspect the default quota.                                 |
| `clear(key?)`             | Resets quota and rejects queued callbacks for one key or, with no argument, for all keys. Running callbacks continue.              |
| `destroy()`               | Closes the instance to new work, rejects queued callbacks, and waits for running callbacks to settle.                              |

Time-based limiters report `nextAvailableAt` (an epoch timestamp in milliseconds) for the next quota-eligible start. Queue position and available concurrency still affect when the callback can start. For limiters with multiple profiles, the status lists them in configuration order.

| Limiter                | What to look for in its status                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Fixed Window           | `profiles` with window bounds, `used`, and `remaining`. `window` is `null` before a `first-start` window opens.      |
| Token Bucket           | `profiles` with the current token balance in `tokens`, including fractional refill.                                  |
| Sliding Window Log     | `profiles` with `used` and `remaining` for each rolling window.                                                      |
| Sliding Window Counter | `currentCount`, `previousCount`, `estimatedCount`, and `remaining` whole starts.                                     |
| Generic Cell           | `profiles` with `remaining` immediate starts and `tat`, the scheduled time when the profile will be fully recovered. |
| Leaky Bucket           | `lastStartedAt` (`null` before the first start) and the configured `intervalMs`.                                     |
| HTTP Response Based    | `status` is `unknown`, `probing`, `known` (with `remaining` and `resetAt`), or `cooling-down` (with `retryAt`).      |

### Instance options

| Option              | Behavior                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limitBehavior`     | Defaults to `'reject'`. Set `'enqueue'` to allow waiting and provide an explicit `queue.capacity`.                                                                                                                                  |
| `queue.capacity`    | Maximum number of waiting callbacks across all keys. Use `0` to allow only immediate starts.                                                                                                                                        |
| `queue.concurrency` | Maximum number of running callbacks across all keys. Defaults to unlimited.                                                                                                                                                         |
| `queue.maxWaitMs`   | Maximum time a callback may wait to start. Defaults to unlimited.                                                                                                                                                                   |
| `weights`           | Relative shares for eligible work in the five priority classes. Defaults to `1`, `2`, `4`, `8`, and `16` from `Priority.Lowest` through `Priority.Highest`. Supply a positive finite weight for each class to customize the shares. |
| `idGenerator`       | Supplies a diagnostic ID for each task submitted without one.                                                                                                                                                                       |
| `loggerOptions`     | Defaults to `minLevel: 'warning'`. Use `'debug'` for starts, queue entries, and rejections, or `'verbose'` for more scheduling detail. Set `includeIdentifiers: true` only if task IDs and keys are safe to log.                    |

Quota timestamps use Unix epoch time from `Date.now()`. Queue deadlines use monotonic time from `performance.now()`. When migrating, remove custom clock options (`clock`, `quotaClock`, or `waitingClock`) and imports of the `Clock` type.

### Per-call options

| Option          | Behavior                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`           | Selects a quota by string key.                                                                                                                     |
| `priority`      | Defaults to `Priority.Normal`. Affects selection among eligible callbacks. Quotas and concurrency still apply.                                     |
| `limitBehavior` | Overrides the instance's behavior for this call. Enqueue still requires an instance capacity.                                                      |
| `maxWaitMs`     | Overrides the wait deadline. Use `0` to require an immediate start. The deadline applies until the callback starts.                                |
| `signal`        | Cancels a callback that has yet to start. To cancel an operation after it starts, pass the signal to the operation itself, for example to `fetch`. |
| `id`            | Sets a diagnostic task ID.                                                                                                                         |

### Errors

Import `RateLimitError` and `RateLimitErrorCode` from `@stimulcross/rate-limiter`. When the limiter rejects a task before it starts, the error has a `code`, a `retryAfterMs` delay (`null` when unknown), and the task's `id` if available. Once the callback starts, its own errors propagate to the caller.

| `RateLimitErrorCode` | Reason                                                             |
| -------------------- | ------------------------------------------------------------------ |
| `LimitExceeded`      | The callback could not start immediately and waiting was disabled. |
| `QueueOverflow`      | The queue had no room for another callback.                        |
| `Expired`            | The wait deadline elapsed.                                         |
| `Cancelled`          | The signal was aborted before the callback started.                |
| `Cleared`            | The queue entry was removed by `clear()`.                          |
| `Destroyed`          | The limiter was closed or was shutting down.                       |
