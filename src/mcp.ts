import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

const mcpServer = new McpServer({
  name: "my-mcp-server",
  version: "1.0.0",
});

mcpServer.registerTool(
  "greet",
  {
    title: "Greet User",
    description: "A simple greeting tool",
    inputSchema: { name: z.string().describe("Name to greet") },
  },
  ({ name }) => {
    return { content: [{ type: "text", text: `Hello, ${name}!` }] };
  }
);

export default mcpServer;
