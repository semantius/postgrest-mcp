import type { Tool } from '../../types.ts'
import { z } from 'zod/v4'

const inputSchema = {
  message: z.string(),
}

export const echoTool: Tool<typeof inputSchema, undefined> = {
  name: 'echo',
  options: {
    title: 'Echo Tool',
    description: 'Echoes back the provided message and displays authentication info',
    inputSchema,
  },
  handler: async ({ message }, { authInfo, request }) => {
    const authData = authInfo ? JSON.stringify(authInfo, null, 2) : 'No auth info available'
    const requestData = request ? JSON.stringify(request, null, 2) : 'No request info available'
    
    return {
      content: [
        { type: 'text', text: `Tool echo: ${message}` },
        { type: 'text', text: `\n\nAuthentication Info:\n${authData}` },
        { type: 'text', text: `\n\nRequest Info:\n${requestData}` },
      ],
    }
  },
}
