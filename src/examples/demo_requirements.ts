#!/usr/bin/env node

// Sequential demo script for Tool Execution Requirements implementation
// run with e.g.: `timeout 30s npx tsx src/examples/demo_requirements.ts`
import { spawn, ChildProcess } from 'child_process';
import {
    JSONRPCResponseSchema,
    JSONRPCErrorSchema,
    ListToolsResultSchema,
    RequirementSchema,
    InitializeResultSchema
} from '../types.js';
import type {
    JSONRPCResponse,
    JSONRPCError,
    ListToolsResult,
    InitializeResult,
    Tool,
    Requirement,
    RequestId
} from '../types.js';

// Constants
const TIMEOUTS = {
    STEP_DELAY: 100,
    DEMO_TIMEOUT: 10000,
    TOOL_CALL_DELAY: 500
} as const;

const SEPARATORS = {
    MAIN: '='.repeat(70),
    SUB: '='.repeat(50),
    TOOLS: '='.repeat(60)
} as const;

// Global cleanup
const activeProcesses: ChildProcess[] = [];

function cleanup(): void {
    console.log('\n🧹 Cleaning up active processes...');
    activeProcesses.forEach(proc => {
        if (proc && !proc.killed) {
            proc.kill('SIGTERM');
        }
    });
}

// Setup cleanup handlers
(['SIGINT', 'SIGTERM'] as const).forEach(event => {
    process.on(event, () => {
        cleanup();
        process.exit(0);
    });
});

// Validation helpers
const validators = {
    jsonrpc: (data: unknown): JSONRPCResponse => {
        const validated = JSONRPCResponseSchema.parse(data);
        console.log('✅ JSON-RPC response validated successfully');
        return validated;
    },

    error: (data: unknown): JSONRPCError => {
        const validated = JSONRPCErrorSchema.parse(data);
        console.log('✅ JSON-RPC error response validated successfully');
        return validated;
    },

    tools: (data: unknown): ListToolsResult => {
        const validated = ListToolsResultSchema.parse(data);
        console.log('✅ Tools list result validated successfully using schemas');
        return validated;
    },

    init: (data: unknown): InitializeResult => {
        const validated = InitializeResultSchema.parse(data);
        console.log('✅ Initialize result validated successfully');
        return validated;
    },

    requirement: (req: unknown): Requirement => RequirementSchema.parse(req)
};

// Display helpers
const display = {
    header: (title: string, icon: string): void => {
        console.log(`\n${SEPARATORS.MAIN}`);
        console.log(`${icon} ${title}`);
        console.log(SEPARATORS.MAIN);
    },

    subHeader: (title: string): void => {
        console.log(`\n${SEPARATORS.SUB}`);
        console.log(title);
        console.log(SEPARATORS.SUB);
    },

    requirement: (req: Requirement | undefined, indent = '     '): void => {
        if (!req) return;

        const prefix = indent.slice(0, -2) + '- ';

        if ('type' in req && req.type === 'capability') {
            console.log(`${prefix}Capability: ${req.name}`);
        } else if ('type' in req && req.type === 'permission') {
            console.log(`${prefix}Permission: ${req.subType}`);
            const details: Record<string, () => void> = {
                scope: () => console.log(`${indent}  value: ${req.value}`),
                claim: () => console.log(`${indent}  name: ${req.name}\n${indent}  value: ${req.value}`),
                resource: () => console.log(`${indent}  uri: ${req.uri}\n${indent}  value: ${req.value}`),
                input: () => {
                    if (req.property) console.log(`${indent}  property: ${req.property}`);
                    console.log(`${indent}  value: ${req.value}`);
                }
            };
            details[req.subType]?.();
        } else if ('anyOf' in req) {
            console.log(`${prefix}Any of:`);
            req.anyOf.forEach(subReq => display.requirement(subReq as Requirement, indent + '    '));
        } else if ('allOf' in req) {
            console.log(`${prefix}All of:`);
            req.allOf.forEach(subReq => display.requirement(subReq as Requirement, indent + '    '));
        } else if ('not' in req) {
            console.log(`${prefix}Not:`);
            display.requirement(req.not as Requirement, indent + '  ');
        } else {
            console.log(`${prefix}Unknown requirement type:`, req);
        }
    },

    tool: (tool: Tool, index: number): void => {
        console.log(`\n${index + 1}. Tool: ${tool.name}`);
        console.log(`   Description: ${tool.description || 'No description'}`);

        if (tool.requires?.length && tool.requires.length > 0) {
            console.log('   Requirements:');
            tool.requires.forEach(req => {
                const validatedReq = validators.requirement(req);
                display.requirement(validatedReq, '       ');
            });
        } else {
            console.log('   Requirements: None (can run in any environment)');
        }

        if (tool.inputSchema?.properties) {
            console.log('   Input Parameters:');
            Object.entries(tool.inputSchema.properties).forEach(([param, schema]) => {
                const required = tool.inputSchema.required?.includes(param) ? ' (required)' : ' (optional)';
                const schemaObj = schema as { type?: string; description?: string };
                console.log(`     - ${param}: ${schemaObj.type}${required}`);
                if (schemaObj.description) {
                    console.log(`       ${schemaObj.description}`);
                }
            });
        }
    }
};

