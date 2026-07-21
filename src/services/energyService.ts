import { ENERGY_KWH_PER_BYTE } from '../constants'
import { InputValidationError } from '../errors'
import type {
  BlockchainBlock,
  BlockchainClient,
  BlockchainTransaction,
} from '../types/blockchain'
import type {
  BlockEnergy,
  DailyEnergy,
  TransactionEnergy,
  WalletEnergy,
} from '../types/energy'
import {
  addUtcDays,
  formatUtcDate,
  mapWithConcurrency,
  startOfUtcDay,
} from '../utils'

interface EnergyServiceOptions {
  fetchConcurrency: number
  maxDailyEnergyDays: number
  /** Upper bound on wallet transactions paged through. Defaults to 5000. */
  maxWalletTransactions?: number
  now?: () => Date
}

interface DayWithBlockHashes {
  date: Date
  blockHashes: string[]
}

const ADDRESS_PAGE_SIZE = 50
const DEFAULT_MAX_WALLET_TRANSACTIONS = 5_000

function toEnergyKwh(sizeBytes: number): number {
  // The expected mathematical result has two decimal places because 4.56 does.
  return Number((sizeBytes * ENERGY_KWH_PER_BYTE).toFixed(2))
}

function sumTransactionBytes(
  transactions: readonly BlockchainTransaction[],
): number {
  return transactions.reduce((total, transaction) => total + transaction.size, 0)
}

function toTransactionEnergy(
  transaction: BlockchainTransaction,
): TransactionEnergy {
  return {
    hash: transaction.hash,
    sizeBytes: transaction.size,
    energyKwh: toEnergyKwh(transaction.size),
  }
}

export class EnergyService {
  private readonly now: () => Date
  private readonly maxWalletTransactions: number

  public constructor(
    private readonly blockchainClient: BlockchainClient,
    private readonly options: EnergyServiceOptions,
  ) {
    if (
      !Number.isInteger(options.fetchConcurrency) ||
      options.fetchConcurrency <= 0
    ) {
      throw new Error('fetchConcurrency must be a positive integer')
    }

    if (
      !Number.isInteger(options.maxDailyEnergyDays) ||
      options.maxDailyEnergyDays <= 0
    ) {
      throw new Error('maxDailyEnergyDays must be a positive integer')
    }

    this.maxWalletTransactions =
      options.maxWalletTransactions ?? DEFAULT_MAX_WALLET_TRANSACTIONS

    if (
      !Number.isInteger(this.maxWalletTransactions) ||
      this.maxWalletTransactions <= 0
    ) {
      throw new Error('maxWalletTransactions must be a positive integer')
    }

    this.now = options.now ?? (() => new Date())
  }

  public async getBlockEnergy(
    blockIdentifier: string,
  ): Promise<BlockEnergy> {
    const normalizedIdentifier = blockIdentifier.trim()

    if (normalizedIdentifier.length === 0) {
      throw new InputValidationError('blockIdentifier cannot be empty')
    }

    const block = await this.blockchainClient.getBlock(normalizedIdentifier)
    const totalSizeBytes = sumTransactionBytes(block.transactions)

    return {
      blockHash: block.hash,
      blockHeight: block.height,
      transactionCount: block.transactions.length,
      totalSizeBytes,
      totalEnergyKwh: toEnergyKwh(totalSizeBytes),
      transactions: block.transactions.map(toTransactionEnergy),
    }
  }

