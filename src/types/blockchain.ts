export interface BlockchainTransaction {
  hash: string
  size: number
}

export interface BlockchainBlock {
  hash: string
  height: number
  time: number
  size: number
  transactionCount: number
  transactions: BlockchainTransaction[]
}

export interface BlockchainBlockSummary {
  hash: string
  height: number
  time: number
  /**
   * True when this block is part of the canonical (main) chain.
   * blockchain.info's /blocks/{day} endpoint also returns orphaned/stale
   * blocks (main_chain: false); those must be excluded from daily totals,
   * otherwise a reorg day double-counts transactions.
   */
  mainChain: boolean
}

export interface BlockchainAddressPage {
  address: string
  transactionCount: number
  transactions: BlockchainTransaction[]
}

export interface BlockchainClient {
  getBlock(blockIdentifier: string): Promise<BlockchainBlock>
  getBlocksForDay(date: Date): Promise<BlockchainBlockSummary[]>
  getAddressPage(
    address: string,
    offset: number,
    limit: number,
  ): Promise<BlockchainAddressPage>
}
