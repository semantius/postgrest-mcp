# Hono OAuth MCP Server

This is a Hono-based MCP (Model Context Protocol) server that works with any MCP-compliant OAuth2 server for authentication. The server is configured for deployment to:
- Supabase Edge Functions
- Cloudflare Workers
- Deno Deploy

## Environment Variables

### `AUTH_SERVER_URL`
OAuth authorization server URL. Required for Cloudflare Workers and Deno Deploy deployments.

**Optional when deployed as a Supabase Edge Function** - will be auto-constructed from the automatically available `SUPABASE_URL` environment variable.

Example: `https://jdnlvjebzatlybaysdcp.supabase.co/auth/v1`

## Supabase Edge Functions

This server supports MCP authentication from the Supabase OAuth2 server.

**Environment**: When deployed as a Supabase Edge Function, the `SUPABASE_URL` environment variable is automatically available. The server will auto-construct the `AUTH_SERVER_URL` from it (as `{origin}/auth/v1`), so no additional environment configuration is needed.

### Prerequisites
Supabase CLI should be installed. If needed, install it as a dependency:
```bash
# Install as dev dependency
pnpm add -D supabase
```

### Development
```bash
supabase functions serve
```

### Deployment
First, link your project (one-time setup):
```bash
supabase link --project-ref <your-project-ref>
```
*Note: Find your project ref in your Supabase dashboard URL: `https://supabase.com/dashboard/project/<your-project-ref>` or in Project Settings > General > Reference ID*

Then deploy the function:
```bash
supabase functions deploy postgrest-mcp
```

Or deploy all functions:
```bash
supabase functions deploy
```

> **Note on MCP Inspector Compatibility (January 2026):**
> The MCP Inspector is not yet compliant with RFC 9728 and does not properly handle the `resource_metadata` parameter in WWW-Authenticate headers. This causes issues when the OAuth metadata endpoint is served at an uncommon path like `/functions/v1/mcp-oauth/.well-known/oauth-protected-resource`. Claude Desktop and Claude Web handle this correctly and will successfully discover the metadata endpoint. See [Inspector issue #576](https://github.com/modelcontextprotocol/inspector/issues/576) for details.

## Cloudflare Workers

### Development
```bash
pnpm cloudflare:dev
```

### Deployment
```bash
pnpm cloudflare:deploy
```

## Deno 

### Prerequisites
Install Deno:
```bash
# macOS/Linux
curl -fsSL https://deno.land/install.sh | sh

# Windows
irm https://deno.land/install.ps1 | iex
```

### Development
```bash
pnpm deno:dev
# or directly with deno
deno task dev
```

### Deployment 

First, create a new app (one-time setup):
```bash
deno deploy create --org=<your-org>
```

```bash
# Deploy to production
pnpm deno:deploy
# or directly with deno
deno task deploy

```
