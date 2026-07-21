import { InputValidationError } from '../errors'
import type {
  BlockchainAddressPage,
  BlockchainBlock,
  BlockchainBlockSummary,
  BlockchainClient,
} from '../types/blockchain'
import { EnergyService } from './energyService'

class FakeBlockchainClient implements BlockchainClient {
  public blocks = new Map<string, BlockchainBlock>()
  public dayBlocks = new Map<string, BlockchainBlockSummary[]>()
  public addressPages = new Map<number, BlockchainAddressPage>()
  public requestedBlocks: string[] = []

  public async getBlock(blockIdentifier: string): Promise<BlockchainBlock> {
    this.requestedBlocks.push(blockIdentifier)
    const block = this.blocks.get(blockIdentifier)

    if (block === undefined) {
      throw new Error(`Missing block ${blockIdentifier}`)
    }

    return block
  }

  public async getBlocksForDay(date: Date): Promise<BlockchainBlockSummary[]> {
    return this.dayBlocks.get(date.toISOString().slice(0, 10)) ?? []
  }

  public async getAddressPage(
    _address: string,
    offset: number,
  ): Promise<BlockchainAddressPage> {
    const page = this.addressPages.get(offset)

    if (page === undefined) {
      throw new Error(`Missing page ${offset}`)
    }

    return page
  }
}

function block(
  hash: string,
  height: number,
  time: number,
  transactions: Array<{ hash: string; size: number }>,
): BlockchainBlock {
  return {
    hash,
    height,
    time,
    size: transactions.reduce((total, tx) => total + tx.size, 0),
    transactionCount: transactions.length,
    transactions,
  }
}

function summary(
  hash: string,
  height: number,
  time: number,
  mainChain = true,
): BlockchainBlockSummary {
  return { hash, height, time, mainChain }
}

function makeService(
  client: FakeBlockchainClient,
  overrides: Partial<{
    maxDailyEnergyDays: number
    maxWalletTransactions: number
    now: () => Date
  }> = {},
): EnergyService {
  return new EnergyService(client, {
    fetchConcurrency: 2,
    maxDailyEnergyDays: overrides.maxDailyEnergyDays ?? 30,
    maxWalletTransactions: overrides.maxWalletTransactions,
    now: overrides.now,
  })
}

