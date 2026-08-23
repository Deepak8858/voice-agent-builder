export type TemplateContent = {
  slug: string;
  name: string;
  title: string;
  description: string;
  eyebrow: string;
  intro: string;
  sections: { title: string; body: string; bullets?: string[] }[];
};

export const templateContent: TemplateContent[] = [
  {
    slug: 'ai-receptionist',
    name: 'AI receptionist',
    title: 'AI Receptionist for Local Businesses',
    description:
      'Build and test an AI receptionist that answers inbound calls, captures intent, takes messages, and transfers callers with clear rules.',
    eyebrow: 'Inbound reception',
    intro:
      'Turn a business brief into a governed inbound receptionist. Review the complete call contract, test it in the browser, and publish only when the call path is ready.',
    sections: [
      {
        title: 'Answer with a defined call path',
        body: 'Create a receptionist around the calls the business actually receives instead of relying on one long prompt.',
        bullets: [
          'Capture caller intent and required details',
          'Answer approved questions from business knowledge',
          'Transfer or take a message using explicit rules',
        ],
      },
      {
        title: 'Test before the phone rings',
        body: 'Run the receptionist in a browser test call and inspect the transcript, events, and outcome before connecting live inbound traffic.',
      },
      {
        title: 'Improve from real outcomes',
        body: 'Track calls, outcomes, fallback behavior, and tool activity. Update the Agent Spec as a versioned contract rather than changing hidden prompt text.',
      },
    ],
  },
  {
    slug: 'dental-receptionist',
    name: 'Dental receptionist',
    title: 'AI Receptionist for Dental Clinics',
    description:
      'Build a dental office AI receptionist for inbound questions and appointment requests, with tested flows and human handoff rules.',
    eyebrow: 'Dental clinic template',
    intro:
      'Give dental clinics a tested inbound call flow for appointment requests, common office questions, messages, and urgent-call routing without pretending to provide diagnosis.',
    sections: [
      {
        title: 'Handle routine front-desk calls',
        body: 'Structure common caller paths while keeping clinical judgment with qualified people.',
        bullets: [
          'Collect appointment preferences',
          'Answer approved office and service FAQs',
          'Route emergencies and clinical questions to staff',
        ],
      },
      {
        title: 'Connect approved knowledge',
        body: 'Attach clinic-specific FAQs and documents so answers come from scoped business sources rather than generic model memory.',
      },
      {
        title: 'Give the clinic a clear workspace',
        body: 'Agencies can separate each client workspace, apply client branding, and provide focused access to calls and analytics.',
      },
    ],
  },
  {
    slug: 'real-estate-lead-qualifier',
    name: 'Real estate lead qualifier',
    title: 'AI Voice Agent for Real Estate Lead Qualification',
    description:
      'Build an opt-in real estate lead qualification voice agent with structured questions, consent controls, outcomes, and handoff rules.',
    eyebrow: 'Requested follow-up',
    intro:
      'Follow up with people who asked to be contacted. Capture property intent, timeline, and preferences through a reviewable flow, then route qualified conversations.',
    sections: [
      {
        title: 'Qualify requested follow-up',
        body: 'Use structured questions for opted-in leads rather than positioning the agent as a cold-calling tool.',
        bullets: [
          'Record property and location intent',
          'Capture timeline and preferred next step',
          'Transfer or schedule follow-up using explicit rules',
        ],
      },
      {
        title: 'Gate outbound execution',
        body: 'Consent, DNC/DND, opt-out, call-window, disclosure, and recording-notice checks run before an outbound call can proceed.',
      },
      {
        title: 'Review every outcome',
        body: 'Inspect transcripts, events, collected fields, transfers, and outcomes so the agency can improve the deployed version.',
      },
    ],
  },
  {
    slug: 'appointment-reminder',
    name: 'Appointment reminder',
    title: 'AI Appointment Reminder Calls',
    description:
      'Create consent-aware AI appointment reminder calls that confirm, reschedule, or route requests through a governed and testable flow.',
    eyebrow: 'Consent-aware reminder',
    intro:
      'Build reminder calls around a known appointment and an allowed purpose. Test confirmation, rescheduling, opt-out, and exception paths before launch.',
    sections: [
      {
        title: 'Keep the purpose narrow',
        body: 'The flow is designed for an existing appointment—not unsolicited sales outreach.',
        bullets: [
          'Confirm the appointment details provided to the agent',
          'Capture confirmation or a reschedule request',
          'Respect opt-out and route exceptions to staff',
        ],
      },
      {
        title: 'Test every branch',
        body: 'Exercise confirmation, voicemail, reschedule, wrong-person, and transfer paths in the browser before real calls run.',
      },
      {
        title: 'Track operational outcomes',
        body: 'See whether the call was answered, confirmed, transferred, opted out, or failed, with the transcript and event trail attached.',
      },
    ],
  },
  {
    slug: 'order-confirmation',
    name: 'Order confirmation',
    title: 'AI Order Confirmation Calls for Ecommerce',
    description:
      'Build AI order confirmation calls for opted-in customers, with structured verification, exception routing, and compliance gates.',
    eyebrow: 'D2C order operations',
    intro:
      'Confirm a known customer order through a narrow, auditable flow. Handle confirmation and exceptions without turning operational calls into cold promotions.',
    sections: [
      {
        title: 'Confirm the right details',
        body: 'Define exactly what the agent may verify and what should be escalated.',
        bullets: [
          'Confirm approved order details',
          'Capture a correction or cancellation request',
          'Route payment, fraud, or complex support issues to staff',
        ],
      },
      {
        title: 'Protect customer context',
        body: 'Scope calls, knowledge, integrations, and records to the correct workspace and agent.',
      },
      {
        title: 'Measure completion',
        body: 'Track confirmations and exception outcomes rather than treating minutes called as the only success metric.',
      },
    ],
  },
];

export function getTemplate(slug: string) {
  return templateContent.find((item) => item.slug === slug);
}
