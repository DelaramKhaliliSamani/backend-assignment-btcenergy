function positiveIntegerFromEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]

  if (rawValue === undefined) {
    return fallback
  }

  const parsedValue = Number(rawValue)

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }

  return parsedValue
}

export const config = {
  blockchainApiBaseUrl:
    process.env.BLOCKCHAIN_API_BASE_URL ?? 'https://blockchain.info',
  blockchainApiTimeoutMs: positiveIntegerFromEnv(
    'BLOCKCHAIN_API_TIMEOUT_MS',
    10_000,
  ),
  blockchainFetchConcurrency: positiveIntegerFromEnv(
    'BLOCKCHAIN_FETCH_CONCURRENCY',
    8,
  ),
  blockchainCacheMaxEntries: positiveIntegerFromEnv(
    'BLOCKCHAIN_CACHE_MAX_ENTRIES',
    2_000,
  ),
  maxDailyEnergyDays: positiveIntegerFromEnv('MAX_DAILY_ENERGY_DAYS', 30),

  // --- Retry / rate-limit handling for the public blockchain API ---
  /** Total attempts per request (1 = no retry). Public API returns 429s under load. */
  blockchainMaxAttempts: positiveIntegerFromEnv('BLOCKCHAIN_MAX_ATTEMPTS', 3),
  /** Base backoff delay; grows exponentially per retry, plus jitter. */
  blockchainRetryBaseDelayMs: positiveIntegerFromEnv(
    'BLOCKCHAIN_RETRY_BASE_DELAY_MS',
    300,
  ),

  // --- Wallet safety cap ---
  /** Upper bound on how many wallet transactions we will page through. */
  maxWalletTransactions: positiveIntegerFromEnv(
    'MAX_WALLET_TRANSACTIONS',
    5_000,
  ),
} as const
