import { z } from 'zod';

/**
 * Phase 8 — White Label / Agency System.
 * Mirrors docs/13_WHITE_LABEL.md.
 */

// --- settings ----------------------------------------------------------

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export const WhiteLabelSettingsSchema = z.object({
  workspace_id: z.string().uuid(),
  brand_name: z.string().nullable(),
  logo_url: z.string().url().startsWith('https://').nullable(),
  primary_color: z.string().nullable(),
  custom_domain: z.string().nullable(),
  support_email: z.string().email().nullable(),
  hide_platform_branding: z.boolean(),
  updated_at: z.string(),
});
export type WhiteLabelSettings = z.infer<typeof WhiteLabelSettingsSchema>;

export const UpdateWhiteLabelSettingsDtoSchema = z.object({
  brand_name: z.string().min(1).max(120).nullable().optional(),
  logo_url: z.string().url().startsWith('https://').nullable().optional(),
  primary_color: z.string().regex(HEX_COLOR, 'Must be a hex color like #112233').nullable().optional(),
  custom_domain: z
    .string()
    .regex(DOMAIN, 'Must be a valid domain like voice.agency.com')
    .max(253)
    .nullable()
    .optional(),
  support_email: z.string().email().nullable().optional(),
  hide_platform_branding: z.boolean().optional(),
});
export type UpdateWhiteLabelSettingsDto = z.infer<typeof UpdateWhiteLabelSettingsDtoSchema>;

// --- client workspaces -------------------------------------------------

export const ClientWorkspaceSchema = z.object({
  id: z.string().uuid(),
  parent_workspace_id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  created_at: z.string(),
});
export type ClientWorkspace = z.infer<typeof ClientWorkspaceSchema>;

export const CreateClientWorkspaceDtoSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers, dashes only'),
});
export type CreateClientWorkspaceDto = z.infer<typeof CreateClientWorkspaceDtoSchema>;

export const ClientUsageSchema = z.object({
  workspace_id: z.string().uuid(),
  range: z.object({ from: z.string(), to: z.string() }),
  total_calls: z.number().int().min(0),
  total_minutes: z.number().min(0),
  blocked_calls: z.number().int().min(0),
  active_agents: z.number().int().min(0),
});
export type ClientUsage = z.infer<typeof ClientUsageSchema>;

// --- invites -----------------------------------------------------------

export const ClientInviteSchema = z.object({
  id: z.string().uuid(),
  agency_workspace_id: z.string().uuid(),
  client_workspace_id: z.string().uuid().nullable(),
  email: z.string().email(),
  role: z.enum(['admin', 'viewer']),
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  token: z.string(),
  expires_at: z.string(),
  accepted_at: z.string().nullable(),
  created_at: z.string(),
});
export type ClientInvite = z.infer<typeof ClientInviteSchema>;

export const CreateClientInviteDtoSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'viewer']).default('admin'),
  client_workspace_id: z.string().uuid().optional(),
  expires_in_days: z.number().int().min(1).max(60).default(14),
});
export type CreateClientInviteDto = z.infer<typeof CreateClientInviteDtoSchema>;

export const AcceptClientInviteDtoSchema = z.object({
  token: z.string().min(1),
});
export type AcceptClientInviteDto = z.infer<typeof AcceptClientInviteDtoSchema>;
