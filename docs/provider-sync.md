# Desktop Commander provider synchronization

Quota proxies the tools exported by Desktop Commander. Its updater maintains the default
npm provider (not the standalone Desktop Commander app or its remote service).

## Commands

```bash
npm run --silent update -- --check       # Latest stable release, read-only
npm run --silent update                  # Canary-test and stage an upgrade
npm run --silent update -- --apply       # Canary-test, restart and verify
npm run --silent rollback -- --apply     # Revert to previous tested version
npm run --silent updates -- enable       # Enable daily Linux systemd timer
npm run --silent updates -- status
npm run --silent updates -- disable
```

The updater tracks active and previous versions in `~/.quota/provider.json`
(or `$QUOTA_CONFIG_DIR/provider.json`). On each newer candidate, Quota
launches both versions over MCP, validates the reported version, runs
a read-only file smoke test, and rejects candidates missing any previously
available tool. Only passing versions can be promoted.

Activation uses `systemctl --user restart quota.service`, checks the version
through the authenticated MCP relay, and restores the previous version if
the new provider fails verification. Staging without `--apply` does not
restart the current connection. The optional timer runs at 04:00 local time
daily, with up to 15 minutes randomized delay. It is disabled until enabled.

**Tradeoffs:** Switching providers briefly interrupts remote requests, and
commands whose execution status is uncertain must not be blindly replayed.
Automatic rollback is best-effort and cannot recover an unreachable host.
Use an independent terminal for first deployment. The updater runs new
upstream npm packages with the user's permissions; enable unattended
updates only when you trust the upstream publisher.

Provider synchronization does not proxy MCP UI resources or clone upstream
application-level features. Custom providers are not managed by this updater.
