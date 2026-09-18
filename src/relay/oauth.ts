import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
    OAuthClientInformationFull,
    OAuthTokenRevocationRequest,
    OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { renderAuthorizationPage } from './oauth-page.js';

type AuthorizationRecord = {
    client: OAuthClientInformationFull;
    params: AuthorizationParams;
    expiresAt: number;
};

type TokenRecord = {
    token: string;
    clientId: string;
    scopes: string[];
    expiresAt: number;
    resource?: URL;
};

type PersistedTokenRecord = Omit<TokenRecord, 'resource'> & {
    resource?: string;
};

type PersistedOAuthState = {
    version: 1;
    clients: OAuthClientInformationFull[];
    accessTokens: PersistedTokenRecord[];
    refreshTokens: PersistedTokenRecord[];
};

class MemoryClientsStore implements OAuthRegisteredClientsStore {
    private readonly clients = new Map<string, OAuthClientInformationFull>();

    constructor(private readonly onChange: () => void = () => {}) { }

    restore(clients: OAuthClientInformationFull[]): void {
        this.clients.clear();
        for (const client of clients) {
            if (client.client_id) this.clients.set(client.client_id, client);
        }
    }

    snapshot(): OAuthClientInformationFull[] {
        return [...this.clients.values()];
    }

    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
        return this.clients.get(clientId);
    }

    async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
        const registered = client as OAuthClientInformationFull;
        if (!registered.client_id) throw new InvalidRequestError('client_id was not generated');
        this.clients.set(registered.client_id, registered);
        this.onChange();
        return registered;
    }
}

