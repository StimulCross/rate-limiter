import type { LazyLogFn, LogLevel } from '@stimulcross/logger'
import type { RateLimiterLoggerOptions } from '../contracts/rate-limiter-options.js'
import { createLogger } from '@stimulcross/logger'

interface DiagnosticFields {
	readonly id?: string
	readonly key?: string
	readonly [field: string]: string | number | undefined
}

function quoteIdentifier(value: string): string {
	return JSON.stringify(value).replaceAll(/[\u0080-\u009F\u2028-\u202E\u2066-\u2069]/gu, character => {
		const code = character.codePointAt(0) ?? 0

		return String.raw`\u${code.toString(16).padStart(4, '0')}`
	})
}

function formatEvent(event: string, { id, key, ...details }: DiagnosticFields, includeIdentifiers: boolean): string {
	let message = `[${event}]`

	if (includeIdentifiers) {
		if (id !== undefined)
			message += ` id=${quoteIdentifier(id)}`

		if (key !== undefined)
			message += ` key=${quoteIdentifier(key)}`
	}

	const fields = Object.entries(details)
		.filter(([, value]) => value !== undefined)
		.map(([field, value]) => `${field}=${value}`)

	return fields.length > 0
		? `${message} | ${fields.join(' ')}`
		: message
}

/** @internal */
export function createLimiterLogger(context: string, options: RateLimiterLoggerOptions = {}) {
	const { includeIdentifiers = false, minLevel = 'warning', ...outputOptions } = options
	const output = createLogger({ ...outputOptions, context, minLevel })

	const defer = (level: LogLevel, build: LazyLogFn): void => {
		queueMicrotask(() => {
			try {
				output.lazy.log(level, build)
			}
			catch {}
		})
	}

	const dispatch = createLogger({
		context,
		minLevel: output.minLevel,
		custom: {
			log: (level, ...args) => defer(level, () => args),
			lazy: { log: defer },
		},
	}).lazy

	return (level: LogLevel, event: string, getFields?: () => DiagnosticFields, error?: unknown): void => {
		dispatch.log(level, () => {
			const message = getFields === undefined
				? `[${event}]`
				: formatEvent(event, getFields(), includeIdentifiers)

			return error instanceof Error
				? [message, error]
				: [message]
		})
	}
}
