import {
  bearerAuth,
  StreamableHTTPTransport,
  simpleMcpAuthRouter,
} from "@hono/mcp";
import { Hono } from "hono";
import { cors } from "hono/cors";
import mcp from "./mcp.ts";

// Platform-agnostic environment variable access
// Works with both Node.js (process.env) and Deno (Deno.env) 
const getEnv = (key: string): string | undefined => {
  if (typeof process !== "undefined" && process.env) return process.env[key];
  if (typeof Deno !== "undefined" && Deno.env) return Deno.env.get(key);
  return undefined;
};

const SUPABASE_URL = getEnv("SUPABASE_URL");
const BASE_HOST = SUPABASE_URL ? new URL(SUPABASE_URL).host : "";
const BASE_PATH = SUPABASE_URL ? "/functions/v1/postgrest-mcp" : "";

// Auth server URL: use explicit env var, or construct from SUPABASE_URL
const AUTH_SERVER_URL = getEnv("AUTH_SERVER_URL") || 
  (SUPABASE_URL ? `${new URL(SUPABASE_URL).origin}/auth/v1` : "");

const app = new Hono().use(
  cors({
    origin: (origin) => origin,
    credentials: true,
  }),
);

const transport = new StreamableHTTPTransport();

app.all(
  "/mcp",
  bearerAuth({
    verifyToken: (token: string) => {
      return !!token;  // PostGREST request will verify token
    },
    // The correct option name for customizing missing-auth responses
    noAuthenticationHeader: {
      wwwAuthenticateHeader: (c) => {
        const protocol = c.req.header("x-forwarded-proto") || "https";
        let host = c.req.header("x-forwarded-host") || c.req.header("host");
        if ((BASE_HOST)) host = BASE_HOST;
        const metadataUrl = `${protocol}://${host}${BASE_PATH}/.well-known/oauth-protected-resource`;

        // This challenge is what triggers Claude to fetch your metadata
        return `Bearer realm="mcp", resource_metadata="${metadataUrl}"`;
      }
    }
  }),
  async (c) => {
    console.log(mcp.isConnected() ? "MCP connected" : "MCP not connected");

    if (!mcp.isConnected()) {
      await mcp.connect(transport);
    }
    return transport.handleRequest(c);
  }
);


// OAuth protected resource metadata handler
const oauthMetadataHandler = (c: any) => {
  const url = new URL(c.req.url);
  const protocol = c.req.header("x-forwarded-proto") || url.protocol.slice(0, -1);
  let host = c.req.header("x-forwarded-host") || c.req.header("host") || url.host;
  if ((BASE_HOST)) host = BASE_HOST;

  const resource = `${protocol}://${host}${BASE_PATH}`;
  return c.json({
    resource,
    authorization_servers: AUTH_SERVER_URL ? [AUTH_SERVER_URL] : [],
    bearer_methods_supported: ["header"]
  });
};

// OAuth protected resource metadata (public endpoints)
app.get(`${BASE_PATH}/.well-known/oauth-protected-resource`, oauthMetadataHandler);
app.get("/.well-known/oauth-protected-resource", oauthMetadataHandler);

// Root endpoint for health check
app.get("/", (c) => {
  return c.json({
    status: "ok",
    message: "MCP OAuth Server",
    endpoints: {
      mcp: "/mcp",
      metadata: `${BASE_HOST}${BASE_PATH}/.well-known/oauth-protected-resource`
    }
  });
});

// Catch-all route for 404
app.all("*", (c) => {
  console.log(`404 - Route not found: ${c.req.url}`);
  return c.json({ error: "Not Found", path: c.req.path }, 404);
});

export default app;
