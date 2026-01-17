import type { Tool } from '../../types.ts'
import { makePostgrestRequest } from '../utils/postgrest.ts'

const inputSchema = {}

export const getCurrentUserTool: Tool<typeof inputSchema, undefined> = {
  name: 'getCurrentUser',
  options: {
    title: 'Get Current User',
    description: 'Retrieves comprehensive profile information for the authenticated user, including email, roles, permissions, accessible modules, and user metadata',
    inputSchema,
  },
  handler: async (_, { authInfo }) => {
    try {
      const result = await makePostgrestRequest({
        path: '/rpc/get_userinfo',
        method: 'POST',
        body: '{}',
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
      console.error('getCurrentUser failed:', error)
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
