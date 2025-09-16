// Run with: npx tsx src/examples/server/toolWithRequirementsServer.ts

import { McpServer } from "../../server/mcp.js";
import { StdioServerTransport } from "../../server/stdio.js";
import { z } from "zod";

const mcpServer = new McpServer({
  name: "tools-with-requirements-server",
  version: "1.0.0",
});

// Tool that uses LLM sampling to summarize any text
// This tool demonstrates the new 'requires' field specification
mcpServer.registerTool(
  "summarize",
  {
    description: "Summarize any text using an LLM",
    inputSchema: {
      text: z.string().describe("Text to summarize"),
    },
    requires: [
      { type: "capability", name: "mcp:sampling" }
    ],
  },
  async ({ text }) => {
    // Call the LLM through MCP sampling
    const response = await mcpServer.server.createMessage({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please summarize the following text concisely:\n\n${text}`,
          },
        },
      ],
      maxTokens: 500,
    });

    return {
      content: [
        {
          type: "text",
          text: response.content.type === "text" ? response.content.text : "Unable to generate summary",
        },
      ],
    };
  }
);

// Tool that demonstrates complex requirements including permissions and capabilities
mcpServer.registerTool(
  "imageGenerator",
  {
    description: "Edits the baseImage (if provided) or generates an image, stores resulting image into the server-hosted image repository, then returns a reference to the resulting image.",
    inputSchema: {
      baseImage: z.string().optional().describe("Image that the generation will be based on"),
      imageRepo: z.string().describe("Path to server-hosted cloud storage for generated images"),
      prompt: z.string().describe("Prompt for transforming or generating the base image into the desired output image"),
    },
    outputSchema: {
      imageReference: z.string().describe("Reference to the generated image in the repository"),
      metadata: z.object({
        size: z.string(),
        format: z.string(),
        generatedAt: z.string(),
      }).describe("Metadata about the generated image"),
    },
    requires: [
      { type: "capability", name: "mcp:sampling" },
      { 
        anyOf: [
          { type: "permission", subType: "claim", name: "role", value: "admin" },
          { type: "permission", subType: "claim", name: "role", value: "owner" },
          { type: "permission", subType: "input", property: "imageRepo", value: "write" }
        ]
      },
      { type: "permission", subType: "scope", value: "agent:sample_image" },
      { type: "permission", subType: "scope", value: "write:sample_storage" }
    ],
  },
  async ({ baseImage, imageRepo, prompt }) => {
    // Simulate image generation
    const imageReference = `${imageRepo}/generated_${Date.now()}.jpg`;
    
    return {
      content: [
        {
          type: "text",
          text: `Generated image based on prompt: "${prompt}". ${baseImage ? `Used base image for editing.` : 'Created new image.'} Stored at: ${imageReference}`,
        },
      ],
      structuredContent: {
        imageReference,
        metadata: {
          size: "1024x1024",
          format: "JPEG",
          generatedAt: new Date().toISOString(),
        },
      },
    };
  }
);

// Tool that requires only basic capabilities
mcpServer.registerTool(
  "basicCalculator",
  {
    description: "Performs basic arithmetic calculations",
    inputSchema: {
      operation: z.enum(["add", "subtract", "multiply", "divide"]).describe("The arithmetic operation to perform"),
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    },
    outputSchema: {
      result: z.number().describe("The result of the calculation"),
      operation: z.string().describe("The operation that was performed"),
    },
    // This tool has no special requirements - it can run in any environment
    requires: [],
  },
  async ({ operation, a, b }) => {
    let result: number;
    
    switch (operation) {
      case "add":
        result = a + b;
        break;
      case "subtract":
        result = a - b;
        break;
      case "multiply":
        result = a * b;
        break;
      case "divide":
        if (b === 0) {
          throw new Error("Division by zero is not allowed");
        }
        result = a / b;
        break;
    }

    return {
      content: [
        {
          type: "text",
          text: `${a} ${operation} ${b} = ${result}`,
        },
      ],
      structuredContent: {
        result,
        operation: `${a} ${operation} ${b}`,
      },
    };
  }
);

// Tool that requires specific scopes but DOESN'T declare them (demonstrates the problem)
mcpServer.registerTool(
  "legacyFileManager",
  {
    description: "Legacy file management tool that requires file system access but doesn't declare requirements",
    inputSchema: {
      action: z.enum(["read", "write", "delete"]).describe("File operation to perform"),
      path: z.string().describe("File path"),
      content: z.string().optional().describe("Content to write (for write action)"),
    },
    outputSchema: {
      success: z.boolean().describe("Whether the operation succeeded"),
      message: z.string().describe("Result message"),
      content: z.string().optional().describe("File content (for read action)"),
    },
    // NO requires field - this is the old way that leads to runtime failures
  },
  async ({ action, path, content }) => {
    // Simulate checking for required scopes at runtime
    // In a real implementation, this would check actual permissions
    const hasFileSystemScope = false; // Simulate missing scope
    
    if (!hasFileSystemScope) {
      throw new Error("Missing required scope 'filesystem:access' - this failure could have been prevented with proper requirements declaration!");
    }

    // Simulate file operations
    switch (action) {
      case "read":
        return {
          content: [
            {
              type: "text",
              text: `Read file: ${path}`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Successfully read ${path}`,
            content: "File content here...",
          },
        };
      case "write":
        return {
          content: [
            {
              type: "text",
              text: `Wrote to file: ${path}`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Successfully wrote to ${path}`,
          },
        };
      case "delete":
        return {
          content: [
            {
              type: "text",
              text: `Deleted file: ${path}`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Successfully deleted ${path}`,
          },
        };
    }
  }
);

// Tool that requires the same scopes but DOES declare them (demonstrates the solution)
mcpServer.registerTool(
  "modernFileManager",
  {
    description: "Modern file management tool that properly declares its requirements",
    inputSchema: {
      action: z.enum(["read", "write", "delete"]).describe("File operation to perform"),
      path: z.string().describe("File path"),
      content: z.string().optional().describe("Content to write (for write action)"),
    },
    outputSchema: {
      success: z.boolean().describe("Whether the operation succeeded"),
      message: z.string().describe("Result message"),
      content: z.string().optional().describe("File content (for read action)"),
    },
    requires: [
      { type: "permission", subType: "scope", value: "filesystem:access" },
      { 
        anyOf: [
          { type: "permission", subType: "input", property: "action", value: "read" },
          { type: "permission", subType: "scope", value: "filesystem:write" }
        ]
      }
    ],
  },
  async ({ action, path, content }) => {
    // With proper requirements declaration, we know the client has the right scopes
    // so we can proceed with confidence
    
    switch (action) {
      case "read":
        return {
          content: [
            {
              type: "text",
              text: `Read file: ${path}`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Successfully read ${path}`,
            content: "File content here...",
          },
        };
      case "write":
        return {
          content: [
            {
              type: "text",
              text: `Wrote to file: ${path}`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Successfully wrote to ${path}`,
          },
        };
      case "delete":
        return {
          content: [
            {
              type: "text",
              text: `Deleted file: ${path}`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Successfully deleted ${path}`,
          },
        };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.log("MCP server with requirements is running...");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});