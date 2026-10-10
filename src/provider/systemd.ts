/**
 * MCP providers may be launched without login-shell DBus variables.
 * systemctl --user still needs an address for the owning user's bus.
 */
export function systemdUserEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (process.platform !== 'linux' || typeof process.getuid !== 'function') return { ...env };
    const runtime = env.XDG_RUNTIME_DIR || '/run/user/' + process.getuid();
    return {
        ...env,
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || 'unix:path=' + runtime + '/bus'
    };
}
