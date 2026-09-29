/**
 * Format-neutral view of a coding-agent session. Everything outside `adapters/`
 * depends only on these types, never on a transcript file format.
 *
 * Adapters normalise; they do not interpret. Deciding what counts as a failure, an
 * attempt or an inferred change happens in `context/analysis/`.
 */
export {};
