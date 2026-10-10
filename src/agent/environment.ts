/**
 * The provider is a separate, potentially third-party process.
 * Keep normal execution variables (PATH, HOME, user configuration) but never
 * inherit Quota's transport, OAuth, or client authentication secrets.
 *
 * Explicit QUOTA_MCP_ENV_JSON values are a conscious opt-in to the provider.
 */
export function providerEnvironment(
    parent: NodeJS.ProcessEnv,
    explicit: Record<string, string> = {}
): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parent)) {
        if (typeof value !== 'string') continue;
        if (key.startsWith('QUOTA_')) continue;
        env[key] = value;
    }
    return { ...env, ...explicit };
}
