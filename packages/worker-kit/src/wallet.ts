/**
 * Read-only wallet helpers shared by the money gatekeepers: exact
 * base-units formatting and an ERC-20 balanceOf read. Nothing here
 * touches a key; addresses and balances are public chain facts.
 */

/**
 * Exact base-units-to-display formatting: BigInt arithmetic, no float,
 * full precision with only trailing zeros trimmed (truncating would let
 * a positive high-decimals balance display as zero).
 */
export function formatUnits(raw: string, decimals: number): string {
  const units = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const fraction = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/**
 * balanceOf(holder) on an ERC-20 token via raw eth_call. Returns the
 * base-units integer as a decimal string, or null when the read fails:
 * the caller treats the address as the load-bearing fact and a missing
 * balance as a display gap, never an error.
 */
export async function erc20Balance(
  rpcUrl: string,
  apiKey: string | null,
  token: string,
  holder: string
): Promise<string | null> {
  try {
    const data = `0x70a08231000000000000000000000000${holder.slice(2).toLowerCase()}`;
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: token, data }, "latest"]
      })
    });
    const body = (await response.json()) as { result?: string };
    if (typeof body.result === "string" && body.result.startsWith("0x")) {
      return BigInt(body.result).toString();
    }
  } catch {
    /* fall through to null */
  }
  return null;
}
