function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    })[char]!);
}

export type AuthorizationPageInput = {
    clientName: string;
    requestId: string;
    resource: URL;
    scopes: string[];
};

export function renderAuthorizationPage(input: AuthorizationPageInput): string {
    const clientName = escapeHtml(input.clientName);
    const requestId = escapeHtml(input.requestId);
    const relayHost = escapeHtml(input.resource.host);
    const resourceUrl = escapeHtml(input.resource.toString());
    const canUseTools = input.scopes.includes('mcp:tools');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Authorize Quota</title>
<style>
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #090a0c;
  color: #f5f6f7;
  font-synthesis: none;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 32px 18px;
  background: #090a0c;
}
.shell { width: min(100%, 560px); }
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  margin: 0 0 18px 2px;
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.mark {  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid #2c3037;
  border-radius: 9px;
  background: #14161a;
  font-size: 16px;
  font-weight: 760;
}
.card {
  overflow: hidden;
  border: 1px solid #262a31;
  border-radius: 18px;
  background: #111317;
  box-shadow: 0 20px 60px rgba(0,0,0,.30);
}
.hero {
  padding: 32px 32px 26px;
  border-bottom: 1px solid #20242a;
}
.eyebrow {
  margin: 0 0 10px;
  color: #858e9a;
  font-size: 11px;
  font-weight: 680;
  letter-spacing: .09em;
  text-transform: uppercase;
}
h1 {  margin: 0;
  font-size: clamp(25px, 5vw, 32px);
  line-height: 1.08;
  letter-spacing: -.035em;
  font-weight: 720;
}
.sub {
  margin: 12px 0 0;
  max-width: 47ch;
  color: #a8afb9;
  font-size: 14px;
  line-height: 1.55;
}
.content { padding: 24px 32px 30px; }
.connection {
  display: grid;
  grid-template-columns: minmax(0,1fr) auto minmax(0,1fr);
  gap: 14px;
  align-items: center;
  padding: 15px 16px;
  border: 1px solid #262a31;
  border-radius: 12px;
  background: #0d0f12;
}
.meta {
  display: block;
  margin-bottom: 4px;
  color: #7f8894;
  font-size: 10px;  font-weight: 680;
  letter-spacing: .07em;
  text-transform: uppercase;
}
.connection strong {
  display: block;
  overflow: hidden;
  color: #e9ebee;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.arrow { color: #59616c; }
.permission {
  margin-top: 18px;
  padding: 17px 18px;
  border: 1px solid #262a31;
  border-radius: 12px;
}
.permission-title {
  margin: 0 0 6px;
  color: #eef0f2;
  font-size: 14px;
  font-weight: 650;
}
.permission-copy {
  margin: 0;
  color: #8f98a4;
  font-size: 13px;
  line-height: 1.5;
}
.security {  display: flex;
  gap: 11px;
  margin-top: 18px;
  color: #8d96a1;
  font-size: 12px;
  line-height: 1.5;
}
.security-icon {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 1px solid #30353d;
  border-radius: 50%;
  color: #a5adb7;
  font-size: 11px;
}
form { margin-top: 22px; }
label {
  display: block;
  margin-bottom: 8px;
  color: #c7ccd3;
  font-size: 12px;
  font-weight: 620;
}
input {
  width: 100%;
  height: 46px;
  padding: 0 13px;
  border: 1px solid #30353d;
  border-radius: 10px;  outline: none;
  background: #0b0d10;
  color: #f5f6f7;
  font: inherit;
  transition: border-color .15s ease, box-shadow .15s ease;
}
input:focus {
  border-color: #656e7a;
  box-shadow: 0 0 0 3px rgba(255,255,255,.05);
}
input::placeholder { color: #59616b; }
.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
button {
  min-width: 138px;
  height: 44px;
  border: 0;
  border-radius: 10px;
  background: #f3f4f5;
  color: #101114;
  font: inherit;
  font-size: 13px;
  font-weight: 720;
  cursor: pointer;
  transition: background .15s ease, transform .15s ease;
}
button:hover { background: #fff; }button:active { transform: translateY(1px); }
.foot {
  margin: 14px 2px 0;
  color: #616a75;
  font-size: 11px;
  line-height: 1.5;
  text-align: center;
}
@media (max-width: 520px) {
  body { padding: 18px 12px; }
  .hero, .content { padding-left: 21px; padding-right: 21px; }
  .connection { grid-template-columns: 1fr; }
  .arrow { transform: rotate(90deg); }
  button { width: 100%; }
}
</style>
</head>
<body>
<main class="shell">
  <div class="brand"><span class="mark">Q</span><span>Quota</span></div>
  <section class="card" aria-labelledby="title">
    <header class="hero">
      <p class="eyebrow">Authorization request</p>
      <h1 id="title">Authorize Quota</h1>
      <p class="sub"><strong>${clientName}</strong> is requesting access to your self-hosted Quota relay.</p>
    </header>    <div class="content">
      <div class="connection" aria-label="Connection details">
        <div><span class="meta">Client</span><strong>${clientName}</strong></div>
        <span class="arrow" aria-hidden="true">→</span>
        <div><span class="meta">Relay</span><strong>${relayHost}</strong></div>
      </div>
      <section class="permission">
        <p class="permission-title">${canUseTools ? 'Use connected machine tools' : 'Connect to this relay'}</p>
        <p class="permission-copy">Quota exposes the tools registered by your connected agent. Those tools can read or modify files, run commands, and manage processes according to the agent's capabilities.</p>
      </section>
      <div class="security">
        <span class="security-icon" aria-hidden="true">✓</span>
        <span>Your owner secret is verified by Quota and is never returned to the requesting client.</span>
      </div>
      <form method="post" action="/oauth/approve">
        <input type="hidden" name="request_id" value="${requestId}">
        <label for="owner_secret">Owner secret</label>
        <input id="owner_secret" name="owner_secret" type="password" required autocomplete="current-password" placeholder="Enter your Quota owner secret" autofocus>
        <div class="actions"><button type="submit">Authorize access</button></div>
      </form>
    </div>
  </section>
  <p class="foot">Quota · Self-hosted remote MCP · ${resourceUrl}</p>
</main>
</body>
</html>`;
}
