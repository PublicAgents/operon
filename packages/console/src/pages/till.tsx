import { type LedgerRow } from "../api.js";
import { useTool } from "../hooks.js";
import { Empty, ErrorNote, LoadingGate, TimeStamp } from "../ui.js";
import { UntrustedText } from "../untrusted.js";

/**
 * The state of the till: every live offer across agents and the colony
 * ceilings bounding them, with the till's ledger (offers set and
 * retired, receipts, refusals) as the activity trail. Selling is
 * cap-bounded, not approval-gated (spec 0002 §2.1): this page is the
 * operator's visibility into what is on sale right now.
 */

interface Offer {
  agentId: string;
  host: string;
  path: string;
  price: string;
  currency: string;
  description: string;
}

interface TillState {
  offers: Offer[];
  limits: { maxPrice: string; maxOffers: number };
}

interface WalletState {
  address: string;
  chainId: number | null;
  balances: { currency: string; decimals: number; raw: string | null; display: string | null }[];
}

function Currency({ value }: { value: string }) {
  return (
    <code title={value}>{value.startsWith("0x") ? `${value.slice(0, 8)}…` : value}</code>
  );
}

export function TillPage() {
  const state = useTool<TillState>("till_offers", {}, { pollMs: 30_000 });
  const wallet = useTool<WalletState>("spend_wallet", {}, { pollMs: 60_000 });
  const ledger = useTool<LedgerRow[]>("ledger_recent", { gatekeeper: "till" });
  const offers = state.data?.offers ?? [];
  return (
    <section>
      <header className="page-head">
        <h1>Till</h1>
        {state.data ? (
          <span className="sub">
            ceilings: price ≤ {state.data.limits.maxPrice}, offers ≤ {state.data.limits.maxOffers}{" "}
            per agent; selling is cap-bounded, not approval-gated
          </span>
        ) : null}
        <button onClick={() => { state.refresh(); ledger.refresh(); }}>refresh</button>
      </header>
      <div className="approval-block">
        <h2>spend wallet</h2>
        <ErrorNote error={wallet.error} />
        <LoadingGate loading={wallet.loading} hasData={wallet.data !== undefined}>
          {wallet.data ? (
            <table>
              <tbody>
                <tr>
                  <td>address</td>
                  <td>
                    <code>{wallet.data.address}</code>{" "}
                    <button onClick={() => { void navigator.clipboard.writeText(wallet.data?.address ?? ""); }}>
                      copy
                    </button>
                  </td>
                </tr>
                <tr>
                  <td>chain</td>
                  <td>
                    <code>{wallet.data.chainId ?? "unconfigured"}</code>
                  </td>
                </tr>
                {wallet.data.balances.map(balance => (
                  <tr key={balance.currency}>
                    <td>
                      <Currency value={balance.currency} />
                    </td>
                    <td>{balance.display ?? "balance unavailable"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </LoadingGate>
      </div>
      <ErrorNote error={state.error} />
      <LoadingGate loading={state.loading} hasData={state.data !== undefined}>
      <div className="approval-block">
        <h2>live offers ({offers.length})</h2>
        {offers.length === 0 && !state.loading ? <Empty>nothing is on sale</Empty> : null}
        {offers.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>agent</th>
                <th>path</th>
                <th>price</th>
                <th>currency</th>
                <th>description</th>
              </tr>
            </thead>
            <tbody>
              {offers.map(offer => (
                <tr key={`${offer.host}${offer.path}`}>
                  <td>
                    <span className="tag">{offer.agentId}</span>
                  </td>
                  <td>
                    <code>
                      {offer.host}
                      {offer.path}
                    </code>
                  </td>
                  <td>
                    <strong>{offer.price}</strong>
                  </td>
                  <td>
                    <Currency value={offer.currency} />
                  </td>
                  <td className="detail">
                    <UntrustedText text={offer.description} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      </LoadingGate>
      <div className="approval-block">
        <h2>till activity (offers, receipts, refusals)</h2>
        <ErrorNote error={ledger.error} />
        <LoadingGate loading={ledger.loading} hasData={ledger.data !== undefined}>
        {(ledger.data ?? []).length === 0 && !ledger.loading ? (
          <Empty>no till activity yet</Empty>
        ) : null}
        <table className="events">
          <tbody>
            {(ledger.data ?? []).map((row, index) => (
              <tr key={`${row.at}-${index}`}>
                <td>
                  <TimeStamp at={row.at} />
                </td>
                <td>
                  <code>{row.kind}</code>
                </td>
                <td className="detail">
                  <UntrustedText text={JSON.stringify(row.detail)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </LoadingGate>
      </div>
    </section>
  );
}
