import type { AgentSpec } from '../schemas/agent-spec';

/**
 * Each MVP template carries:
 *  - slug: stable identifier (used in URL paths)
 *  - name, description, industry, agent_type
 *  - spec: partial Agent Spec used as the starting point when the user picks
 *    this template. Required fields, goals, handoff conditions, and
 *    compliance defaults are set per docs/14_VERTICAL_TEMPLATES.md.
 *  - test_prompts: canned prompts that exercise the generator.
 */

export type TemplateSpec = Omit<AgentSpec, 'flow'> & { flow?: AgentSpec['flow'] };

export interface AgentTemplateSeed {
  slug: string;
  name: string;
  description: string;
  industry: string;
  agent_type: AgentSpec['agent_type'];
  spec: TemplateSpec;
  test_prompts: string[];
}

const commonCompliance: AgentSpec['compliance'] = {
  ai_disclosure_required: true,
  recording_notice_required: true,
  opt_out_enabled: true,
  consent_required_for_outbound: true,
};

const commonConversationRules: AgentSpec['conversation_rules'] = {
  ask_one_question_at_a_time: true,
  confirm_critical_information: true,
  do_not_make_up_answers: true,
  fallback_to_human_when_unsure: true,
};

export const MVP_TEMPLATES: AgentTemplateSeed[] = [
  {
    slug: 'ai-receptionist',
    name: 'AI Receptionist',
    description: 'General inbound answering agent that takes messages and routes urgent calls.',
    industry: 'general_smb',
    agent_type: 'inbound_receptionist',
    test_prompts: [
      'Create an AI receptionist for a small business that takes messages and sends an SMS follow-up.',
    ],
    spec: {
      schema_version: '1.0',
      name: 'AI Receptionist',
      industry: 'general_smb',
      agent_type: 'inbound_receptionist',
      language: 'en',
      voice: { tone: 'warm, friendly, professional', allow_interruptions: true },
      identity: { business_name: 'Example Business', agent_name: 'Ava' },
      goals: ['answer calls', 'collect contact details', 'take a message', 'send SMS follow-up'],
      required_fields: [
        { key: 'full_name', type: 'string', required: true },
        { key: 'phone', type: 'phone', required: true },
        { key: 'reason_for_call', type: 'string', required: false },
        { key: 'preferred_callback_time', type: 'datetime', required: false },
      ],
      conversation_rules: commonConversationRules,
      knowledge: {
        retrieval_mode: 'agent_scoped',
        max_chunks: 5,
        fallback_message:
          'I do not have that information right now, but I can have the team follow up.',
        source_ids: [],
      },
      tools: [],
      handoff: {
        enabled: true,
        conditions: ['caller_requests_human', 'urgent_case', 'agent_uncertain'],
      },
      compliance: commonCompliance,
      analytics: { success_events: ['message_taken', 'human_transfer_completed'] },
    },
  },
  {
    slug: 'dental-receptionist',
    name: 'Dental Clinic Receptionist',
    description:
      'Patient-facing receptionist for a dental clinic. Books appointments, answers FAQs, transfers dental emergencies.',
    industry: 'dental_clinic',
    agent_type: 'inbound_receptionist',
    test_prompts: [
      'Create an AI receptionist for a dental clinic that books appointments and transfers emergencies.',
    ],
    spec: {
      schema_version: '1.0',
      name: 'Dental Clinic Receptionist',
      industry: 'dental_clinic',
      agent_type: 'inbound_receptionist',
      language: 'en',
      voice: { tone: 'warm, professional, concise', allow_interruptions: true },
      identity: {
        business_name: 'Smile Dental Clinic',
        agent_name: 'Ava',
        disclosure: 'Hi, this is Ava, the AI receptionist for Smile Dental Clinic.',
      },
      goals: [
        'answer opening hours and pricing questions',
        'collect patient name and phone',
        'book appointments',
        'transfer dental emergencies to the front desk',
      ],
      required_fields: [
        { key: 'full_name', type: 'string', required: true },
        { key: 'phone', type: 'phone', required: true },
        { key: 'existing_patient', type: 'boolean', required: false },
        { key: 'treatment_needed', type: 'string', required: false },
        { key: 'preferred_date', type: 'date', required: false },
        { key: 'preferred_time', type: 'string', required: false },
      ],
      conversation_rules: commonConversationRules,
      knowledge: {
        retrieval_mode: 'agent_scoped',
        max_chunks: 5,
        fallback_message:
          'I do not have that information right now, but I can have the clinic follow up.',
        source_ids: [],
      },
      tools: [
        {
          name: 'google_calendar.book_slot',
          description: 'Book an appointment on the clinic calendar.',
          requires_confirmation: true,
          input_schema: {
            type: 'object',
            properties: {
              full_name: { type: 'string' },
              phone: { type: 'string' },
              preferred_date: { type: 'string' },
              preferred_time: { type: 'string' },
              treatment_needed: { type: 'string' },
            },
            required: ['full_name', 'phone'],
          },
        },
      ],
      handoff: {
        enabled: true,
        conditions: [
          'severe_pain',
          'bleeding',
          'swelling',
          'caller_requests_human',
          'agent_uncertain',
        ],
      },
      compliance: commonCompliance,
      analytics: {
        success_events: ['appointment_booked', 'human_transfer_completed', 'message_taken'],
      },
    },
  },
  {
    slug: 'real-estate-qualifier',
    name: 'Real Estate Lead Qualifier',
    description:
      'Outbound agent that qualifies property buyers by budget, location, timeline, and books site visits for hot leads.',
    industry: 'real_estate',
    agent_type: 'outbound_qualifier',
    test_prompts: [
      'Create a real estate calling agent that qualifies buyers by budget and location and books site visits for hot leads.',
    ],
    spec: {
      schema_version: '1.0',
      name: 'Real Estate Lead Qualifier',
      industry: 'real_estate',
      agent_type: 'outbound_qualifier',
      language: 'en',
      voice: { tone: 'confident, warm, consultative', allow_interruptions: true },
      identity: { business_name: 'Example Realty', agent_name: 'Riley' },
      goals: [
        'qualify the lead by budget, location, property type, timeline',
        'book a site visit for hot leads',
        'hand off cold leads to the CRM with notes',
      ],
      required_fields: [
        { key: 'full_name', type: 'string', required: true },
        { key: 'phone', type: 'phone', required: true },
        { key: 'budget', type: 'string', required: true },
        { key: 'location', type: 'string', required: true },
        { key: 'property_type', type: 'string', required: false },
        { key: 'timeline', type: 'string', required: false },
        { key: 'visit_time', type: 'datetime', required: false },
      ],
      conversation_rules: commonConversationRules,
      knowledge: { retrieval_mode: 'agent_scoped', max_chunks: 5, source_ids: [] },
      tools: [
        {
          name: 'google_calendar.book_slot',
          description: 'Book a property site visit.',
          requires_confirmation: true,
          input_schema: {
            type: 'object',
            properties: {
              full_name: { type: 'string' },
              phone: { type: 'string' },
              visit_time: { type: 'string' },
              location: { type: 'string' },
            },
            required: ['full_name', 'phone', 'visit_time'],
          },
        },
      ],
      handoff: {
        enabled: true,
        conditions: ['caller_requests_human', 'urgent_case', 'agent_uncertain'],
      },
      compliance: commonCompliance,
      analytics: { success_events: ['lead_qualified', 'site_visit_booked'] },
    },
  },
  {
    slug: 'appointment-reminder',
    name: 'Appointment Reminder',
    description:
      'Outbound opt-in reminder calls. Confirms, reschedules, or cancels. Compliance-first.',
    industry: 'appointment_services',
    agent_type: 'outbound_reminder',
    test_prompts: [
      'Create an appointment reminder agent that confirms, reschedules, or cancels upcoming visits with opt-out support.',
    ],
    spec: {
      schema_version: '1.0',
      name: 'Appointment Reminder',
      industry: 'appointment_services',
      agent_type: 'outbound_reminder',
      language: 'en',
      voice: { tone: 'polite, respectful, brief', allow_interruptions: true },
      identity: { business_name: 'Example Clinic', agent_name: 'Sam' },
      goals: [
        'confirm the upcoming appointment',
        'offer to reschedule or cancel',
        'respect opt-out requests',
      ],
      required_fields: [
        { key: 'full_name', type: 'string', required: true },
        { key: 'phone', type: 'phone', required: true },
        { key: 'appointment_time', type: 'datetime', required: true },
        { key: 'confirmation_status', type: 'enum', required: true, enum_values: ['confirmed', 'rescheduled', 'cancelled'] },
      ],
      conversation_rules: commonConversationRules,
      knowledge: { retrieval_mode: 'none', max_chunks: 0, source_ids: [] },
      tools: [],
      handoff: {
        enabled: true,
        conditions: ['caller_requests_human', 'opt_out_requested'],
      },
      compliance: {
        ...commonCompliance,
        allowed_call_window: { timezone: 'America/Los_Angeles', start_hour: 9, end_hour: 20 },
      },
      analytics: {
        success_events: ['appointment_confirmed', 'appointment_rescheduled', 'opt_out_recorded'],
      },
    },
  },
  {
    slug: 'd2c-order-confirmation',
    name: 'D2C Order Confirmation',
    description:
      'Outbound agent that confirms COD orders, delivery address, and offers prepaid conversion with a payment link.',
    industry: 'ecommerce_d2c',
    agent_type: 'outbound_confirmation',
    test_prompts: [
      'Create a voice agent for confirming COD orders: confirm customer name, order, address, and offer to convert to prepaid with a payment link.',
    ],
    spec: {
      schema_version: '1.0',
      name: 'D2C Order Confirmation',
      industry: 'ecommerce_d2c',
      agent_type: 'outbound_confirmation',
      language: 'en',
      voice: { tone: 'friendly, efficient, reassuring', allow_interruptions: true },
      identity: { business_name: 'Example Store', agent_name: 'Nova' },
      goals: [
        'confirm order and customer name',
        'confirm delivery address',
        'offer prepaid payment link',
        'record confirmation outcome',
      ],
      required_fields: [
        { key: 'order_id', type: 'string', required: true },
        { key: 'customer_name', type: 'string', required: true },
        { key: 'phone', type: 'phone', required: true },
        { key: 'address_confirmed', type: 'boolean', required: true },
        { key: 'order_confirmed', type: 'boolean', required: true },
        { key: 'payment_preference', type: 'enum', required: false, enum_values: ['cod', 'prepaid'] },
      ],
      conversation_rules: commonConversationRules,
      knowledge: { retrieval_mode: 'none', max_chunks: 0, source_ids: [] },
      tools: [
        {
          name: 'payments.send_payment_link',
          description: 'Send a prepaid payment link to the customer via SMS.',
          requires_confirmation: true,
          input_schema: {
            type: 'object',
            properties: {
              phone: { type: 'string' },
              order_id: { type: 'string' },
              amount: { type: 'number' },
            },
            required: ['phone', 'order_id'],
          },
        },
      ],
      handoff: {
        enabled: true,
        conditions: ['caller_requests_human', 'opt_out_requested', 'agent_uncertain'],
      },
      compliance: {
        ...commonCompliance,
        allowed_call_window: { timezone: 'America/Los_Angeles', start_hour: 9, end_hour: 20 },
      },
      analytics: {
        success_events: ['order_confirmed', 'prepaid_link_sent', 'opt_out_recorded'],
      },
    },
  },
];

export function findTemplateBySlug(slug: string): AgentTemplateSeed | undefined {
  return MVP_TEMPLATES.find((t) => t.slug === slug);
}
