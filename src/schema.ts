import { GraphQLError } from 'graphql'
import { SchemaComposer } from 'graphql-compose'
import { TtlCache } from './cache/ttlCache'
import { HttpBlockchainClient } from './clients/blockchainClient'
import { config } from './config'
import { BlockchainApiError, InputValidationError } from './errors'
import { EnergyService } from './services/energyService'

const schemaComposer = new SchemaComposer()

schemaComposer.createObjectTC({
  name: 'TransactionEnergy',
  fields: {
    hash: 'String!',
    sizeBytes: 'Int!',
    energyKwh: 'Float!',
  },
})

schemaComposer.createObjectTC({
  name: 'BlockEnergy',
  fields: {
    blockHash: 'String!',
    blockHeight: 'Int!',
    transactionCount: 'Int!',
    totalSizeBytes: 'Int!',
    totalEnergyKwh: 'Float!',
    transactions: '[TransactionEnergy!]!',
  },
})

schemaComposer.createObjectTC({
  name: 'DailyEnergy',
  fields: {
    date: 'String!',
    isComplete: 'Boolean!',
    blockCount: 'Int!',
    transactionCount: 'Int!',
    totalSizeBytes: 'Float!',
    totalEnergyKwh: 'Float!',
  },
})

schemaComposer.createObjectTC({
  name: 'WalletEnergy',
  fields: {
    address: 'String!',
    transactionCount: 'Int!',
    totalTransactionCount: 'Int!',
    totalSizeBytes: 'Float!',
    totalEnergyKwh: 'Float!',
    isComplete: 'Boolean!',
  },
})

const cache = new TtlCache(config.blockchainCacheMaxEntries)
const blockchainClient = new HttpBlockchainClient({
  baseUrl: config.blockchainApiBaseUrl,
  timeoutMs: config.blockchainApiTimeoutMs,
  cache,
  maxAttempts: config.blockchainMaxAttempts,
  retryBaseDelayMs: config.blockchainRetryBaseDelayMs,
})
const energyService = new EnergyService(blockchainClient, {
  fetchConcurrency: config.blockchainFetchConcurrency,
  maxDailyEnergyDays: config.maxDailyEnergyDays,
  maxWalletTransactions: config.maxWalletTransactions,
})

function graphQLError(error: unknown): GraphQLError {
  if (
    error instanceof InputValidationError ||
    error instanceof BlockchainApiError
  ) {
    // Positional signature: (message, nodes, source, positions, path, originalError, extensions).
    // This project pins graphql v15, which only supports this form.
    return new GraphQLError(
      error.message,
      undefined,
      undefined,
      undefined,
      undefined,
      error,
      { code: error.code },
    )
  }

  return new GraphQLError(
    'Unexpected server error',
    undefined,
    undefined,
    undefined,
    undefined,
    error instanceof Error ? error : undefined,
    { code: 'INTERNAL_SERVER_ERROR' },
  )
}

schemaComposer.Query.addFields({
  hello: {
    type: 'String!',
    resolve: () => 'Bitcoin energy API is ready',
  },
  blockEnergy: {
    type: 'BlockEnergy!',
    description:
      'Returns the energy used by every transaction in one Bitcoin block.',
    args: {
      blockIdentifier: {
        type: 'String!',
        description: 'A block hash or an identifier accepted by rawblock.',
      },
    },
    resolve: async (_source, args: { blockIdentifier: string }) => {
      try {
        return await energyService.getBlockEnergy(args.blockIdentifier)
      } catch (error) {
        throw graphQLError(error)
      }
    },
  },
  dailyEnergy: {
    type: '[DailyEnergy!]!',
    description:
      'Returns daily transaction energy totals in chronological UTC order.',
    args: {
      days: 'Int!',
      includeToday: {
        type: 'Boolean',
        defaultValue: true,
        description:
          'When true, the final item is the current, incomplete UTC day.',
      },
    },
    resolve: async (
      _source,
      args: { days: number; includeToday?: boolean },
    ) => {
      try {
        return await energyService.getDailyEnergy(
          args.days,
          args.includeToday ?? true,
        )
      } catch (error) {
        throw graphQLError(error)
      }
    },
  },
  walletEnergy: {
    type: 'WalletEnergy!',
    description:
      'Returns the total energy of all unique transactions involving a wallet. ' +
      'For very large wallets the result is capped; isComplete is then false.',
    args: {
      address: 'String!',
    },
    resolve: async (_source, args: { address: string }) => {
      try {
        return await energyService.getWalletEnergy(args.address)
      } catch (error) {
        throw graphQLError(error)
      }
    },
  },
})

export const schema = schemaComposer.buildSchema()
