/** Assignment assumption: every transaction byte costs 4.56 kWh. */
export const ENERGY_KWH_PER_BYTE = 4.56

export const CACHE_TTL_MS = {
  /** A confirmed block is effectively immutable, except for rare chain reorganizations. */
  block: 60 * 60 * 1000,
  /** The current day's list can still change as new blocks are mined. */
  currentDayBlocks: 60 * 1000,
  /** Historical day lists change only in unusual reorganization scenarios. */
  historicalDayBlocks: 24 * 60 * 60 * 1000,
  /** A wallet can receive another transaction, so address pages are short lived. */
  address: 5 * 60 * 1000,
} as const
