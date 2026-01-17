// Supabase Edge Function entry point
import { Hono } from "hono";
import app from "../../../src/index.ts";

// Get the function name from the URL path
const FUNCTION_NAME = "postgrest-mcp"; // Change this if you rename the function

// Create a wrapper that strips the function name from the path
const wrapper = new Hono();

// Mount the main app at the root, but handle path rewriting
wrapper.all("*", (c) => {
  // Rewrite the path to remove /postgrest-mcp prefix if present
  const originalPath = c.req.path;
  const cleanPath = originalPath.replace(new RegExp(`^/${FUNCTION_NAME}`), '') || '/';
  
  // Create a new request with the cleaned path
  const url = new URL(c.req.url);
  url.pathname = cleanPath;
  
  const newRequest = new Request(url.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  });
  
  return app.fetch(newRequest, c.env);
});

Deno.serve(wrapper.fetch);
