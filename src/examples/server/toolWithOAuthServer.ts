// Run with: npx tsx src/examples/server/toolWithOAuthServer.ts

import { McpServer } from "../../server/mcp.js";
import { StdioServerTransport } from "../../server/stdio.js";
import { z } from "zod";
import { SimpleOAuthServer } from "./oauthServer.js";

// Start OAuth server on a different port to avoid conflicts
const oauthServer = new SimpleOAuthServer(3010);

const mcpServer = new McpServer({
  name: "tools-with-oauth-server",
  version: "1.0.0",
});

// Simulate current client scopes
let currentScopes: string[] = [];

// Helper to check if client has required scope
function hasScope(requiredScope: string): boolean {
  return currentScopes.includes(requiredScope);
}

// Tool that requires basic read scope (initially available)
mcpServer.registerTool(
  "readUserProfile",
  {
    description: "Read user profile information",
    inputSchema: {
      userId: z.string().describe("User ID to read profile for"),
    },
    requires: [
      {
        type: "permission",
        subType: "scope",
        value: "user:read"
      }
    ]
  },
  async ({ userId }) => {
    if (!hasScope("user:read")) {
      return {
        content: [
          {
            type: "text",
            text: "❌ Access denied: Missing required scope 'user:read'",
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `✅ User Profile for ${userId}:\n- Name: John Doe\n- Email: john@example.com\n- Role: User`,
        },
      ],
    };
  }
);

// Tool that requires admin scope (not initially available)
mcpServer.registerTool(
  "deleteUser",
  {
    description: "Delete a user account (requires admin privileges)",
    inputSchema: {
      userId: z.string().describe("User ID to delete"),
    },
    requires: [
      {
        type: "permission",
        subType: "scope",
        value: "admin:users:delete"
      }
    ]
  },
  async ({ userId }) => {
    if (!hasScope("admin:users:delete")) {
      return {
        content: [
          {
            type: "text",
            text: "❌ Access denied: Missing required scope 'admin:users:delete'",
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `✅ User ${userId} has been deleted successfully`,
        },
      ],
    };
  }
);

// Tool that requires multiple scopes
mcpServer.registerTool(
  "transferFunds",
  {
    description: "Transfer funds between accounts",
    inputSchema: {
      fromAccount: z.string().describe("Source account ID"),
      toAccount: z.string().describe("Destination account ID"),
      amount: z.number().describe("Amount to transfer"),
    },
    requires: [
      {
        allOf: [
          {
            type: "permission",
            subType: "scope",
            value: "accounts:read"
          },
          {
            type: "permission",
            subType: "scope",
            value: "accounts:write"
          }
        ]
      }
    ]
  },
  async ({ fromAccount, toAccount, amount }) => {
    if (!hasScope("accounts:read") || !hasScope("accounts:write")) {
      const missingScopes: string[] = [];
      if (!hasScope("accounts:read")) missingScopes.push("accounts:read");
      if (!hasScope("accounts:write")) missingScopes.push("accounts:write");
      
      return {
        content: [
          {
            type: "text",
            text: `❌ Access denied: Missing required scopes: ${missingScopes.join(', ')}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `✅ Transferred $${amount} from ${fromAccount} to ${toAccount}`,
        },
      ],
    };
  }
);

// Add a special method to update client scopes (for demo purposes)
mcpServer.registerTool(
  "_updateClientScopes",
  {
    description: "Internal: Update client OAuth scopes",
    inputSchema: {
      scopes: z.array(z.string()).describe("New scopes to set"),
    },
  },
  async ({ scopes }) => {
    currentScopes = scopes;
    console.log(`🔄 Client scopes updated: ${scopes.join(', ')}`);
    
    return {
      content: [
        {
          type: "text",
          text: `OAuth scopes updated: ${scopes.join(', ')}`,
        },
      ],
    };
  }
);

async function main() {
  // Start OAuth server first
  await oauthServer.start();
  
  // Initialize with basic scopes
  currentScopes = ["user:read"];
  console.log(`🔑 Server initialized with client scopes: ${currentScopes.join(', ')}`);
  
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.log("MCP server with OAuth is running...");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});