/**
 * Behavior when quota or local execution capacity is unavailable.
 *
 * - `reject` forbids waiting for quota or concurrency.
 * - `enqueue` permits bounded waiting. A finite capacity must be configured.
 */
export type LimitBehavior = 'reject' | 'enqueue'
