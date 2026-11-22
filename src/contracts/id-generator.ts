/**
 * Generates a diagnostic task identifier. Duplicate identifiers are allowed.
 */
export type IdGenerator = () => string
