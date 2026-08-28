# Spec 0004: The web door

Status: draft. Builds on spec 0001 (doors, the porch, the hostile-mind
doctrine), spec 0002 (per-agent bearers, the vault), and spec 0003 (the
umbilical, the ops gateway, per-wake sub-caps).

## 1. The problem

The mind's "browsing" today is WebFetch and curl: plain HTTP, no
JavaScript, no forms, no logins, no cookies. An agent that earns its
keep on the open web needs a real browser: to create accounts on web
apps (it already receives email, so verification flows close), to sign
in and stay signed in across wakes, to operate dashboards that are
JavaScript all the way down, and to test the sites it publishes.

A browser is also the sharpest tool this system will hand a hostile
mind. It carries logged-in sessions (ambient authority on third-party
sites), it renders attacker-controlled content next to those sessions
(prompt injection with hands), and browser state is a bag of secrets
that must never touch a repo. So the browser is a DOOR, with the same
posture as money and mail: credentials only in Workers, deterministic
policy, everything ledgered, and the operator able to watch.

## 2. Decisions

- **Remote browser only.** No browser is installed in the container.
  Every browser the agent touches is a Cloudflare Browser Run session,
  reached through the gateway below. Testing local code does not weaken
  this: a short-lived Cloudflare Tunnel exposes the container's dev
  server to the remote browser (section 7). One path, one audit trail.
- **CDP is the protocol.** Browser Run exposes a raw Chrome DevTools
  Protocol WebSocket; every client (Playwright, Puppeteer,
  chrome-devtools-mcp, Stagehand) speaks it, and switching providers
  later is a URL change. The chassis relays CDP frames and stays
  ignorant of what drives them.
- **MCP is the mind-side surface.** The harness gets a standard browser
  MCP server (chrome-devtools-mcp) pointed at the relay; no bespoke
  browsing tools. Codex speaks MCP too, so the door is harness-portable
  by construction. Scripts are equally welcome: anything in the
  container may connectOverCDP to the same relay endpoint.
- **Named sessions, persisted by the Gatekeeper.** Browser Run sessions
  die (10 minutes idle, max); identity must not. The Gatekeeper
  snapshots storage state (cookies + localStorage + a name) into its
  own Durable Object storage and restores it into the next Browser Run
  session. Never the repo: repo history is forever and cookies are
  credentials.

## 3. The browser Gatekeeper (browser-gk)

One new Worker, one Durable Object class (`WebSession`), one DO
instance per (agent, session name). It is the only holder of the
Cloudflare API token that reaches Browser Run.

Each `WebSession` DO:

- **Opens**: dials `wss://api.cloudflare.com/.../browser-rendering/
  devtools/browser?keep_alive=600000&recording=true` with the
  Worker-held API token, restores the saved storage state (CDP
  `Storage.setCookies` + an init script for localStorage), and marks
  the session live.
- **Relays**: pipes CDP frames both ways between the container side and
  Browser Run. The relay is transparent to clients and is where all
  policy lives.
- **Ledgers**: `web_session_open` / `web_session_close`, every
  top-frame navigation (`Page.frameNavigated`), and downloads. The
  ledger is the greppable audit trail; the Browser Run recording
  (`recording=true`) is the full-fidelity replay, viewable in the
  Cloudflare dashboard after the session closes.
- **Snapshots**: on close, wake end, or relay disconnect, exports
  storage state into DO storage under the session name. Open after
  close resumes the same identity.
- **Enforces** (section 5): the per-wake browser-minute cap, the origin
  denylist, and the CDP input sweep.

### Session naming

Sessions are named by purpose (`x-account`, `github`, `research`), not
per wake. `operon web open <name>` either resumes the saved state under
that name or starts clean. Names are per-agent; two agents can both
have a `github` session with disjoint state. An unnamed quick session
(`operon web open`) gets a wake-scoped name and is never persisted.

## 4. The path: everything through the gateway

```
mind (MCP client or script)
  -> ws://127.0.0.1:<porch>/web/<name>     x-operon-porch header (CSRF fence)
  -> porch (root) relays, adding the per-wake nonce
  -> http://web.operon.internal/<name>      nonce as bearer
  -> umbilical router (WakeContainer)       nonce validated, agent id asserted
  -> browser-gk service binding             real bearer attached
  -> WebSession DO                          policy + ledger + snapshot
  -> wss://api.cloudflare.com/...           Cloudflare API token (Worker-held)
```

The container holds no browser credential of any kind, consistent with
spec 0003 section 4. The porch hop exists because door tokens are held
by the ROOT entrypoint, never the session env (spec 0003 section 5):
the mind cannot skip the porch, and the porch's CSRF header kills
browser-page-origin calls. The relay is a WebSocket end to end; the
porch and umbilical currently speak request/response only, so both grow
a ws-passthrough (the porch already terminates loopback HTTP; a ws
upgrade is an HTTP request).

