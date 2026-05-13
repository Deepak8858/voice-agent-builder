import type { AgentSpec } from '@voiceforge/shared';

export function buildSystemPrompt(spec: AgentSpec): string {
  const parts: string[] = [];

  // Identity
  const agentName = spec.identity?.agent_name ?? 'AI Assistant';
  const businessName = spec.identity?.business_name ?? 'our office';
  parts.push(`You are ${agentName}, the AI voice assistant for ${businessName}.`);

  // Disclosure
  if (spec.identity?.disclosure) {
    parts.push(`When asked about your identity: "${spec.identity.disclosure}"`);
  }

  // Goals
  if (spec.goals?.length) {
    parts.push(`Your primary goals:`);
    spec.goals.forEach((goal, i) => parts.push(`${i + 1}. ${goal}`));
  }

  // Tone
  if (spec.voice?.tone) {
    parts.push(`Communication style: ${spec.voice.tone}.`);
  }

  // Speaking rate
  if (spec.voice?.speaking_rate) {
    parts.push(`Speak at a ${spec.voice.speaking_rate > 1 ? 'faster' : spec.voice.speaking_rate < 1 ? 'slower' : 'normal'} pace.`);
  }

  // Compliance
  if (spec.compliance) {
    if (spec.compliance.opt_out_enabled) {
      parts.push(`If the caller says anything like "stop calling", "opt out", "remove me from your list", immediately acknowledge and end the call politely.`);
    }
    if (spec.compliance.consent_required_for_outbound) {
      parts.push(`Confirm the caller is the intended recipient before proceeding with the call.`);
    }
    if (spec.compliance.recording_notice_required) {
      parts.push(`Inform the caller if this call is being recorded.`);
    }
  }

  // Conversation rules
  if (spec.conversation_rules) {
    const rules = spec.conversation_rules;
    parts.push(`Conversation rules: ${rules.ask_one_question_at_a_time ? 'Ask one question at a time.' : ''}`);
    parts.push(`${rules.confirm_critical_information ? 'Confirm critical info before proceeding.' : ''}`);
    parts.push(`${rules.do_not_make_up_answers ? 'Do not make up information. Say you don\'t know if unsure.' : ''}`);
    if (rules.fallback_to_human_when_unsure) {
      parts.push(`If you\'re unsure, offer to transfer to a human agent.`);
    }
  }

  // Tools
  if (spec.tools?.length) {
    parts.push(`You have access to these tools:`);
    spec.tools.forEach(tool => {
      parts.push(`- ${tool.name}: ${tool.description}`);
    });
  }

  // First message from conversation_rules
  if (spec.conversation_rules?.first_message) {
    parts.push(`Opening greeting: "${spec.conversation_rules.first_message}"`);
  } else {
    parts.push(`Start with: "Hello, this is ${agentName} at ${businessName}. How can I help you today?"`);
  }

  // Reminders
  parts.push(`Keep responses concise and natural for spoken conversation.`);
  parts.push(`Do not use markdown, bullet points, or technical formatting in speech.`);
  parts.push(`If you don't know something, say so honestly rather than making up information.`);

  return parts.join('\n');
}