// JSON-RPC message factory
interface JSONRPCMessage {
    jsonrpc: "2.0";
    id?: RequestId;
    method?: string;
    params?: Record<string, unknown>;
}

const createMessage = {
    init: (clientName: string, capabilities: Record<string, unknown> = {}): JSONRPCMessage => ({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-06-18",
            capabilities,
            clientInfo: { name: clientName, version: "1.0.0" }
        }
    }),

    initialized: (): JSONRPCMessage => ({
        jsonrpc: "2.0",
        method: "notifications/initialized"
    }),

    toolsList: (): JSONRPCMessage => ({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list"
    }),

    toolCall: (name: string, args: Record<string, unknown>, id: RequestId = 3): JSONRPCMessage => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args }
    })
};

// Promise-based server handler
class ServerHandler {
    private serverPath: string;
    private demoName: string;
    private buffer = '';
    private handlers = new Map<RequestId | string, (response: unknown) => void>();
    private server: ChildProcess | null = null;

    constructor(serverPath: string, demoName: string) {
        this.serverPath = serverPath;
        this.demoName = demoName;
    }

    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = spawn('npx', ['tsx', this.serverPath], {
                stdio: ['pipe', 'pipe', 'inherit']
            });

            activeProcesses.push(this.server);

            this.server.stdout?.on('data', (data) => this.handleData(data));
            this.server.on('error', (error) => {
                reject(new Error(`${this.demoName} server error: ${error.message}`));
            });

