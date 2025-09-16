// OAuth server using the proper in-memory provider for demonstration
import { DemoInMemoryAuthProvider } from './demoInMemoryOAuthProvider.js';
import { OAuthMetadata } from '../../shared/auth.js';
import express from 'express';
import { mcpAuthRouter, createOAuthMetadata } from '../../server/auth/router.js';

class SimpleOAuthServer {
    private oauthMetadata: OAuthMetadata | null = null;
    private provider: DemoInMemoryAuthProvider;
    private app = express();
    private server: import('http').Server | null = null;

    constructor(private port: number = 3001) {
        this.provider = new DemoInMemoryAuthProvider();
        this.setupRoutes();
    }

    private setupRoutes() {
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));

        const authServerUrl = new URL(`http://localhost:${this.port}`);

        // Add OAuth routes
        this.app.use(mcpAuthRouter({
            provider: this.provider,
            issuerUrl: authServerUrl,
            scopesSupported: ['user:read', 'admin:users:delete', 'accounts:read', 'accounts:write'],
        }));

        // Add introspection endpoint
        this.app.post('/introspect', async (req, res) => {
            try {
                const { token } = req.body;
                if (!token) {
                    res.status(400).json({ error: 'Token is required' });
                    return;
                }

                const tokenInfo = await this.provider.verifyAccessToken(token);
                res.json({
                    active: true,
                    client_id: tokenInfo.clientId,
                    scope: tokenInfo.scopes.join(' '),
                    exp: tokenInfo.expiresAt,
                    aud: tokenInfo.resource,
                });
            } catch (error) {
                res.status(401).json({
                    active: false,
                    error: 'Unauthorized',
                    error_description: `Invalid token: ${error}`
                });
            }
        });
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const authServerUrl = new URL(`http://localhost:${this.port}`);

            // Create OAuth metadata
            this.oauthMetadata = createOAuthMetadata({
                provider: this.provider,
                issuerUrl: authServerUrl,
                scopesSupported: ['user:read', 'admin:users:delete', 'accounts:read', 'accounts:write'],
            });

            this.oauthMetadata.introspection_endpoint = new URL("/introspect", authServerUrl).href;

            this.server = this.app.listen(this.port, (error?: Error) => {
                if (error) {
                    reject(error);
                    return;
                }
                console.log(`🔐 OAuth Server running on http://localhost:${this.port}`);
                resolve();
            });

            this.server.on('error', (error: NodeJS.ErrnoException) => {
                if (error.code === 'EADDRINUSE') {
                    // Try up to 10 different ports
                    if (this.port < 3020) {
                        console.log(`⚠️  Port ${this.port} is busy, trying port ${this.port + 1}...`);
                        this.port = this.port + 1;
                        this.server = null; // Reset server reference
                        // Retry with next port
                        setTimeout(() => {
                            this.start().then(resolve).catch(reject);
                        }, 100);
                    } else {
                        reject(new Error('Could not find available port after trying 3010-3020'));
                    }
                } else {
                    reject(error);
                }
            });
        });
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    console.log(`🔐 OAuth Server stopped`);
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    getOAuthMetadata(): OAuthMetadata | null {
        return this.oauthMetadata;
    }

    getProvider(): DemoInMemoryAuthProvider {
        return this.provider;
    }
}

// Export for use in other modules
// To run directly: npx tsx src/examples/server/oauthServer.ts

export { SimpleOAuthServer };