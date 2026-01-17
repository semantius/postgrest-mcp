import app from "./index.ts";

// Deno Deploy entry point
Deno.serve({ port: 3000 }, app.fetch);
