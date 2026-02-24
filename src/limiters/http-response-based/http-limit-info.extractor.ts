import { type HttpLimitInfo } from './http-limit.info.js';

/**
 * A function that extracts limit information from response headers.
 *
 * @param res The response object, for example, native `Response` object from the `fetch` API.
 * @param err The error object, if any.
 * @param now The current timestamp in milliseconds gotten from the internal clock.
 *            If you need the current timestamp, prefer this value over `Date.now()`.
 *
 * @returns {@link HttpLimitInfo} or `null` if not possible to extract or no limit info.
 *
 * @template TResponse The type of the response object.
 * @template TError The type of the error object.
 */
export type HttpLimitInfoExtractor<TResponse, TError extends Error = Error> = (
	res: TResponse | null,
	err: TError | null,
	now: number,
) => HttpLimitInfo | null;
