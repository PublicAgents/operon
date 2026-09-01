/**
 * The GA Data API calls this Gatekeeper makes, and nothing else (spec
 * 0008 §5). Every one is a read, and every one is pinned to the
 * operator-configured property: the property is configuration, never an
 * argument, so no request can name another.
 */

export class AnalyticsError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "AnalyticsError";
  }
}

const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";

export interface AnalyticsApi {
  token: () => Promise<string>;
  fetch?: typeof fetch;
}

async function call(
  api: AnalyticsApi,
  method: "GET" | "POST",
  url: string,
  body?: unknown
): Promise<unknown> {
  const doFetch = api.fetch ?? fetch;
  const response = await doFetch(url, {
    method,
    headers: {
      authorization: `Bearer ${await api.token()}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = (await response.text()).slice(0, 200_000);
  if (!response.ok) {
    // Google's message names the real fault (property access, a bad
    // dimension), and paraphrasing it would hide what to fix.
    throw new AnalyticsError(response.status, text.slice(0, 400));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AnalyticsError(502, "analytics returned a non-JSON body");
  }
}

export interface ReportRequest {
  startDate: string;
  endDate: string;
  metrics: string[];
  dimensions?: string[];
  limit?: number;
  orderByMetric?: string;
}

/** GA accepts NdaysAgo, yesterday, today, or YYYY-MM-DD, and nothing else. */
const DATE = /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d+daysAgo)$/;
/** API names are letters, digits, underscores and colons (customEvent:foo). */
const API_NAME = /^[A-Za-z0-9_:]{1,64}$/;

export class ReportInputError extends Error {
  override name = "ReportInputError";
}

/**
 * Argument validation, before anything is sent. Not a security
 * boundary (the property pin and the read-only credential are), but a
 * bad dimension name should read as a named refusal here rather than
 * as a wall of Google JSON.
 */
export function validateReport(input: ReportRequest): ReportRequest {
  const { startDate, endDate, metrics, dimensions = [], limit, orderByMetric } = input;
  for (const [label, value] of [
    ["startDate", startDate],
    ["endDate", endDate]
  ] as const) {
    if (typeof value !== "string" || !DATE.test(value)) {
      throw new ReportInputError(`${label} must be YYYY-MM-DD, today, yesterday, or NdaysAgo`);
    }
  }
  if (!Array.isArray(metrics) || metrics.length === 0) {
    throw new ReportInputError("at least one metric is required (e.g. activeUsers)");
  }
  for (const name of [...metrics, ...dimensions, ...(orderByMetric ? [orderByMetric] : [])]) {
    if (typeof name !== "string" || !API_NAME.test(name)) {
      throw new ReportInputError(`"${String(name)}" is not a GA API name`);
    }
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
    throw new ReportInputError("limit must be an integer between 1 and 1000");
  }
  return input;
}

export async function runReport(
  api: AnalyticsApi,
  property: string,
  input: ReportRequest
): Promise<unknown> {
  const { startDate, endDate, metrics, dimensions = [], limit = 100, orderByMetric } = validateReport(input);
  return call(api, "POST", `${DATA_API}/${property}:runReport`, {
    dateRanges: [{ startDate, endDate }],
    metrics: metrics.map(name => ({ name })),
    dimensions: dimensions.map(name => ({ name })),
    limit,
    ...(orderByMetric
      ? { orderBys: [{ metric: { metricName: orderByMetric }, desc: true }] }
      : {})
  });
}

export async function runRealtimeReport(
  api: AnalyticsApi,
  property: string,
  input: { metrics: string[]; dimensions?: string[]; limit?: number }
): Promise<unknown> {
  const { metrics, dimensions = [], limit = 100 } = input;
  // Realtime has no date range; reuse the same name checks.
  validateReport({ startDate: "today", endDate: "today", metrics, dimensions, limit });
  return call(api, "POST", `${DATA_API}/${property}:runRealtimeReport`, {
    metrics: metrics.map(name => ({ name })),
    dimensions: dimensions.map(name => ({ name })),
    limit
  });
}

/** What this property can be asked about: its dimensions and metrics. */
export async function getMetadata(api: AnalyticsApi, property: string): Promise<unknown> {
  return call(api, "GET", `${DATA_API}/${property}/metadata`);
}

/** The properties the service account can see: a configuration check. */
export async function getAccountSummaries(api: AnalyticsApi): Promise<unknown> {
  return call(api, "GET", `${ADMIN_API}/accountSummaries`);
}
