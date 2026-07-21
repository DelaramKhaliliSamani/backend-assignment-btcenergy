export class InputValidationError extends Error {
  public readonly code = 'BAD_USER_INPUT'

  public constructor(message: string) {
    super(message)
    this.name = 'InputValidationError'
  }
}

export class BlockchainApiError extends Error {
  public readonly code = 'BLOCKCHAIN_API_ERROR'
  public readonly cause?: unknown

  public constructor(
    message: string,
    public readonly statusCode?: number,
    options?: { cause?: unknown },
  ) {
    super(message)
    this.name = 'BlockchainApiError'
    this.cause = options?.cause
  }
}
