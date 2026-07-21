import { schema } from './schema'
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda'
import CreateLambdaApi from 'lambda-api'
import { getGraphQLParameters, processRequest } from 'graphql-helix'
import type { API, HandlerFunction } from 'lambda-api'
import type { GraphQLSchema } from 'graphql'

export function APIGatewayLambda(): API {
  const isTest = process.env.NODE_ENV === 'test'
  const isOffline = process.env.IS_OFFLINE === 'true'

  return CreateLambdaApi({
    version: 'v2',
    logger: isTest
      ? false
      : {
          level: isOffline ? 'debug' : 'info',
        },
  })
}

export const graphqlApi = (
  graphQLSchema: GraphQLSchema,
): HandlerFunction => {
  return async function graphqlHandler(req, res): Promise<void> {
    const request = {
      body: req.body,
      headers: req.headers,
      method: req.method,
      query: req.query,
    }
    const { query, variables, operationName } = getGraphQLParameters(request)
    const result = await processRequest({
      schema: graphQLSchema,
      query,
      variables,
      operationName,
      request,
    })

    if (result.type === 'RESPONSE') {
      result.headers.forEach(({ name, value }) => {
        res.header(name, value)
      })
      res.status(result.status)
      res.json(result.payload)
      return
    }

    req.log.error(`Unhandled GraphQL response type: ${result.type}`)
    res.status(501)
    res.json({ errors: [{ message: `Unsupported response type: ${result.type}` }] })
  }
}

export function mkAPIGatewayHandler(api: API): APIGatewayProxyHandlerV2 {
  return async function apiGatewayHandler(event, context) {
    // lambda-api supports the API Gateway event; its public event type is broader.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return api.run(event as any, context)
  }
}

const api = APIGatewayLambda()
api.any('/graphql', graphqlApi(schema))

export const handler: APIGatewayProxyHandlerV2 = mkAPIGatewayHandler(api)