            // Give server time to start
            setTimeout(() => resolve(), 500);
        });
    }

    private handleData(data: Buffer): void {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                this.processLine(line);
            }
        }
    }

    private processLine(line: string): void {
        try {
            const rawResponse = JSON.parse(line);

            // Try to validate as success response first
            let validatedResponse: unknown;
            try {
                validatedResponse = validators.jsonrpc(rawResponse);
            } catch {
                try {
                    validatedResponse = validators.error(rawResponse);
                } catch {
                    // Handle special cases or treat as raw response
                    validatedResponse = rawResponse;
                }
            }

            // Route to appropriate handler
            const responseObj = validatedResponse as { id?: RequestId; method?: string };
            const handler = this.handlers.get(responseObj.id || responseObj.method || '');
            if (handler) {
                handler(validatedResponse);
            }

        } catch (e) {
            // Ignore JSON parse errors (incomplete messages)
            if (!(e instanceof SyntaxError)) {
                console.error(`Error processing response: ${(e as Error).message}`);
            }
        }
    }

    send(message: JSONRPCMessage): this {
        if (this.server?.stdin) {
            this.server.stdin.write(JSON.stringify(message) + '\n');
        }
        return this;
    }

    onResponse(id: RequestId | string, handler: (response: unknown) => void): this {
        this.handlers.set(id, handler);
        return this;
    }

    async waitForResponse(id: RequestId | string, timeout: number = TIMEOUTS.DEMO_TIMEOUT): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Timeout waiting for response ${id}`));
            }, timeout);

            this.onResponse(id, (response) => {
                clearTimeout(timer);
                resolve(response);
            });
        });
    }

    kill(): void {
        if (this.server && !this.server.killed) {
            this.server.kill('SIGTERM');
        }
    }
}

// Sequential demo implementations
async function runErrorDemo(): Promise<void> {
    display.header('DEMONSTRATION 1: The Problem Without Requirements', '🚨');
    console.log('Testing with a client that does NOT support sampling...\n');

    const handler = new ServerHandler('src/examples/server/toolWithSampleServer.ts', 'error');

    try {
        await handler.start();

        // Initialize
        console.log('📡 Sending initialize request (without sampling capability)...');
        handler.send(createMessage.init('no-sampling-client'));

        const initResponse = await handler.waitForResponse(1) as { result: unknown };
        const initResult = validators.init(initResponse.result);
        console.log('✅ Initialize response received');
        console.log(`   Protocol version: ${initResult.protocolVersion}`);
        console.log(`   Server: ${initResult.serverInfo.name} v${initResult.serverInfo.version}`);
        console.log('   Client capabilities: None (no sampling support)\n');

        // Send initialized notification
        console.log('✅ Sending initialized notification...');
        handler.send(createMessage.initialized());
        await new Promise(resolve => setTimeout(resolve, TIMEOUTS.STEP_DELAY));

        // Get tools list
        console.log('📋 Requesting tools list...\n');
        handler.send(createMessage.toolsList());

        const toolsResponse = await handler.waitForResponse(2) as { result: unknown };
        const toolsResult = validators.tools(toolsResponse.result);

        console.log('🛠️  Available Tools:');
        console.log(SEPARATORS.SUB);

        toolsResult.tools.forEach((tool, index) => {
            console.log(`\n${index + 1}. Tool: ${tool.name}`);
            console.log(`   Description: ${tool.description || 'No description'}`);
            console.log('   Requirements: None declared');
        });

        display.subHeader('🔍 PROBLEM DEMONSTRATION');

        const summarizeTool = toolsResult.tools.find(tool => tool.name === 'summarize');
        if (summarizeTool) {
            console.log(`\n⚠️  Tool "${summarizeTool.name}" has NO requirements declared:`);
            console.log('   - Tool actually needs: mcp:sampling capability');
            console.log('   - Tool declares: No requirements');
            console.log('   - Client supports: No sampling');
            console.log('   - Problem: Client cannot know this tool will fail!');
            console.log('\n🚨 Attempting to call the tool anyway...');

            await new Promise(resolve => setTimeout(resolve, TIMEOUTS.TOOL_CALL_DELAY));

            console.log('📞 Calling summarize tool...');
            handler.send(createMessage.toolCall('summarize', {
                text: "This is a sample text that needs to be summarized using an LLM."
            }));

            // Handle sampling request or error
            handler.onResponse('sampling/createMessage', () => {
                console.log('\n🔍 Server is requesting sampling from client:');
                console.log('   Method: sampling/createMessage');
                console.log('   Problem: Client does not support sampling capability');
                console.log('   Result: Request will fail - no response handler available');
                console.log('\n❌ This is the exact error that requirements metadata prevents!');

                showProblemSummary();
            });

            // Wait for either success or failure
            try {
                await handler.waitForResponse(3, 3000);
            } catch {
                console.log('\n📋 No response received from tool call (request failed)');
                console.log('❌ This demonstrates the runtime failure that occurs when:');
                console.log('   - Tool requires sampling capability');
                console.log('   - Client does not support sampling');
                console.log('   - No requirements field to warn about incompatibility');

                showProblemSummary();
            }
        }

    } catch (error) {
        console.error(`❌ Error demo failed: ${(error as Error).message}`);
        throw error;
    } finally {
        handler.kill();
    }
}

function showProblemSummary(): void {
    display.subHeader('🎯 PROBLEM DEMONSTRATED');
    console.log('What happened:');
    console.log('1. Client called tool without checking requirements');
    console.log('2. Tool tried to use sampling (createMessage request)');
    console.log('3. Client cannot handle sampling - no capability declared');
    console.log('4. Request hangs/fails - poor user experience');
    console.log('\nIssues without Requirements Metadata:');
    console.log('• Runtime errors occur when capabilities are missing');
    console.log('• Clients cannot predict which tools will work');
    console.log('• Poor user experience with hanging requests');
    console.log('• No way to filter tools based on client capabilities');
}

async function runRequirementsDemo(): Promise<void> {
    display.header('DEMONSTRATION 2: Requirements Metadata Working Correctly', '✅');
    console.log('Now testing with proper requirements declarations...\n');

    const handler = new ServerHandler('src/examples/server/toolWithRequirementsServer.ts', 'requirements');

    try {
        await handler.start();

        // Initialize
        console.log('📡 Sending initialize request...');
        handler.send(createMessage.init('requirements-demo-client', { sampling: {} }));

        const initResponse = await handler.waitForResponse(1) as { result: unknown };
        const initResult = validators.init(initResponse.result);
        console.log('✅ Initialize response received');
        console.log(`   Protocol version: ${initResult.protocolVersion}`);
        console.log(`   Server: ${initResult.serverInfo.name} v${initResult.serverInfo.version}\n`);

        // Send initialized notification
        console.log('✅ Sending initialized notification...');
        handler.send(createMessage.initialized());
        await new Promise(resolve => setTimeout(resolve, TIMEOUTS.STEP_DELAY));

        // Get tools list
        console.log('📋 Requesting tools list...\n');
        handler.send(createMessage.toolsList());

        const toolsResponse = await handler.waitForResponse(2) as { result: unknown };
        const toolsResult = validators.tools(toolsResponse.result);

        console.log(`\n${SEPARATORS.SUB}\n🛠️  Tools found:\n${SEPARATORS.SUB}`);

        toolsResult.tools.forEach((tool, index) => display.tool(tool, index));

        console.log(`\n${SEPARATORS.SUB}`);
        console.log('\n📊 Summary:');
        console.log(`   - Found ${toolsResult.tools.length} tools`);
        console.log(`   - Tools with requirements: ${toolsResult.tools.filter(t => t.requires?.length && t.requires.length > 0).length}`);
        console.log(`   - Tools without requirements: ${toolsResult.tools.filter(t => !t.requires || t.requires.length === 0).length}`);

        console.log('\n✨ This demonstrates the Tool Execution Requirements Metadata specification');
        console.log('   as described in GitHub issue #1385');
        console.log('   - Schema-based validation: ✅ Always enabled');
        console.log('   - Infinite nesting support: ✅ Enabled');

    } catch (error) {
        console.error(`❌ Requirements demo failed: ${(error as Error).message}`);
        throw error;
    } finally {
        handler.kill();
    }
}

async function runOAuthDemo(): Promise<void> {
    display.header('DEMONSTRATION 3: OAuth Scope Renegotiation Based on Requirements', '🔄');
    console.log('Testing dynamic scope acquisition based on tool requirements...\n');

    const handler = new ServerHandler('src/examples/server/toolWithOAuthServer.ts', 'oauth');

    try {
        await handler.start();

        // Initialize
        console.log('📡 Sending initialize request...');
        handler.send(createMessage.init('oauth-demo-client'));

        const initResponse = await handler.waitForResponse(1) as { result: unknown };
        const initResult = validators.init(initResponse.result);
        console.log('✅ Initialize response received');
        console.log(`   Server: ${initResult.serverInfo.name} v${initResult.serverInfo.version}`);
        console.log('   Client OAuth Scopes: user:read (basic access)\n');

        // Send initialized notification
        console.log('✅ Sending initialized notification...');
        handler.send(createMessage.initialized());
        await new Promise(resolve => setTimeout(resolve, TIMEOUTS.STEP_DELAY));

        // Get tools list
        console.log('📋 Requesting tools list...\n');
        handler.send(createMessage.toolsList());

        const toolsResponse = await handler.waitForResponse(2) as { result: unknown };
        const toolsResult = validators.tools(toolsResponse.result);

        console.log('🛠️  Available Tools with OAuth Requirements:');
        console.log(SEPARATORS.TOOLS);

        let hasRestrictedTools = false;
        toolsResult.tools.forEach((tool, index) => {
            if (tool.name.startsWith('_')) return; // Skip internal tools

            console.log(`\n${index + 1}. Tool: ${tool.name}`);
            console.log(`   Description: ${tool.description}`);

            if (tool.requires?.length && tool.requires.length > 0) {
                console.log('   Requirements:');
                tool.requires.forEach(req => {
                    const validatedReq = validators.requirement(req);
                    display.requirement(validatedReq, '       ');
                });

                const requiresAdminScope = JSON.stringify(tool.requires).includes('admin:users:delete');
                const requiresAccountsScope = JSON.stringify(tool.requires).includes('accounts:');

                if (requiresAdminScope || requiresAccountsScope) {
                    hasRestrictedTools = true;
                    console.log('   ❌ Status: Cannot call - missing required OAuth scopes');
                } else {
                    console.log('   ✅ Status: Can call with current OAuth scopes');
                }
            } else {
                console.log('   Requirements: None');
                console.log('   ✅ Status: Can call (no OAuth requirements)');
            }
        });

        if (hasRestrictedTools) {
            console.log(`\n${SEPARATORS.TOOLS}`);
            console.log('🔍 OAUTH SCOPE ANALYSIS:');
            console.log(SEPARATORS.TOOLS);
            console.log('Current OAuth Scopes: user:read');
            console.log('Required for deleteUser: admin:users:delete');
            console.log('Required for transferFunds: accounts:read, accounts:write');
            console.log('\n🔄 Attempting to call restricted tool to demonstrate scope check...');

            await new Promise(resolve => setTimeout(resolve, 1000));

            // Try calling restricted tool
            console.log('📞 Calling deleteUser tool (should fail due to missing scope)...');
            handler.send(createMessage.toolCall('deleteUser', { userId: "user123" }));

            const failedResponse = await handler.waitForResponse(3) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };
            console.log('\n📋 Tool call response received:');
            if (failedResponse.result?.isError) {
                console.log('❌ Tool call failed as expected:');
                failedResponse.result.content?.forEach(content => {
                    if (content.type === 'text') {
                        console.log(`   ${content.text}`);
                    }
                });

                console.log('\n🔄 Now simulating OAuth scope renegotiation...');
                console.log('   Client detects missing scope from requirements metadata');
                console.log('   Client requests additional OAuth scopes: admin:users:delete');

                await new Promise(resolve => setTimeout(resolve, 1000));

                // Update scopes
                console.log('🔑 Updating OAuth scopes...');
                handler.send(createMessage.toolCall('_updateClientScopes', {
                    scopes: ["user:read", "admin:users:delete"]
                }, 4));

                await handler.waitForResponse(4);
                console.log('\n✅ OAuth scopes updated successfully!');
                console.log('   New scopes: user:read, admin:users:delete');
                console.log('\n🔄 Retrying the tool call with new OAuth scopes...');

                await new Promise(resolve => setTimeout(resolve, 1000));

                // Retry the call
                console.log('📞 Calling deleteUser tool again (should succeed now)...');
                handler.send(createMessage.toolCall('deleteUser', { userId: "user123" }, 5));

                const successResponse = await handler.waitForResponse(5) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };
                console.log('\n📋 Tool call response received:');
                if (successResponse.result && !successResponse.result.isError) {
                    console.log('✅ Tool call succeeded:');
                    successResponse.result.content?.forEach(content => {
                        if (content.type === 'text') {
                            console.log(`   ${content.text}`);
                        }
                    });

                    display.subHeader('🎯 OAUTH RENEGOTIATION DEMONSTRATED');
                    console.log('What happened:');
                    console.log('1. Client listed tools and saw OAuth scope requirements');
                    console.log('2. Client attempted tool call with insufficient scopes');
                    console.log('3. Tool call failed with clear scope error message');
                    console.log('4. Client detected missing scope from requirements metadata');
                    console.log('5. Client renegotiated OAuth to acquire needed scope');
                    console.log('6. Tool call succeeded with proper authorization');
                }
            }
        }

    } catch (error) {
        console.error(`❌ OAuth demo failed: ${(error as Error).message}`);
        throw error;
    } finally {
        handler.kill();
    }
}

// Main execution function
async function main(): Promise<void> {
    console.log('🚀 Testing Tool Execution Requirements Implementation\n');
    console.log('This demo shows three scenarios:');
    console.log('1. 🚨 The PROBLEM: Runtime failures without requirements');
    console.log('2. ✅ The SOLUTION: Requirements metadata working correctly');
    console.log('3. 🔄 ADVANCED: OAuth scope renegotiation based on requirements\n');

    try {
        await runErrorDemo();
        await new Promise(resolve => setTimeout(resolve, 1000));

        await runRequirementsDemo();
        await new Promise(resolve => setTimeout(resolve, 1000));

        await runOAuthDemo();

        display.subHeader('🎉 ALL DEMONSTRATIONS COMPLETE');
        console.log('Key Benefits of Requirements Metadata:');
        console.log('1. 🚨 Prevents runtime errors from capability mismatches');
        console.log('2. ✅ Allows clients to validate compatibility upfront');
        console.log('3. 🔄 Enables dynamic authorization and capability acquisition');
        console.log('4. 📊 Provides clear feedback about tool compatibility');
        console.log('5. 🛡️  Improves security through explicit permission declarations');
        console.log('6. 🔑 Facilitates OAuth scope management and renegotiation');

    } catch (error) {
        console.error('❌ Demo sequence failed:', (error as Error).message);
        process.exit(1);
    } finally {
        cleanup();
        process.exit(0);
    }
}

// Start the demo
main().catch(error => {
    console.error('❌ Fatal error:', (error as Error).message);
    cleanup();
    process.exit(1);
});