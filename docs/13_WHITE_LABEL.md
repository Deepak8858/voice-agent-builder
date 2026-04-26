# 13 — White-Label Agency System

## Goal
Allow agencies to create and manage client voice agents under their own brand.

## Hierarchy
```txt
Platform
  └── Agency Workspace
      ├── Client Workspace A
      └── Client Workspace B
```

## MVP Features
Agency workspace, client workspaces, client invites, logo/color settings, client dashboard, usage by client, agency-level templates.

## Later Features
Custom domains, branded emails, client billing markup, client invoices, template marketplace, reseller dashboard.

## White Label Settings
```json
{
  "brand_name": "Agency Voice AI",
  "logo_url": "https://...",
  "primary_color": "#111827",
  "custom_domain": "voice.agency.com",
  "support_email": "support@agency.com",
  "hide_platform_branding": true
}
```

## Roles
| Role | Permissions |
|---|---|
| Agency Owner | all agency and client access |
| Agency Member | assigned client workspaces |
| Client Admin | own workspace management |
| Client Viewer | read-only reports |