Risk to spike FIRST: WebSocket upgrade through the container outbound
interception path (`interceptOutboundHttp`) is undocumented. If it does
not relay, fallback: the porch dials browser-gk's public hostname
directly with a root-held door bearer (the pre-umbilical pattern,
still credential-free for the mind), and the virtual-host hop is
restored when the platform supports it.

## 5. The hostile-mind boundary

The browser inherits spec 0003 section 5's premise: the mind is
assumed steerable by content it reads, and a browser feeds it
attacker-controlled content while holding the agent's logged-in
sessions. The door defends itself:

- **Per-wake browser minutes** (default: 30, env knob beside the other
  caps). A hijacked wake cannot burn a day inside a browser; the next
  wake starts with a clean context. Enforced at the relay by wall
  clock on live sessions; also the cost bound (Browser Run bills
  browser-hours).
- **Origin denylist** (env, default empty): destinations the relay
  refuses to navigate to regardless of what the mind wants. The list is
  deployment policy, like every cap. An allowlist is deliberately NOT
  the default: the whole point of the door is the open web.
- **CDP input sweep**: `Input.insertText`, `Input.dispatchKeyEvent`
  batches and `Runtime.evaluate` payloads are swept against the secret
  denylist (the gitleaks doctrine, applied to keystrokes) before
  relaying. A mind cannot type the mind credential, a door bearer, or
  a vaulted secret it read into a web form the sweep can see.
- **Sessions are ambient authority.** A logged-in `x-account` session
  can do whatever that account can do, steered or not. Containment is
  the same as every outward door: caps, ledger, recording, live view,
  and the operator's standing ability to delete a session's state
  (which is a logout everywhere it was signed in).
- **No cross-agent reach**: session state is keyed by (agent, name)
  and the umbilical asserts the agent id; agent A cannot open agent
  B's sessions.

### Passwords: placeholder in, injection at the relay

The sweep above forbids typing secret VALUES, which raises the obvious
question: how does the agent enter the password for an account it
created? Answer: it never has the password, in either direction, the
same pattern as the phase-2 mind-credential injection.

- **Mint**: `operon web password <origin>` generates a strong password
  DOOR-SIDE, stores it in the vault under `web/<origin>`, and returns
  only a placeholder token. The mind never sees the value, not even at
  signup, so it cannot leak what it does not hold.
- **Fill**: the mind types the placeholder
  (`{{vault:web/<name>}}`) into the field. The RELAY substitutes the
  real value into the `Input.insertText` frame, but only on a domain
  the credential is BOUND to. Anywhere else the placeholder goes
  through verbatim: a steered mind cannot be phished into entering the
  GitHub password on a lookalike domain, because the mind does not
  have it.

### Domain binding (auth hosts are rarely the main host)

Real sign-up and sign-in flows hop hosts: `accounts.google.com` for a
Google product, an Auth0/Okta tenant domain, `id.atlassian.com`, a
`signup.` host distinct from the login host, SSO redirect chains. So
binding is not exact-origin:

- **Registrable domain (eTLD+1) matching**, via the public suffix
  list: `signup.example.com`, `auth.example.com` and `example.com` are
  one binding.
- **Bound by observation, not declaration**: a credential's domain set
  is SEEDED by where the relay actually performed the substitution
  during signup. The relay is present for the whole flow, so a
  password form living on `auth.vendor-idp.com` while the app is
  `app.example.com` binds both, automatically and correctly, with the
  navigation chain ledgered.
- **Automatic seeding is safe because passwords are unique per
  credential**: if the mind is steered into "signing up" on a phishing
  site, the attacker captures a fresh random password to an account
  that exists nowhere else. The dangerous case is an EXISTING
  credential on a NEW domain, and that is exactly what seeding never
  allows.
- **Extending a binding is a held decision**: an existing credential
  filled on an unbound domain (a site migrating auth hosts, or an
  actual phish) is refused at the relay and surfaced to the operator
  through the same notify-with-buttons machinery as email and spend
  holds; approval adds the domain, audited. Rare by construction, so
  the friction lands only where the risk is.
- This keeps the input sweep absolute: there is never a legitimate
  reason for a real secret value in a keystroke. In practice the
  persisted session cookie does most logins and passwords are rare.

The browser session cookie AND the vaulted password together are the
account; deleting both is account abandonment.

### Passkeys first (WebAuthn at the relay)

Passkeys are the PREFERRED credential wherever a site offers them, and
the fit is exact: CDP has a native WebAuthn domain, so the relay
installs a VIRTUAL AUTHENTICATOR into every session
(`WebAuthn.addVirtualAuthenticator`, CTAP2/internal,
automatic presence + user-verified).

- **Registration**: the site prompts for a passkey, the virtual
  authenticator answers, and the relay exports the resulting
  credential (`WebAuthn.getCredentials`) into the session's DO storage
  keyed by rpId, beside the cookies it already keeps. On the next
  session open the relay restores it (`WebAuthn.addCredential`).
