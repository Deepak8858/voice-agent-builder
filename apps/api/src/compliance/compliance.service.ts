import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ALLOWED_OUTBOUND_PURPOSES,
  BLOCKED_OUTBOUND_PURPOSES,
  type AddDncDto,
  type AgentSpec,
  type ComplianceCheckResult,
  type ComplianceDirection,
  type ComplianceReason,
  type ComplianceStatus,
  type ContactConsent,
  type ContactDetail,
  type ContactSummary,
  type CreateContactDto,
  type DncEntry,
  type GrantConsentDto,
  type OptOutContactDto,
  type RevokeConsentDto,
  type UpdateContactDto,
} from '@voiceforge/shared';
import { AuditService } from '../audit/audit.service';
import {
  AgentNotFoundError,
  ConsentNotFoundError,
  ContactNotFoundError,
} from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

interface CheckArgs {
  workspaceId: string;
  agentId: string;
  direction: ComplianceDirection;
  toNumber?: string | null;
  contactId?: string | null;
  callId?: string | null;
  purpose?: string | null;
}

@Injectable()
export class ComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -- contacts ---------------------------------------------------------

  async listContacts(workspaceId: string): Promise<ContactSummary[]> {
    const rows = await this.prisma.contact.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { consentRecords: true } },
      },
    });
    return rows.map((r) => this.toContactSummary(r, r._count.consentRecords));
  }

  async getContact(workspaceId: string, contactId: string): Promise<ContactDetail> {
    const row = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
      include: { consentRecords: { orderBy: { consentedAt: 'desc' } } },
    });
    if (!row) throw new ContactNotFoundError(contactId);
    return this.toContactDetail(row);
  }

  async upsertContact(
    workspaceId: string,
    actorUserId: string,
    dto: CreateContactDto,
  ): Promise<ContactDetail> {
    const phone = normalizePhone(dto.phone);
    const existing = await this.prisma.contact.findUnique({
      where: { workspaceId_phone: { workspaceId, phone } },
    });

    const row = existing
      ? await this.prisma.contact.update({
          where: { id: existing.id },
          data: {
            email: dto.email ?? existing.email,
            fullName: dto.full_name ?? existing.fullName,
            metadata:
              dto.metadata !== undefined
                ? (dto.metadata as Prisma.InputJsonValue)
                : undefined,
          },
        })
      : await this.prisma.contact.create({
          data: {
            workspaceId,
            phone,
            email: dto.email ?? null,
            fullName: dto.full_name ?? null,
            metadata: dto.metadata
              ? (dto.metadata as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          },
        });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: existing ? 'contact.update' : 'contact.create',
      resourceType: 'contact',
      resourceId: row.id,
      metadata: { phone },
    });

    return this.getContact(workspaceId, row.id);
  }

  async updateContact(
    workspaceId: string,
    contactId: string,
    actorUserId: string,
    dto: UpdateContactDto,
  ): Promise<ContactDetail> {
    const existing = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
    });
    if (!existing) throw new ContactNotFoundError(contactId);

    await this.prisma.contact.update({
      where: { id: contactId },
      data: {
        email: dto.email === undefined ? existing.email : dto.email,
        fullName: dto.full_name === undefined ? existing.fullName : dto.full_name,
        metadata:
          dto.metadata !== undefined
            ? (dto.metadata as Prisma.InputJsonValue)
            : undefined,
      },
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'contact.update',
      resourceType: 'contact',
      resourceId: contactId,
    });

    return this.getContact(workspaceId, contactId);
  }

  async optOutContact(
    workspaceId: string,
    contactId: string,
    actorUserId: string,
    dto: OptOutContactDto,
  ): Promise<ContactDetail> {
    const existing = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
    });
    if (!existing) throw new ContactNotFoundError(contactId);

    await this.prisma.contact.update({
      where: { id: contactId },
      data: {
        optOut: true,
        optOutAt: new Date(),
        optOutReason: dto.reason ?? null,
      },
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'contact.opt_out',
      resourceType: 'contact',
      resourceId: contactId,
      metadata: { reason: dto.reason ?? null },
    });

    return this.getContact(workspaceId, contactId);
  }

  // -- consent ----------------------------------------------------------

  async grantConsent(
    workspaceId: string,
    contactId: string,
    actorUserId: string,
    dto: GrantConsentDto,
  ): Promise<ContactDetail> {
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
    });
    if (!contact) throw new ContactNotFoundError(contactId);

    await this.prisma.consentRecord.create({
      data: {
        workspaceId,
        contactId,
        consentType: dto.consent_type,
        source: dto.source ?? 'api',
        proofUrl: dto.proof_url ?? null,
        expiresAt: dto.expires_at ? new Date(dto.expires_at) : null,
        metadata: dto.metadata
          ? (dto.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'consent.grant',
      resourceType: 'contact',
      resourceId: contactId,
      metadata: { consent_type: dto.consent_type, source: dto.source },
    });

    return this.getContact(workspaceId, contactId);
  }

  async revokeConsent(
    workspaceId: string,
    contactId: string,
    actorUserId: string,
    dto: RevokeConsentDto,
  ): Promise<ContactDetail> {
    const active = await this.prisma.consentRecord.findFirst({
      where: {
        workspaceId,
        contactId,
        consentType: dto.consent_type,
        revokedAt: null,
      },
      orderBy: { consentedAt: 'desc' },
    });
    if (!active) throw new ConsentNotFoundError(dto.consent_type, contactId);

    await this.prisma.consentRecord.update({
      where: { id: active.id },
      data: { revokedAt: new Date() },
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'consent.revoke',
      resourceType: 'contact',
      resourceId: contactId,
      metadata: { consent_type: dto.consent_type, reason: dto.reason ?? null },
    });

    return this.getContact(workspaceId, contactId);
  }

  // -- DNC --------------------------------------------------------------

  async listDnc(workspaceId: string): Promise<DncEntry[]> {
    const rows = await this.prisma.dncEntry.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDncEntry(r));
  }

  async addDnc(
    workspaceId: string,
    actorUserId: string,
    dto: AddDncDto,
  ): Promise<DncEntry> {
    const phone = normalizePhone(dto.phone);
    const row = await this.prisma.dncEntry.upsert({
      where: { workspaceId_phone: { workspaceId, phone } },
      create: {
        workspaceId,
        phone,
        source: dto.source ?? 'manual',
        reason: dto.reason ?? null,
      },
      update: {
        source: dto.source ?? 'manual',
        reason: dto.reason ?? null,
      },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'dnc.add',
      resourceType: 'dnc_entry',
      resourceId: row.id,
      metadata: { phone, source: dto.source },
    });
    return this.toDncEntry(row);
  }

  async removeDnc(workspaceId: string, phoneRaw: string, actorUserId: string): Promise<void> {
    const phone = normalizePhone(phoneRaw);
    const existing = await this.prisma.dncEntry.findUnique({
      where: { workspaceId_phone: { workspaceId, phone } },
    });
    if (!existing) return;
    await this.prisma.dncEntry.delete({ where: { id: existing.id } });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'dnc.remove',
      resourceType: 'dnc_entry',
      resourceId: existing.id,
      metadata: { phone },
    });
  }

  // -- pre-flight check -------------------------------------------------

  /**
   * Runs the rule chain from docs/11_COMPLIANCE_ENGINE.md and persists a
   * `ComplianceCheck` row. Always returns a structured result; callers must
   * branch on `status` (`passed` | `blocked`).
   */
  async check(args: CheckArgs): Promise<ComplianceCheckResult> {
    const reasons: ComplianceReason[] = [];

    const agent = await this.prisma.agent.findFirst({
      where: { id: args.agentId, workspaceId: args.workspaceId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!agent) throw new AgentNotFoundError(args.agentId);

    const spec = (agent.versions[0]?.specJson ?? null) as AgentSpec | null;
    const direction = args.direction;

    // Resolve / link contact for outbound flows when phone is supplied.
    let contactId: string | null = args.contactId ?? null;
    if (direction === 'outbound' && args.toNumber) {
      const phone = normalizePhone(args.toNumber);
      const contact = contactId
        ? await this.prisma.contact.findFirst({
            where: { id: contactId, workspaceId: args.workspaceId },
          })
        : await this.prisma.contact.findUnique({
            where: { workspaceId_phone: { workspaceId: args.workspaceId, phone } },
          });
      if (contact) contactId = contact.id;
    }

    // 1. Agent must be published for outbound.
    if (direction === 'outbound' && agent.status !== 'published') {
      reasons.push({
        code: 'agent_not_published',
        message: `Agent ${agent.id} is in status ${agent.status}; outbound calls require status=published.`,
        severity: 'blocking',
      });
    }

    if (direction === 'outbound') {
      // 2. Outbound purpose check.
      if (args.purpose) {
        const purpose = args.purpose.toLowerCase();
        if ((BLOCKED_OUTBOUND_PURPOSES as readonly string[]).includes(purpose)) {
          reasons.push({
            code: 'unsupported_purpose',
            message: `Outbound purpose "${purpose}" is not allowed in MVP.`,
            severity: 'blocking',
          });
        } else if (!(ALLOWED_OUTBOUND_PURPOSES as readonly string[]).includes(purpose)) {
          reasons.push({
            code: 'unsupported_purpose',
            message: `Outbound purpose "${purpose}" is not in the allowed MVP list.`,
            severity: 'blocking',
          });
        }
      }

      // 3. Phone present?
      if (!args.toNumber) {
        reasons.push({
          code: 'invalid_phone',
          message: 'Outbound calls require to_number.',
          severity: 'blocking',
        });
      } else {
        const phone = normalizePhone(args.toNumber);

        // 4. DNC list check.
        const dnc = await this.prisma.dncEntry.findUnique({
          where: { workspaceId_phone: { workspaceId: args.workspaceId, phone } },
        });
        if (dnc) {
          reasons.push({
            code: 'dnc_listed',
            message: `Phone ${phone} is on the workspace DNC list (source=${dnc.source}).`,
            severity: 'blocking',
          });
        }

        // 5. Opt-out check on the linked contact.
        const contact = contactId
          ? await this.prisma.contact.findUnique({ where: { id: contactId } })
          : null;
        if (contact?.optOut) {
          reasons.push({
            code: 'opted_out',
            message: `Contact ${contact.id} has opted out of further calls.`,
            severity: 'blocking',
          });
        }

        // 6. Consent check (only if the agent's spec demands it).
        const consentRequired = spec?.compliance?.consent_required_for_outbound ?? true;
        if (consentRequired) {
          if (!contact) {
            reasons.push({
              code: 'missing_consent',
              message: `No contact record found for ${phone}; consent cannot be verified.`,
              severity: 'blocking',
            });
          } else {
            const validConsent = await this.prisma.consentRecord.findFirst({
              where: {
                contactId: contact.id,
                consentType: { in: ['outbound_marketing', 'outbound_transactional'] },
                revokedAt: null,
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
              },
            });
            if (!validConsent) {
              reasons.push({
                code: 'missing_consent',
                message: `No valid outbound consent record for contact ${contact.id}.`,
                severity: 'blocking',
              });
            }
          }
        }
      }

      // 7. Allowed call window (server clock, agent timezone).
      const window = spec?.compliance?.allowed_call_window;
      if (window) {
        const hour = currentHourInTimezone(new Date(), window.timezone);
        if (hour !== null) {
          const inWindow =
            window.start_hour <= window.end_hour
              ? hour >= window.start_hour && hour < window.end_hour
              : // wraps midnight
                hour >= window.start_hour || hour < window.end_hour;
          if (!inWindow) {
            reasons.push({
              code: 'outside_call_window',
              message: `Current time (${hour}:00 ${window.timezone}) is outside allowed window ${window.start_hour}\u2013${window.end_hour}.`,
              severity: 'blocking',
            });
          }
        }
      }
    }

    // 8. AI disclosure / recording notice are warnings unless the spec
    // declares them required and the agent has no disclosure copy at all.
    if (spec?.compliance?.ai_disclosure_required && !spec.identity?.disclosure) {
      reasons.push({
        code: 'missing_ai_disclosure',
        message: 'Agent spec requires AI disclosure but no identity.disclosure text is set.',
        severity: 'warning',
      });
    }
    if (spec?.compliance?.recording_notice_required && direction === 'outbound') {
      const hasNotice = (spec.goals ?? []).some((g) =>
        g.toLowerCase().includes('record'),
      );
      if (!hasNotice) {
        reasons.push({
          code: 'missing_recording_notice',
          message: 'Recording notice is required but no recording-related goal is configured.',
          severity: 'warning',
        });
      }
    }

    const blockingReasons = reasons.filter((r) => r.severity === 'blocking');
    const status: ComplianceStatus = blockingReasons.length === 0 ? 'passed' : 'blocked';

    const row = await this.prisma.complianceCheck.create({
      data: {
        workspaceId: args.workspaceId,
        agentId: args.agentId,
        contactId,
        callId: args.callId ?? null,
        direction,
        status,
        reasons: reasons as unknown as Prisma.InputJsonValue,
        metadata: {
          to_number: args.toNumber ?? null,
          purpose: args.purpose ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      id: row.id,
      status,
      reasons,
      agent_id: row.agentId,
      contact_id: row.contactId,
      call_id: row.callId,
      direction: row.direction as ComplianceDirection,
      checked_at: row.checkedAt.toISOString(),
    };
  }

  /**
   * Convenience used by CallsService after the call row is created so the
   * compliance check is linked to the call audit-trail.
   */
  async attachCheckToCall(checkId: string, callId: string): Promise<void> {
    await this.prisma.complianceCheck
      .update({ where: { id: checkId }, data: { callId } })
      .catch(() => {
        // Best-effort: missing row should not fail the call.
      });
  }

  /**
   * Scans a finished-call transcript for opt-out phrases (stop/remove/do not
   * call/unsubscribe). When matched, links/creates a Contact for the call's
   * other-party number, sets opt_out=true, adds a DNC entry, and audits.
   * Best-effort: any error is swallowed so a webhook never fails on this path.
   */
  async processTranscriptOptOut(args: {
    workspaceId: string;
    callId: string;
    direction: string;
    contactId: string | null;
    fromNumber: string | null;
    toNumber: string | null;
    transcript: string | null;
  }): Promise<{ opted_out: boolean; matched_phrase: string | null }> {
    const transcript = (args.transcript ?? '').toLowerCase();
    if (!transcript) return { opted_out: false, matched_phrase: null };

    const phrase = OPT_OUT_PHRASES.find((p) => transcript.includes(p));
    if (!phrase) return { opted_out: false, matched_phrase: null };

    // Pick the caller-side number based on direction.
    const otherNumber =
      args.direction === 'inbound' ? args.fromNumber : args.toNumber;
    if (!args.contactId && !otherNumber) {
      return { opted_out: false, matched_phrase: null };
    }

    try {
      let contactId = args.contactId ?? null;
      if (!contactId && otherNumber) {
        const phone = normalizePhone(otherNumber);
        const existing = await this.prisma.contact.findUnique({
          where: { workspaceId_phone: { workspaceId: args.workspaceId, phone } },
        });
        const contact =
          existing ??
          (await this.prisma.contact.create({
            data: { workspaceId: args.workspaceId, phone },
          }));
        contactId = contact.id;
      }

      if (contactId) {
        await this.prisma.contact.update({
          where: { id: contactId },
          data: {
            optOut: true,
            optOutAt: new Date(),
            optOutReason: `auto: caller said "${phrase}"`,
          },
        });
      }

      // Mirror the opt-out into the workspace DNC list so the same number is
      // blocked on later inbound→outbound flows even without a contact lookup.
      if (otherNumber) {
        const phone = normalizePhone(otherNumber);
        await this.prisma.dncEntry.upsert({
          where: { workspaceId_phone: { workspaceId: args.workspaceId, phone } },
          create: {
            workspaceId: args.workspaceId,
            phone,
            source: 'request',
            reason: `auto: caller said "${phrase}"`,
          },
          update: { source: 'request' },
        });
      }

      await this.audit.log({
        workspaceId: args.workspaceId,
        action: 'compliance.opt_out.auto',
        resourceType: 'contact',
        resourceId: contactId ?? args.callId,
        metadata: {
          call_id: args.callId,
          phrase,
          phone: otherNumber,
        },
      });

      return { opted_out: true, matched_phrase: phrase };
    } catch {
      return { opted_out: false, matched_phrase: null };
    }
  }

  // -- mappers ----------------------------------------------------------

  private toContactSummary(
    r: {
      id: string;
      workspaceId: string;
      phone: string;
      email: string | null;
      fullName: string | null;
      optOut: boolean;
      optOutAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
    consentCount: number,
  ): ContactSummary {
    return {
      id: r.id,
      workspace_id: r.workspaceId,
      phone: r.phone,
      email: r.email,
      full_name: r.fullName,
      opt_out: r.optOut,
      opt_out_at: r.optOutAt ? r.optOutAt.toISOString() : null,
      consent_count: consentCount,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    };
  }

  private toContactDetail(row: {
    id: string;
    workspaceId: string;
    phone: string;
    email: string | null;
    fullName: string | null;
    optOut: boolean;
    optOutAt: Date | null;
    optOutReason: string | null;
    metadata: Prisma.JsonValue | null;
    createdAt: Date;
    updatedAt: Date;
    consentRecords: Array<{
      id: string;
      consentType: string;
      source: string;
      proofUrl: string | null;
      consentedAt: Date;
      expiresAt: Date | null;
      revokedAt: Date | null;
    }>;
  }): ContactDetail {
    const summary = this.toContactSummary(row, row.consentRecords.length);
    const consents: ContactConsent[] = row.consentRecords.map((c) => ({
      id: c.id,
      consent_type: c.consentType as ContactConsent['consent_type'],
      source: c.source as ContactConsent['source'],
      proof_url: c.proofUrl,
      consented_at: c.consentedAt.toISOString(),
      expires_at: c.expiresAt?.toISOString() ?? null,
      revoked_at: c.revokedAt?.toISOString() ?? null,
    }));
    return {
      ...summary,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      opt_out_reason: row.optOutReason,
      consents,
    };
  }

  private toDncEntry(r: {
    id: string;
    workspaceId: string;
    phone: string;
    source: string;
    reason: string | null;
    createdAt: Date;
  }): DncEntry {
    return {
      id: r.id,
      workspace_id: r.workspaceId,
      phone: r.phone,
      source: r.source as DncEntry['source'],
      reason: r.reason,
      created_at: r.createdAt.toISOString(),
    };
  }
}

// --- helpers ---------------------------------------------------------

/**
 * Phrases that should automatically opt a caller out of further outbound
 * contact. Order matters only for which phrase gets recorded as the trigger;
 * keep the more specific multi-word phrases first.
 */
export const OPT_OUT_PHRASES = [
  'do not call',
  'don’t call me',
  "don't call me",
  'remove me',
  'take me off',
  'unsubscribe',
  'opt out',
  'stop calling',
  'stop contacting',
];

/**
 * Strip surface formatting so `(415) 555-1212` and `+1 415 555 1212` collide.
 * We do NOT do full E.164 normalization here; that's a future enhancement.
 */
export function normalizePhone(input: string): string {
  return input.replace(/[^+0-9]/g, '');
}

/**
 * Returns the local hour [0..23] in the given IANA timezone, or null if the
 * timezone is unrecognized.
 */
function currentHourInTimezone(now: Date, timezone: string): number | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
    });
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === 'hour')?.value;
    if (!hourPart) return null;
    const hour = Number(hourPart);
    return Number.isFinite(hour) ? hour % 24 : null;
  } catch {
    return null;
  }
}
