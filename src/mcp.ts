import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { echoTool } from './tools/echo.ts'
import { getCurrentUserTool } from './tools/getCurrentUser.ts'
import { postgrestRequestTool } from './tools/postgrestRequest.ts'
import { sqlToRestTool } from './tools/sqlToRest.ts'


// Define an array of tools to register
const tools = [
  // debug only: echoTool,
  getCurrentUserTool,
  postgrestRequestTool,
  sqlToRestTool,  
]

export function createMcpServer(
  requestContext: {
    method: string
    url: string
    headers: Record<string, string>
    query: Record<string, string>
    body?: any
  },
  authInfo?: {
    token?: string
    [key: string]: any
  }
) {
  const mcpServer = new McpServer({
    name: "PostgREST MCP Server",
    version: "0.1.0",
  });

  for (const tool of tools) {
    // Wrap the handler to inject request context and auth info
    const wrappedHandler = async (input: any, context: any) => {
      return tool.handler(input, {
        ...context,
        request: requestContext,
        authInfo,
      });
    };
    
    mcpServer.registerTool(tool.name, tool.options, wrappedHandler);
  }

  return mcpServer;
}
