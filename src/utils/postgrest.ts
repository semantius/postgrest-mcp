/**
 * Utility for making PostgREST API requests
 */

import { getEnv } from './env.ts'

interface PostgrestRequestOptions {
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: Record<string, unknown> | Array<Record<string, unknown>> | string
  token?: string
  additionalHeaders?: Record<string, string>
}

function getHeaders(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  token?: string,
  additionalHeaders?: Record<string, string>,
): Record<string, string> {
  const apiKey = getEnv('API_KEY') || getEnv('SUPABASE_ANON_KEY')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'prefer': 'return=representation',
    ...additionalHeaders,
  }

  if (token) {
    headers.authorization = `Bearer ${token}`
  }

  // Add API key if configured (API_KEY takes precedence over SUPABASE_ANON_KEY)
  if (apiKey) {
    headers.apikey = apiKey
  }

  return headers
}

/**
 * Makes a request to the PostgREST API
 * @param options - Request options including path, method, body, token
 * @returns An object containing request details, response data, and response headers
 */
export async function makePostgrestRequest(options: PostgrestRequestOptions): Promise<any> {
  const { path, method = 'GET', body, token, additionalHeaders } = options

  const SUPABASE_URL = getEnv('SUPABASE_URL')
  const API_BASE_URL = getEnv('API_BASE_URL') || (SUPABASE_URL ? `${new URL(SUPABASE_URL).origin}/rest/v1` : '')

  if (!API_BASE_URL) {
    throw new Error('API_BASE_URL or SUPABASE_URL must be configured')
  }

  const url = new URL(`${API_BASE_URL}${path}`)

  console.log(`Making ${method} request to PostgREST:`, url.toString())

  const headers = getHeaders(method, token, additionalHeaders)

  const response = await fetch(url, {
    method,
    headers,
    body: body
      ? (typeof body === 'string' ? body : JSON.stringify(body))
      : undefined,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`PostgREST request failed: ${response.status} ${response.statusText} - ${errorText}`)
  }

  const responseData = await response.json()

  // Convert response headers to a plain object
  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })

  return {
    request: {
      method,
      url: url.toString(),
      headers,
      body: body || null,
    },
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data: responseData,
    },
  }
}
