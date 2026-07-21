export interface TransactionEnergy {
  hash: string
  sizeBytes: number
  energyKwh: number
}

export interface BlockEnergy {
  blockHash: string
  blockHeight: number
  transactionCount: number
  totalSizeBytes: number
  totalEnergyKwh: number
  transactions: TransactionEnergy[]
}

export interface DailyEnergy {
  date: string
  isComplete: boolean
  blockCount: number
  transactionCount: number
  totalSizeBytes: number
  totalEnergyKwh: number
}

export interface WalletEnergy {
  address: string
  /** Number of unique transactions actually counted in the totals below. */
  transactionCount: number
  /** Total transactions the wallet has, as reported by the API (may exceed transactionCount when truncated). */
  totalTransactionCount: number
  totalSizeBytes: number
  totalEnergyKwh: number
  /**
   * False when the wallet has more transactions than the configured cap,
   * so the totals cover only the most recent `transactionCount` transactions.
   */
  isComplete: boolean
}
