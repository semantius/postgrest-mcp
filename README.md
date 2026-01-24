# PostgREST MCP Server

A complete PostgREST MCP (Model Context Protocol) server that uses OAuth2 for authentication. Works with any PostgREST server. Currently tested with NEON and Supabase.

Built with [Hono](https://hono.dev/) and supports Streamable HTTP.

## Deployment Options

The server can be deployed to:
- **Supabase Edge Functions** - default configuration is auto-detected
- **Cloudflare Workers** - requires environment variable configuration
- **Deno Deploy** - requires environment variable configuration

When deployed to Supabase, the server automatically detects the PostgREST API endpoint and authentication configuration. For other providers (NEON, custom PostgREST servers), environment variables need to be configured.

## Environment Variables

### `AUTH_SERVER_URL`
OAuth authorization server URL. Required for Cloudflare Workers and Deno Deploy deployments.

**Optional when deployed as a Supabase Edge Function** - will be auto-constructed from the automatically available `SUPABASE_URL` environment variable as `{origin}/auth/v1`.

Example: `https://jdnlvjebzatlybaysdcp.supabase.co/auth/v1`

### `API_BASE_URL`
PostgREST server URL for making API requests.

**Optional when `SUPABASE_URL` is set** - will be auto-constructed as `{origin}/rest/v1` from the `SUPABASE_URL`. Set this variable to override the auto-constructed URL.

Example: `https://jdnlvjebzatlybaysdcp.supabase.co/rest/v1`

### `API_KEY`
API key sent in the `apikey` header for PostgREST requests.

**Takes precedence over `SUPABASE_ANON_KEY`** when both are set. Use this to override the Supabase anonymous key with a custom API key.

Example: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

### `SUPABASE_ANON_KEY`
Supabase anonymous key used as the `apikey` header for PostgREST requests when `API_KEY` is not provided.

**Automatically available when deployed as a Supabase Edge Function**. For local development or non-Supabase deployments, you need to set this manually.

Example: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

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
deno task supabase:dev
```

The MCP endpoint will be available at: `http://localhost:54321/functions/v1/postgrest-mcp/mcp`

### Deployment
First, link your project (one-time setup):
```bash
supabase link --project-ref <your-project-ref>
```
*Note: Find your project ref in your Supabase dashboard URL: `https://supabase.com/dashboard/project/<your-project-ref>` or in Project Settings > General > Reference ID*

Then deploy the function:
```bash
deno task supabase:deploy
```

The MCP endpoint will be available at: `https://<your-project-ref>.supabase.co/functions/v1/postgrest-mcp/mcp`

> **Note on MCP Inspector Compatibility (January 2026):**
> The MCP Inspector is not yet compliant with RFC 9728 and does not properly handle the `resource_metadata` parameter in WWW-Authenticate headers. This causes issues when the OAuth metadata endpoint is served at an uncommon path like `/functions/v1/postgrest-mcp/.well-known/oauth-protected-resource`. Claude Desktop and Claude Web handle this correctly and will successfully discover the metadata endpoint. See [Inspector issue #576](https://github.com/modelcontextprotocol/inspector/issues/576) for details.

## Cloudflare Workers

### Development
```bash
pnpm cloudflare:dev
```

The MCP endpoint will be available at: `http://localhost:3000/mcp`

### Deployment
```bash
pnpm cloudflare:deploy
```

The MCP endpoint will be available at: `https://<your-worker>.workers.dev/mcp`

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

The MCP endpoint will be available at: `http://localhost:8000/mcp`

### Deployment 

First, create a new project (one-time setup):
```bash
deno deploy create --org=<your-org>
```

Then deploy:
```bash
deno task deploy
```

The MCP endpoint will be available at: `https://<your-project>.deno.dev/mcp`

## Webhook Receiver

The server includes a webhook receiver endpoint at `POST /hook/:id` that validates, deduplicates, and processes incoming webhooks.

### Features
- **HMAC signature validation** using standard webhook format (`webhook-id.webhook-timestamp.body`)
- **Idempotency checking** prevents duplicate processing
- **Dynamic data insertion** based on table metadata from `tables` and `fields` tables
- **RLS bypass** via Kysely direct database access (requires `DATABASE_URL` with service role credentials)
- **Comprehensive logging** in `webhook_receiver_logs` table

### Configuration
Set the `DATABASE_URL` environment variable with a connection string that has permissions to bypass RLS:
```bash
DATABASE_URL=postgresql://postgres:[PASSWORD]@[HOST]/[DATABASE]
```

### Usage
See `tests/TESTING.md` for detailed test scenarios and setup instructions.

## Credits

This implementation is based on [supabase-mcp](https://github.com/supabase-community/supabase-mcp/tree/main/packages/mcp-server-postgrest).