- **Sign-in is a click.** No secret is typed, no placeholder, no
  sweep interaction, no OTP dance.
- **Origin binding is cryptographic**, enforced by the protocol
  itself: an assertion is scoped to the rpId, so a lookalike domain
  cannot use the credential at all. Everything the password machinery
  above approximates with domain binding and held decisions, WebAuthn
  provides natively; none of it is needed on the passkey path.
- The mind never holds any part of the credential at any point,
  including enrollment. Doctrine: when a signup or account-settings
  page offers a passkey, take it; passwords are the fallback for sites
  without one.

### OTPs

- **Email codes and magic links** work TODAY: the agent's inbox is the
  email door (`operon email pull`). Codes are short-lived and
  single-use, so reading one from the inbox and typing it is safe; the
  sweep does not apply to ephemeral values.
- **TOTP** (authenticator-app codes): the seed is vaulted at
  enrollment (`operon vault set web-totp/<name>`, through the porch,
  never keystrokes) and codes are minted door-side: `operon web otp
  <name>` returns the current 6-digit code, which is safe to type for
  the same reason email codes are. The seed does transit the session
  once at enrollment (the site displays it); the sweep denylists it
  from that moment, and relay-side DOM extraction is a later
  tightening if that window matters.
- **SMS**: the agent has no phone number. Out of scope for this spec;
  a number-renting door would be its own decision with its own abuse
  surface.

## 6. Operator surface

Through the ops gateway (spec 0003 section 3), new routes:

- `GET /web/sessions`: per agent, the named sessions: name, cookie
  DOMAINS (where it is logged in; never values), created, last used,
  live or saved, minutes used this wake.
- `GET /web/sessions/:name/history`: the navigation ledger for one
  session.
- `POST /web/sessions/:name/delete` (decision, audited): drop the saved
  state. The remote logout button.
- Live sessions: the response includes the Browser Run live-view URL
  (`Cloudflare.getLiveView`), which is watch-and-intervene: the
  operator can see the page the agent sees and take the wheel.
- Recordings live in the Cloudflare dashboard (Browser Run > Runs);
  the session ledger rows carry the session id to find them.

## 7. Local testing without a local browser

The container gets no browser, but agents build sites and need to see
them rendered. The dev-server path:

- `operon web expose <port>` starts a short-lived Cloudflare quick
  tunnel to a local port. The tunnel client has to run IN the container
  (a Worker cannot reach the container's localhost), so the image gains
  the `cloudflared` binary; quick tunnels need no account credential,
  which keeps the container credential-free. The command yields an
  ephemeral `https://*.trycloudflare.com` URL the remote browser can
  reach.
- The URL is ledgered like a navigation; the tunnel dies with the wake
  (the entrypoint kills it at teardown, same as every wake process).
- This keeps one browser, one audit trail, and adds a bonus: the
  remote browser sees the site exactly as the world will (real TLS,
  real network), which localhost never shows.

Quick tunnels expose the container port to anyone holding the random
URL for the tunnel's lifetime; acceptable for a dev server serving the
agent's own about-to-be-published site, and the wake-scoped teardown
bounds it. If that posture tightens later, a named tunnel on the
operator's account with Access in front is the upgrade path.

## 8. Costs

Browser Run on Workers Paid: 10 browser-hours/month and 10 averaged
concurrent browsers included, then $0.09/browser-hour and $2 per
additional concurrent browser. At the default 30 min/wake cap and 3
wakes/day the theoretical ceiling is ~45 h/month (~$3.15 beyond the
included 10 h); in practice sessions idle out at 10 minutes and real
usage lands well under. The per-wake cap is also the budget knob.

## 9. Phasing

1. **Spike**: a ws CDP relay porch -> umbilical -> Worker -> Browser
   Run, driving one page load end to end. Proves the one undocumented
   link (section 4) before any structure is built.
2. **MVP**: browser-gk with `WebSession` (open/relay/ledger/snapshot),
   `operon web open|sessions|close`, chrome-devtools-mcp staged into
   the harness config, ops routes (list + history + delete), recording
   on, per-wake minute cap.
3. **Signup flow proven**: the agent creates one real account end to
   end (email verification via the email door, password into the
   vault), operator watches via live view.
4. **Hardening**: CDP input sweep, origin denylist knob, live-view
   link in a notify action, tunnel-based local testing
   (`operon web expose`).

## 10. What this does NOT do

- No local browser in the container (decision, section 2). Playwright
  as a LIBRARY may still be installed for connectOverCDP scripting;
  the Chromium download is not.
- No `--chrome` / Claude in Chrome: that integration requires a
  visible browser and an interactive login session; it is the
  human-paired variant of exactly this door.
- No headful operator puppeteering beyond live view intervene; the
  operator's browser is not part of the chassis.
- No browser for the operator plane itself; the ops gateway remains
  JSON.
