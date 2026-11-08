import type { AgentKey } from './types';

export interface AgentDef {
  key: AgentKey;
  displayName: string;
  /** Translation key for the agent's role, e.g. "agent.aria.role". */
  roleKey: string;
  personality: 'formal' | 'friendly' | 'energetic';
  /** Tools this agent may call (least privilege). Enforced by the AI layer. */
  tools: string[];
  /** Power types this agent may act through. */
  powers: string[];
}

export const AGENTS: Record<AgentKey, AgentDef> = {
  orbit: {
    key: 'orbit',
    displayName: 'Orbit',
    roleKey: 'agent.orbit.role',
    personality: 'friendly',
    tools: [
      'read_all',
      'create_task',
      'assign_task',
      'cancel_task',
      'create_approval_card',
      'generate_briefing',
      'answer_question',
      'compute_pulse',
      'forecast',
      'notify_owner',
    ],
    powers: [],
  },
  aria: {
    key: 'aria',
    displayName: 'Aria',
    roleKey: 'agent.aria.role',
    personality: 'friendly',
    tools: [
      'search_knowledge',
      'get_customer',
      'upsert_customer',
      'check_availability',
      'create_booking',
      'reschedule_booking',
      'cancel_booking',
      'create_lead',
      'send_message',
      'send_service_info',
      'handover_to_human',
      'request_task',
    ],
    powers: ['website_chat', 'chat_link', 'whatsapp', 'instagram', 'messenger', 'gmail', 'outlook', 'sms', 'telegram', 'google_calendar', 'outlook_calendar'],
  },
  vox: {
    key: 'vox',
    displayName: 'Vox',
    roleKey: 'agent.vox.role',
    personality: 'friendly',
    tools: ['get_customer', 'check_availability', 'create_booking', 'reschedule_booking', 'cancel_booking', 'transfer_call', 'take_message', 'log_call_outcome', 'request_task'],
    powers: ['phone', 'google_calendar', 'outlook_calendar'],
  },
  nudge: {
    key: 'nudge',
    displayName: 'Nudge',
    roleKey: 'agent.nudge.role',
    personality: 'friendly',
    tools: ['get_segment', 'get_customer', 'send_message', 'request_review', 'add_loyalty_points', 'pause_sequence', 'request_task'],
    powers: ['whatsapp', 'sms', 'gmail', 'outlook', 'google_business_profile'],
  },
  ledger: {
    key: 'ledger',
    displayName: 'Ledger',
    roleKey: 'agent.ledger.role',
    personality: 'formal',
    tools: ['create_invoice', 'send_invoice', 'create_payment_link', 'check_payment', 'record_payment', 'sync_accounting', 'get_money_summary', 'request_task'],
    powers: ['razorpay', 'cashfree', 'phonepe', 'paytm', 'stripe', 'tally', 'zoho_books', 'quickbooks', 'google_sheets', 'gmail', 'whatsapp'],
  },
  spark: {
    key: 'spark',
    displayName: 'Spark',
    roleKey: 'agent.spark.role',
    personality: 'energetic',
    tools: ['draft_post', 'schedule_post', 'build_segment', 'create_campaign', 'create_offer', 'read_ad_leads', 'request_task'],
    powers: ['instagram', 'facebook', 'google_business_profile', 'youtube', 'linkedin', 'meta_ads', 'google_ads', 'whatsapp', 'gmail'],
  },
};

export function agentMayUseTool(agent: AgentKey, tool: string): boolean {
  return AGENTS[agent].tools.includes(tool);
}
