/**
 * State storage interface.
 */
export interface StateStorage<TState> {
	/**
	 * Gets the state for the given key.
	 *
	 * @param key The key to get the state for.
	 */
	get(key: string): Promise<TState | null>;

	/**
	 * Sets the state for the given key.
	 *
	 * @param key The key to set the state for.
	 * @param value The state to set.
	 * @param ttlMs Optional TTL in milliseconds.
	 */
	set(key: string, value: TState, ttlMs?: number): Promise<void>;

	/**
	 * Deletes the state for the given key.
	 *
	 * @param key The key to delete the state for.
	 */
	delete(key: string): Promise<void>;

	/**
	 * Clears all stored states.
	 */
	clear(): Promise<void>;

	/**
	 * Destroys the storage.
	 */
	destroy?(): Promise<void>;

	/**
	 * Acquires a lock for the given key.
	 *
	 * @param key The key to acquire the lock for.
	 */
	acquireLock?(key: string): Promise<void>;

	/**
	 * Releases the lock for the given key.
	 *
	 * @param key The key to release the lock for.
	 */
	releaseLock?(key: string): Promise<void>;
}
