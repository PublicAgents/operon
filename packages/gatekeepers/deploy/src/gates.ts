import { findAgent, type Roster } from "@operon/core";

/**
 * Pure publish gates: everything that can be decided from the payload and
 * the roster, kept free of bindings so the rules are testable. The porch
 * already swept the payload inside the container (denylist variants plus
 * gitleaks); these are the Gatekeeper's own non-negotiables, re-checked at
 * the boundary because the Gatekeeper trusts no caller:
 *
 *  - the agent exists and the target host is assigned to it,
 *  - paths are sane relative paths,
 *  - size caps hold,
 *  - every HTML page carries the colony's AI-disclosure marker,
 *  - no denylisted literal appears in any text payload.
 */

export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export interface PublishFile {
  path: string;
  contentType: string;
  contentBase64: string;
}

export interface PublishRequest {
  agentId: string;
  host: string;
  files: PublishFile[];
}

export interface GateError {
  code: string;
  detail: string;
}

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function validatePublish(
  roster: Roster,
  request: PublishRequest,
  disclosureMarker: string,
  denylist: string[]
): GateError | null {
  const agent = findAgent(roster, request.agentId);
  if (!agent) return { code: "unknown_agent", detail: request.agentId };
  if (!agent.hosts.includes(request.host)) {
    return {
      code: "host_not_assigned",
      detail: `${request.host} is not among ${request.agentId}'s hosts (${agent.hosts.join(", ")})`
    };
  }

  if (!Array.isArray(request.files) || request.files.length === 0) {
    return { code: "no_files", detail: "a publish must carry at least one file" };
  }
  if (request.files.length > MAX_FILES) {
    return { code: "too_many_files", detail: String(request.files.length) };
  }

  let total = 0;
  const seen = new Set<string>();
  for (const file of request.files) {
    if (
      typeof file.path !== "string" ||
      !SAFE_PATH.test(file.path) ||
      file.path.includes("..") ||
      file.path.startsWith("/")
    ) {
      return { code: "invalid_path", detail: String(file.path) };
    }
    if (seen.has(file.path)) return { code: "duplicate_path", detail: file.path };
    seen.add(file.path);

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(file.contentBase64);
    } catch {
      return { code: "invalid_base64", detail: file.path };
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return { code: "file_too_large", detail: file.path };
    }
    total += bytes.byteLength;

    const isText =
      file.contentType.startsWith("text/") ||
      file.contentType.includes("json") ||
      file.contentType.includes("xml") ||
      file.contentType.includes("javascript") ||
      file.contentType.includes("svg");
    if (isText) {
      const text = new TextDecoder().decode(bytes);
      for (const literal of denylist) {
        if (literal.length > 0 && text.includes(literal)) {
          return {
            code: "denylisted_content",
            detail: `${file.path} contains a denylisted literal`
          };
        }
      }
      if (
        file.contentType.startsWith("text/html") &&
        disclosureMarker.length > 0 &&
        !text.toLowerCase().includes(disclosureMarker.toLowerCase())
      ) {
        // The refusal names the marker: a mind that cannot see the
        // colony's policy vars would otherwise guess at it for a whole wake.
        return {
          code: "missing_disclosure",
          detail: `${file.path} does not contain the required disclosure marker "${disclosureMarker}" (matched case-insensitively, anywhere in the file)`
        };
      }
    }
  }

  if (total > MAX_TOTAL_BYTES) {
    return { code: "payload_too_large", detail: `${total} bytes` };
  }
  return null;
}

/** Map a request hostname to a roster host label: the zone apex is "@". */
export function hostLabel(zone: string, hostname: string): string | null {
  const lower = hostname.toLowerCase();
  if (lower === zone) return "@";
  if (lower.endsWith(`.${zone}`)) {
    const label = lower.slice(0, -(zone.length + 1));
    return label.includes(".") ? null : label;
  }
  return null;
}

/** Normalize a request path to a stored file path. */
export function storagePath(pathname: string): string {
  let path = pathname.replace(/^\/+/, "");
  if (path === "" || path.endsWith("/")) path += "index.html";
  return path;
}
