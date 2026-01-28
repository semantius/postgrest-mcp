import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'
import { makePostgrestRequest } from '../utils/postgrest.ts'

const inputSchema = {
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method'),
  path: z.string().describe('PostgREST API path (e.g., /users, /posts?userId=eq.1)'),
  body: z
    .union([
      z.record(z.string(), z.unknown()),
      z.array(z.record(z.string(), z.unknown())),
    ])
    .optional()
    .describe('Request body for POST/PUT/PATCH requests'),
}

export const postgrestRequestTool: Tool<typeof inputSchema, undefined> = {
  name: 'postgrestRequest',
  options: {
    title: 'PostgREST Request',
    description: 'Performs an HTTP request against the PostgREST API',
    inputSchema,
  },
  handler: async ({ method, path, body }, { authInfo }) => {
    try {
      const result = await makePostgrestRequest({
        path,
        method,
        body,
        token: authInfo?.token,
      })

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    }
    catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message || 'Request failed'}`,
          },
        ],
        isError: true,
      }
    }
  },
}