function secureEqual(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
    readonly clientsStore: MemoryClientsStore;
    private readonly pending = new Map<string, AuthorizationRecord>();
    private readonly codes = new Map<string, AuthorizationRecord>();
    private readonly accessTokens = new Map<string, TokenRecord>();
    private readonly refreshTokens = new Map<string, TokenRecord>();

    constructor(
        private readonly ownerSecret: string,
        private readonly expectedResource: URL,
        private readonly statePath?: string
    ) {
        this.clientsStore = new MemoryClientsStore(() => this.saveState());
        this.loadState();
    }

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: any): Promise<void> {
        if (!client.redirect_uris.includes(params.redirectUri)) {
            throw new InvalidRequestError('Unregistered redirect_uri');
        }
        if (params.resource && params.resource.toString() !== this.expectedResource.toString()) {
            throw new InvalidRequestError('Invalid resource');
        }
        const requestId = randomUUID();
        this.pending.set(requestId, { client, params, expiresAt: Date.now() + 5 * 60_000 });
        res.set({
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY'
        });
        res.status(200).type('html').send(renderAuthorizationPage({
            clientName: client.client_name || client.client_id,
            requestId,
            resource: this.expectedResource,
            scopes: params.scopes || []
        }));
    }

    approve(requestId: string, ownerSecret: string): string {
        const record = this.pending.get(requestId);
        if (!record || record.expiresAt < Date.now()) {
            this.pending.delete(requestId);
            throw new InvalidGrantError('Authorization request expired or does not exist');
        }
        if (!secureEqual(ownerSecret, this.ownerSecret)) {
            throw new InvalidGrantError('Invalid owner secret');
        }
        this.pending.delete(requestId);
        const code = randomBytes(32).toString('base64url');
        this.codes.set(code, { ...record, expiresAt: Date.now() + 5 * 60_000 });
        const redirect = new URL(record.params.redirectUri);
        redirect.searchParams.set('code', code);
        if (record.params.state !== undefined) redirect.searchParams.set('state', record.params.state);
        return redirect.toString();
    }

    async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
        const record = this.validCode(client, authorizationCode);
        return record.params.codeChallenge;
    }

    async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
        _codeVerifier?: string,
        redirectUri?: string,
        resource?: URL
    ): Promise<OAuthTokens> {
        const record = this.validCode(client, authorizationCode);
        if (redirectUri && redirectUri !== record.params.redirectUri) throw new InvalidGrantError('redirect_uri mismatch');
        this.assertResource(resource ?? record.params.resource);
        this.codes.delete(authorizationCode);
        return this.issueTokens(client.client_id, record.params.scopes || [], resource ?? record.params.resource);
    }

    async exchangeRefreshToken(
        client: OAuthClientInformationFull,
        refreshToken: string,
        scopes?: string[],
        resource?: URL
    ): Promise<OAuthTokens> {
        const record = this.refreshTokens.get(refreshToken);
        if (!record || record.clientId !== client.client_id || record.expiresAt < Date.now()) {
            this.refreshTokens.delete(refreshToken);
            this.saveState();
            throw new InvalidGrantError('Invalid or expired refresh token');
        }
        this.assertResource(resource ?? record.resource);
        const requestedScopes = scopes ?? record.scopes;
        if (requestedScopes.some(scope => !record.scopes.includes(scope))) {
            throw new InvalidGrantError('Refresh request widened the granted scope');
        }
        return this.issueTokens(client.client_id, requestedScopes, resource ?? record.resource);
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const record = this.accessTokens.get(token);
        if (!record || record.expiresAt < Date.now()) {
            this.accessTokens.delete(token);
            this.saveState();
            throw new InvalidGrantError('Invalid or expired access token');
        }
        return {
            token,
            clientId: record.clientId,
            scopes: record.scopes,
            expiresAt: Math.floor(record.expiresAt / 1000),
            resource: record.resource
        };
    }

    async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
        this.accessTokens.delete(request.token);
        this.refreshTokens.delete(request.token);
        this.saveState();
    }

    private loadState(): void {
        if (!this.statePath) return;
        try {
            const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as PersistedOAuthState;
            if (parsed.version !== 1) throw new Error('Unsupported OAuth state version');

            this.clientsStore.restore(Array.isArray(parsed.clients) ? parsed.clients : []);
            const now = Date.now();

            for (const record of Array.isArray(parsed.accessTokens) ? parsed.accessTokens : []) {
                if (record.expiresAt <= now) continue;
                this.accessTokens.set(record.token, {
                    ...record,
                    resource: record.resource ? new URL(record.resource) : undefined
                });
            }

            for (const record of Array.isArray(parsed.refreshTokens) ? parsed.refreshTokens : []) {
                if (record.expiresAt <= now) continue;
                this.refreshTokens.set(record.token, {
                    ...record,
                    resource: record.resource ? new URL(record.resource) : undefined
                });
            }
        } catch (error: any) {
            if (error?.code !== 'ENOENT') {
                console.warn('[oauth] Failed to load persisted state:', error?.message || error);
            }
        }
    }

    private saveState(): void {
        if (!this.statePath) return;

        mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
        const encodeToken = (record: TokenRecord): PersistedTokenRecord => ({
            token: record.token,
            clientId: record.clientId,
            scopes: record.scopes,
            expiresAt: record.expiresAt,
            resource: record.resource?.toString()
        });

        const state: PersistedOAuthState = {
            version: 1,
            clients: this.clientsStore.snapshot(),
            accessTokens: [...this.accessTokens.values()].map(encodeToken),
            refreshTokens: [...this.refreshTokens.values()].map(encodeToken)
        };

        const tempPath = `${this.statePath}.${process.pid}.tmp`;
        writeFileSync(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
        chmodSync(tempPath, 0o600);
        renameSync(tempPath, this.statePath);
        chmodSync(this.statePath, 0o600);
    }

    private validCode(client: OAuthClientInformationFull, authorizationCode: string): AuthorizationRecord {
        const record = this.codes.get(authorizationCode);
        if (!record || record.expiresAt < Date.now()) {
            this.codes.delete(authorizationCode);
            throw new InvalidGrantError('Invalid or expired authorization code');
        }
        if (record.client.client_id !== client.client_id) throw new InvalidGrantError('Authorization code belongs to another client');
        return record;
    }

    private assertResource(resource?: URL): void {
        if (resource && resource.toString() !== this.expectedResource.toString()) {
            throw new InvalidGrantError('Invalid resource');
        }
    }

    private issueTokens(clientId: string, scopes: string[], resource?: URL): OAuthTokens {
        const accessToken = randomBytes(32).toString('base64url');
        const refreshToken = randomBytes(32).toString('base64url');
        this.accessTokens.set(accessToken, {
            token: accessToken, clientId, scopes, expiresAt: Date.now() + 60 * 60_000, resource
        });
        this.refreshTokens.set(refreshToken, {
            token: refreshToken, clientId, scopes, expiresAt: Date.now() + 30 * 24 * 60 * 60_000, resource
        });
        this.saveState();
        return {
            access_token: accessToken,
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: refreshToken,
            scope: scopes.join(' ')
        };
    }
}
