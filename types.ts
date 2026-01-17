import type { z } from 'zod/v4'

export interface RequestContext {
  authInfo?: {
    token?: string
    [key: string]: any
  }
  request?: {
    method: string
    url: string
    headers: Record<string, string>
    query: Record<string, string>
    body?: any
  }
}

export interface Tool<
  TInputSchema extends Record<string, z.ZodTypeAny>,
  TEnv = undefined
> {
  name: string
  options: {
    title: string
    description: string
    inputSchema: TInputSchema
  }
  handler: (
    input: { [K in keyof TInputSchema]: z.infer<TInputSchema[K]> },
    context: RequestContext
  ) => Promise<{
    content: Array<{ type: string; text: string }>
    isError?: boolean
  }>
}
