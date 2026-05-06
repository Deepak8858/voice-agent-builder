import { z } from 'zod';

export const WorkspaceRoleSchema = z.enum(['owner', 'admin', 'editor', 'viewer']);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const WorkspaceTypeSchema = z.enum(['agency', 'client', 'direct']);
export type WorkspaceType = z.infer<typeof WorkspaceTypeSchema>;

export const OrganizationPlanSchema = z.enum(['free', 'starter', 'growth', 'agency', 'enterprise']);
export type OrganizationPlan = z.infer<typeof OrganizationPlanSchema>;

export const SessionUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string().nullable(),
  active_workspace_id: z.string().uuid().nullable(),
  active_workspace_name: z.string().nullable(),
  active_workspace_role: WorkspaceRoleSchema,
});
export type SessionUser = z.infer<typeof SessionUserSchema>;
