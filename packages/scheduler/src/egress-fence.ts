/**
 * The web door's egress fence (spec 0004 section 5, layer two), pure so
 * it is unit-tested without a Workers runtime.
 *
 * A web-capable agent's container launches with a deny-by-default
 * `allowedHosts` allowlist in force for the WHOLE wake, so a browser
 * credential the mind extracts through the relay has no direct path out
 * of the container. The fence is a LAUNCH property because `allowedHosts`
 * belongs to the container supervisor: there is no unfenced window to
 * close, because the container never runs unfenced.
 *
 * What is deliberately NOT on the list:
 * - the agent's own publish hosts: reached through the publish door over
 *   the umbilical, never direct egress, so listing them would only add an
 *   exfil sink;
 * - anything the browser visits: browsing is REMOTE (Browser Run), so a
 *   navigation never uses container egress at all;
 * - `*.trycloudflare.com`: that is the public hostname the REMOTE browser
 *   reaches for `operon web expose`; the container itself only dials
 *   Cloudflare's argotunnel ingress, and wildcarding it would admit an
 *   attacker's own tunnel.
 */

/** The mind endpoints a harness may legitimately call. */
const MIND_HOSTS = ["api.anthropic.com", "api.openai.com"];

/** Package and VCS infra a wake genuinely needs. */
const WAKE_INFRA = [
  "registry.npmjs.org",
  "*.npmjs.org",
  "github.com",
  "*.github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com"
];

/** Cloudflare's tunnel INGRESS (what `cloudflared` dials), for web expose. */
const TUNNEL_INGRESS = ["*.argotunnel.com", "*.cloudflare.com"];

/**
 * The allowlist for a fenced (web-capable) container. `extra` carries
 * deployment-specific additions (an API the agent legitimately calls),
 * supplied by the operator, never by the mind.
 */
export function fenceAllowedHosts(extra: string[] = []): string[] {
  const all = [...MIND_HOSTS, ...WAKE_INFRA, ...TUNNEL_INGRESS, ...extra]
    .map(host => host.trim())
    .filter(host => host.length > 0);
  return [...new Set(all)].sort();
}

/** Parse the operator's extra-hosts env value ("a.com,b.com"). */
export function parseExtraHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(host => host.trim())
    .filter(host => host.length > 0);
}