  public async getDailyEnergy(
    days: number,
    includeToday = true,
  ): Promise<DailyEnergy[]> {
    this.validateDays(days)

    const today = startOfUtcDay(this.now())
    const endDate = includeToday ? today : addUtcDays(today, -1)
    const dates = Array.from({ length: days }, (_, index) =>
      addUtcDays(endDate, index - days + 1),
    )

    // First load the small block lists. These calls are cheap and bounded.
    const daysWithBlocks = await mapWithConcurrency(
      dates,
      Math.min(4, this.options.fetchConcurrency),
      async (date): Promise<DayWithBlockHashes> => {
        const startSeconds = date.getTime() / 1000
        const endSeconds = addUtcDays(date, 1).getTime() / 1000
        const blockSummaries = await this.blockchainClient.getBlocksForDay(date)

        const blockHashes = [
          ...new Set(
            blockSummaries
              .filter(
                (block) =>
                  // Exclude orphaned/stale blocks so a reorg day does not
                  // double-count transactions.
                  block.mainChain &&
                  block.time >= startSeconds &&
                  block.time < endSeconds,
              )
              .map((block) => block.hash),
          ),
        ]

        return { date, blockHashes }
      },
    )

    // Load every distinct raw block only once across the whole request.
    const uniqueBlockHashes = [
      ...new Set(daysWithBlocks.flatMap((day) => day.blockHashes)),
    ]
    const blocks = await mapWithConcurrency(
      uniqueBlockHashes,
      this.options.fetchConcurrency,
      (blockHash) => this.blockchainClient.getBlock(blockHash),
    )
    const blocksByHash = new Map(
      blocks.map((block) => [block.hash, block] as const),
    )

    return daysWithBlocks.map(({ date, blockHashes }) => {
      const dayBlocks = blockHashes
        .map((hash) => blocksByHash.get(hash))
        .filter((block): block is BlockchainBlock => block !== undefined)
      const transactionCount = dayBlocks.reduce(
        (total, block) => total + block.transactions.length,
        0,
      )
      const totalSizeBytes = dayBlocks.reduce(
        (total, block) => total + sumTransactionBytes(block.transactions),
        0,
      )

      return {
        date: formatUtcDate(date),
        isComplete: date.getTime() < today.getTime(),
        blockCount: dayBlocks.length,
        transactionCount,
        totalSizeBytes,
        totalEnergyKwh: toEnergyKwh(totalSizeBytes),
      }
    })
  }

  public async getWalletEnergy(address: string): Promise<WalletEnergy> {
    
    const normalizedAddress = address.trim()

    if (normalizedAddress.length === 0 || normalizedAddress.length > 120) {
      throw new InputValidationError(
        'address must contain between 1 and 120 characters',
      )
    }

    const firstPage = await this.blockchainClient.getAddressPage(
      normalizedAddress,
      0,
      ADDRESS_PAGE_SIZE,
    )
    const totalTransactionCount = firstPage.transactionCount

    // Never page past the configured cap: a busy address (exchange, pool) can
    // have hundreds of thousands of transactions, which would otherwise fan out
    // into thousands of requests, time out, or get rate-limited.
    const targetCount = Math.min(totalTransactionCount, this.maxWalletTransactions)
    const pageCount = Math.ceil(targetCount / ADDRESS_PAGE_SIZE)
    const remainingOffsets = Array.from(
      { length: Math.max(0, pageCount - 1) },
      (_, index) => (index + 1) * ADDRESS_PAGE_SIZE,
    )
    const remainingPages = await mapWithConcurrency(
      remainingOffsets,
      Math.min(4, this.options.fetchConcurrency),
      (offset) =>
        this.blockchainClient.getAddressPage(
          normalizedAddress,
          offset,
          ADDRESS_PAGE_SIZE,
        ),
    )

    // Deduplication protects against page shifts if the address changes mid-request.
    const transactionsByHash = new Map<string, BlockchainTransaction>()

    for (const page of [firstPage, ...remainingPages]) {
      for (const transaction of page.transactions) {
        transactionsByHash.set(transaction.hash, transaction)
      }
    }

    const transactions = [...transactionsByHash.values()]
    const totalSizeBytes = sumTransactionBytes(transactions)

    return {
      address: firstPage.address,
      transactionCount: transactions.length,
      totalTransactionCount,
      totalSizeBytes,
      totalEnergyKwh: toEnergyKwh(totalSizeBytes),
      isComplete: totalTransactionCount <= this.maxWalletTransactions,
    }
  }

  private validateDays(days: number): void {
    if (!Number.isInteger(days)) {
      throw new InputValidationError('days must be an integer')
    }

    if (days < 1 || days > this.options.maxDailyEnergyDays) {
      throw new InputValidationError(
        `days must be between 1 and ${this.options.maxDailyEnergyDays}`,
      )
    }
  }
}
