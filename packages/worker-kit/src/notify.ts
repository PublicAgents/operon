/**
 * Operator notification with button-gating (spec 0003 §7). Action buttons
 * (approve/reject) execute real decisions, so they must only ever reach
 * the operator from OUR OWN Workers over a private service binding, never
 * from a caller holding a bearer. A leaked NOTIFY_TOKEN can then forge
 * text spam but never a decision button.
 *
 * This helper prefers the TELEGRAM service binding (buttons allowed, no
 * token on the wire); it falls back to the public NOTIFY_URL + token path
 * with the actions DROPPED. One place owns the rule.
 */

export interface OperatorAction {
  label: string;
  /** email_approve | email_reject | spend_approve | spend_reject. */
  kind: string;
  agentId: string;
  id: string;
}

export interface TelegramGatewayBinding {
  notify(input: {
    text: string;
    actions?: OperatorAction[];
    agentId?: string;
  }): Promise<{ delivered: boolean; recorded?: boolean }>;
}

export interface NotifyEnv {
  /** The telegram Gatekeeper, over a service binding: the only path that carries buttons. */
  TELEGRAM?: TelegramGatewayBinding;
  /** Public fallback (containers, and deployments without the binding): buttons dropped. */
  NOTIFY_URL?: string;
  NOTIFY_TOKEN?: string;
}

export interface NotifyOptions {
  /** Only honored over the service binding; dropped on the public path. */
  actions?: OperatorAction[];
  /** Attributes the notify into the operator conversation log. */
  agentId?: string;
}

export async function notifyOperator(
  env: NotifyEnv,
  text: string,
  options: NotifyOptions = {}
): Promise<void> {
  if (env.TELEGRAM) {
    try {
      const result = await env.TELEGRAM.notify({
        text,
        ...(options.actions ? { actions: options.actions } : {}),
        ...(options.agentId ? { agentId: options.agentId } : {})
      });
      // Delivered over the binding, buttons and all: done. Recorded but
      // undelivered (a Telegram-less colony, spec 0005 §5) is ALSO done:
      // the notify is durably in the notifications feed, and a public-path
      // retry would only append it twice. Fall through only when the
      // binding call reached neither the operator nor the record.
      if (result?.delivered || result?.recorded) return;
    } catch (error) {
      console.error("notify over binding failed", error);
    }
  }
  if (!env.NOTIFY_URL || !env.NOTIFY_TOKEN) return;
  try {
    // The public path never carries actions: a bearer-authenticated
    // caller cannot put a decision button in front of the operator.
    await fetch(env.NOTIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.NOTIFY_TOKEN}` },
      body: JSON.stringify({ text, ...(options.agentId ? { agentId: options.agentId } : {}) })
    });
  } catch (error) {
    console.error("notify over public path failed", error);
  }
}
