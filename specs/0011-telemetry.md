# 0011: Telemetry through the chassis: usage, events, and traces per wake

Status: accepted 2026-09-03. Implements the operator's ask to see what
each wake cost in tokens on either harness, and to see a wake's
timeline and traces in the console, without a third-party backend and
without loosening spec 0010's lockdown.

## 1. The problem

Both harnesses know exactly what a session spent: Claude Code's
stream-json ends with a `result` event carrying token counts, a dollar
figure, turns and duration; Codex's JSONL ends every turn with a
`turn.completed` carrying token counts. Both also speak OpenTelemetry:
Claude Code exports metrics (token usage, cost, edits), events (tool
calls and decisions, API requests, errors) and, behind a beta flag,
spans (interaction, LLM request, tool); Codex exports events, spans and
metrics. Spec 0010 switched every provider-bound exporter off, because
their defaults report to the vendor. Nothing in the chassis read any of
it, so the operator's only usage figure was the subscription's own
meter.

The obvious receiver, an OpenTelemetry collector plus a tracing
backend, is a second stack to run and a second place the wake's data
lives. The chassis already has the place: the chronicle, the colony's
introspection surface, with a D1 database, a Gatekeeper reached
through the umbilical, and a console page per wake.

## 2. The rule

- **Usage is read from the harness's own stream, once, at the end of
  the wake.** The adapter parses the session output it already
  produces (spec 0010 made the structured stream mandatory); the
  entrypoint records one `wake_usage` row through the chronicle door
  and names the numbers in the end-of-wake summary. No exporter, no
  timing window, identical for both harnesses.
- **Telemetry export goes to the chassis, never to the provider.** Both
  harnesses export OTLP over HTTP with the JSON encoding to the wake's
  own porch, which forwards to the chronicle Gatekeeper through the
  umbilical. The provider-bound exporters stay off (spec 0010 §3, §4).
  The chronicle parses OTLP JSON itself; there is no collector and no
  dependency.
- **The session holds no nonce.** The exporters are pointed at the
  loopback porch with the porch header, exactly as the browser door
  is; the porch attaches the chronicle bearer outside the session.
  (A wake nonce in the session's environment would be a bearer for
  every door.)
- **Identity is the supervisor's fact.** The wake id and agent id on
  every stored row come from the umbilical router (`x-operon-wake`,
  `x-operon-agent`), never from the payload's resource attributes,
  which the session could write.
- **Content stays off by default.** Prompts, responses, tool arguments
  and tool output are not exported (the harnesses' own defaults, kept
  explicit); what is stored is names, timings, counts, statuses and
  token figures. The porch redacts each payload against the wake's
  shared denylist before forwarding, as it does the transcript.
- **Retention is bounded.** Spans, events and metric points are pruned
  after 30 days; usage rows are kept.

## 3. What is stored

The chronicle gains four tables:

- `wake_usage`: one row per wake (`wake_id` unique): harness, model,
  input, output, cache-read and cache-write tokens, cost in USD where
  the harness reports one (Claude Code does; Codex under a subscription
  does not), turns, duration.
- `otel_spans`: wake, agent, trace id, span id, parent, name, start and
  end (epoch ms), status, attributes (JSON, capped).
- `otel_events`: wake, agent, time, event name, severity, body text
  (capped), attributes (JSON, capped).
- `otel_metrics`: wake, agent, time, metric name, value, attributes.

## 4. The wires

- **Container.** After the session, `adapter.usageFrom(lines)` reads
  the usage from the retained stream lines (Claude Code's `result`,
  Codex's `turn.completed` summed). The porch serves
  `POST /otel/v1/{traces,metrics,logs}` and forwards the redacted body
  to `<chronicle door>/v1/<signal>` with the chronicle bearer; the
  session never learns that bearer. The adapters point their exporters
  at `<porch>/otel`: Claude Code through environment (with
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` for spans, the JSON protocol,
  short export intervals, account and content flags off), Codex through
  `[otel]` in its staged config (`otlp-http`, `protocol = "json"`, the
  three signal endpoints).
- **Umbilical.** The router adds `x-operon-wake` beside
  `x-operon-agent` on every forwarded request.
- **Chronicle Gatekeeper.** `POST /chronicle/wake-usage` and the three
  OTLP routes on the default export (chronicle bearer, capped body,
  capped rows per request, prune on write once an hour). On the `Ops`
  entrypoint: usage per wake, usage per agent per day, recent wakes'
  usage, and a wake's trace (spans, events or metrics, paginated).
- **Plane.** Tools `wake_usage`, `fleet_usage`, `wakes_usage`,
  `wake_trace`, the same on the API and MCP (spec 0003 parity). The
  console shows tokens on the wakes list and a usage line on the wake
  page, and a timeline view beside the transcript: events in order, and
  spans as a waterfall against the wake's start.

## 5. Verification

- Chronicle: the OTLP parser turns the documented JSON shapes (resource
  spans, metrics with sum/gauge/histogram points, log records, every
  `anyValue` kind) into rows, caps attribute and body sizes, and
  refuses payloads over the row cap by name.
- Container: `usageFrom` on a Claude `result` line and on a run of
  Codex `turn.completed` lines; the porch forwards an OTLP body with
  the chronicle bearer and redacts denylisted literals from it; the
  adapters' telemetry settings name the porch and only the porch.
- Live (AGENTS.md rule): one wake per harness shows a usage row, events
  and spans in the console, and its summary names the token counts.