describe('EnergyService', () => {
  describe('getBlockEnergy', () => {
    it('calculates transaction and block energy', async () => {
      const client = new FakeBlockchainClient()
      client.blocks.set(
        'block-1',
        block('block-1', 10, 1, [
          { hash: 'tx-1', size: 100 },
          { hash: 'tx-2', size: 50 },
        ]),
      )

      await expect(makeService(client).getBlockEnergy('block-1')).resolves.toEqual({
        blockHash: 'block-1',
        blockHeight: 10,
        transactionCount: 2,
        totalSizeBytes: 150,
        totalEnergyKwh: 684,
        transactions: [
          { hash: 'tx-1', sizeBytes: 100, energyKwh: 456 },
          { hash: 'tx-2', sizeBytes: 50, energyKwh: 228 },
        ],
      })
    })

    it('trims the identifier before fetching', async () => {
      const client = new FakeBlockchainClient()
      client.blocks.set('abc', block('abc', 1, 1, [{ hash: 't', size: 1 }]))

      await makeService(client).getBlockEnergy('  abc  ')
      expect(client.requestedBlocks).toEqual(['abc'])
    })

    it('rejects an empty or whitespace identifier', async () => {
      const client = new FakeBlockchainClient()

      await expect(
        makeService(client).getBlockEnergy('   '),
      ).rejects.toBeInstanceOf(InputValidationError)
      expect(client.requestedBlocks).toEqual([])
    })
  })

  describe('getDailyEnergy', () => {
    it('returns daily totals in chronological order and fetches each block once', async () => {
      const client = new FakeBlockchainClient()
      const jan1 = Date.UTC(2026, 0, 1) / 1000
      const jan2 = Date.UTC(2026, 0, 2) / 1000
      client.dayBlocks.set('2026-01-01', [summary('block-a', 1, jan1 + 100)])
      client.dayBlocks.set('2026-01-02', [summary('block-b', 2, jan2 + 100)])
      client.blocks.set(
        'block-a',
        block('block-a', 1, jan1 + 100, [{ hash: 'tx-a', size: 10 }]),
      )
      client.blocks.set(
        'block-b',
        block('block-b', 2, jan2 + 100, [{ hash: 'tx-b', size: 20 }]),
      )
      const service = makeService(client, {
        now: () => new Date('2026-01-02T12:00:00.000Z'),
      })

      await expect(service.getDailyEnergy(2, true)).resolves.toEqual([
        {
          date: '2026-01-01',
          isComplete: true,
          blockCount: 1,
          transactionCount: 1,
          totalSizeBytes: 10,
          totalEnergyKwh: 45.6,
        },
        {
          date: '2026-01-02',
          isComplete: false,
          blockCount: 1,
          transactionCount: 1,
          totalSizeBytes: 20,
          totalEnergyKwh: 91.2,
        },
      ])
      expect(client.requestedBlocks.sort()).toEqual(['block-a', 'block-b'])
    })

    it('excludes today when includeToday is false, and marks all days complete', async () => {
      const client = new FakeBlockchainClient()
      const jan1 = Date.UTC(2026, 0, 1) / 1000
      client.dayBlocks.set('2026-01-01', [summary('block-a', 1, jan1 + 100)])
      client.blocks.set(
        'block-a',
        block('block-a', 1, jan1 + 100, [{ hash: 'tx-a', size: 10 }]),
      )
      const service = makeService(client, {
        now: () => new Date('2026-01-02T12:00:00.000Z'),
      })

      const result = await service.getDailyEnergy(1, false)
      expect(result).toEqual([
        {
          date: '2026-01-01',
          isComplete: true,
          blockCount: 1,
          transactionCount: 1,
          totalSizeBytes: 10,
          totalEnergyKwh: 45.6,
        },
      ])
    })

    it('returns zeroed totals for a day with no blocks', async () => {
      const client = new FakeBlockchainClient()
      const service = makeService(client, {
        now: () => new Date('2026-01-02T12:00:00.000Z'),
      })

      const result = await service.getDailyEnergy(1, false)
      expect(result).toEqual([
        {
          date: '2026-01-01',
          isComplete: true,
          blockCount: 0,
          transactionCount: 0,
          totalSizeBytes: 0,
          totalEnergyKwh: 0,
        },
      ])
    })

    it('ignores blocks whose timestamp falls outside the UTC day', async () => {
      const client = new FakeBlockchainClient()
      const jan1Start = Date.UTC(2026, 0, 1) / 1000
      const jan2Start = Date.UTC(2026, 0, 2) / 1000
      client.dayBlocks.set('2026-01-01', [
        summary('in-day', 1, jan1Start + 100),
        // Exactly at the next-day boundary: must be excluded (< endSeconds).
        summary('boundary', 2, jan2Start),
      ])
      client.blocks.set(
        'in-day',
        block('in-day', 1, jan1Start + 100, [{ hash: 'tx-a', size: 10 }]),
      )
      client.blocks.set(
        'boundary',
        block('boundary', 2, jan2Start, [{ hash: 'tx-b', size: 999 }]),
      )
      const service = makeService(client, {
        now: () => new Date('2026-01-02T12:00:00.000Z'),
      })

      const [day] = await service.getDailyEnergy(1, false)
      expect(day.blockCount).toBe(1)
      expect(day.totalSizeBytes).toBe(10)
      expect(client.requestedBlocks).toEqual(['in-day'])
    })

    it('ignores orphaned (non-main-chain) blocks in daily totals', async () => {
      const client = new FakeBlockchainClient()
      const jan1 = Date.UTC(2026, 0, 1) / 1000
      client.dayBlocks.set('2026-01-01', [
        summary('main-block', 1, jan1 + 100, true),
        summary('orphan-block', 1, jan1 + 110, false),
      ])
      client.blocks.set(
        'main-block',
        block('main-block', 1, jan1 + 100, [{ hash: 'tx-a', size: 10 }]),
      )
      client.blocks.set(
        'orphan-block',
        block('orphan-block', 1, jan1 + 110, [{ hash: 'tx-orphan', size: 999 }]),
      )
      const service = makeService(client, {
        now: () => new Date('2026-01-02T12:00:00.000Z'),
      })

      const result = await service.getDailyEnergy(1, false)
      expect(result).toEqual([
        {
          date: '2026-01-01',
          isComplete: true,
          blockCount: 1,
          transactionCount: 1,
          totalSizeBytes: 10,
          totalEnergyKwh: 45.6,
        },
      ])
      expect(client.requestedBlocks).toEqual(['main-block'])
    })

    it('rejects days that are non-integer, below 1, or above the max', async () => {
      const client = new FakeBlockchainClient()
      const service = makeService(client, { maxDailyEnergyDays: 30 })

      await expect(service.getDailyEnergy(0)).rejects.toBeInstanceOf(
        InputValidationError,
      )
      await expect(service.getDailyEnergy(1.5)).rejects.toBeInstanceOf(
        InputValidationError,
      )
      await expect(service.getDailyEnergy(31)).rejects.toBeInstanceOf(
        InputValidationError,
      )
    })
  })

  describe('getWalletEnergy', () => {
    it('paginates wallet transactions and removes duplicates', async () => {
      const client = new FakeBlockchainClient()
      client.addressPages.set(0, {
        address: 'wallet',
        transactionCount: 51,
        transactions: [
          { hash: 'tx-1', size: 10 },
          { hash: 'tx-2', size: 20 },
        ],
      })
      client.addressPages.set(50, {
        address: 'wallet',
        transactionCount: 51,
        transactions: [
          { hash: 'tx-2', size: 20 },
          { hash: 'tx-3', size: 30 },
        ],
      })

      await expect(makeService(client).getWalletEnergy('wallet')).resolves.toEqual({
        address: 'wallet',
        transactionCount: 3,
        totalTransactionCount: 51,
        totalSizeBytes: 60,
        totalEnergyKwh: 273.6,
        isComplete: true,
      })
    })

    it('caps very large wallets and flags the result as incomplete', async () => {
      const client = new FakeBlockchainClient()
      client.addressPages.set(0, {
        address: 'whale',
        transactionCount: 100,
        transactions: [
          { hash: 'tx-1', size: 10 },
          { hash: 'tx-2', size: 20 },
        ],
      })
      const service = makeService(client, { maxWalletTransactions: 2 })

      await expect(service.getWalletEnergy('whale')).resolves.toEqual({
        address: 'whale',
        transactionCount: 2,
        totalTransactionCount: 100,
        totalSizeBytes: 30,
        totalEnergyKwh: 136.8,
        isComplete: false,
      })
    })

    it('rejects an empty or over-long address', async () => {
      const client = new FakeBlockchainClient()

      await expect(
        makeService(client).getWalletEnergy('   '),
      ).rejects.toBeInstanceOf(InputValidationError)
      await expect(
        makeService(client).getWalletEnergy('x'.repeat(121)),
      ).rejects.toBeInstanceOf(InputValidationError)
    })
  })
})
