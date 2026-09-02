/**
 * Operator notification with button-gating (spec 0003 §7). Action buttons
 * (approve/reject) execute real decisions, so they must only ever reach
 * the operator from OUR OWN Workers over a private service binding. That
 * binding is now the only path (spec 0009): no public URL, no bearer on
 * the wire, nothing for a leaked token to reach.
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
  /** The telegram Gatekeeper, over a service binding: the only path there is (spec 0009). */
  TELEGRAM?: TelegramGatewayBinding;
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
  if (!env.TELEGRAM) {
    console.error("notify dropped: no TELEGRAM binding on this worker");
    return;
  }
  try {
    await env.TELEGRAM.notify({
      text,
      ...(options.actions ? { actions: options.actions } : {}),
      ...(options.agentId ? { agentId: options.agentId } : {})
    });
  } catch (error) {
    console.error("notify over binding failed", error);
  }
}
