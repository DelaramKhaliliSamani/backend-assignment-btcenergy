/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  clearMocks: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/fn_graphql.ts',
    '!src/schema.ts',
    '!src/**/*.test.ts'
  ]
}
