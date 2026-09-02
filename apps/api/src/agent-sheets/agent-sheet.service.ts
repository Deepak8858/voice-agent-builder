import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AgentSpec, CallerDetailsRequest, CallerDetailsResponse } from '@voiceforge/shared';
import { z } from 'zod';
import { ForbiddenError } from '../common/errors';
import { safeFetch } from '../common/safe-fetch';
import { GoogleConnectionService } from '../google-connection/google-connection.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { AGENT_SHEET_QUEUE } from './agent-sheet.queue';

/**
 * One Google Sheet per published agent, filled live while the agent talks.
 *
 * The sheet is created once, named after the agent, in the workspace's
 * connected Google account. Its header row is the agent's `required_fields`
 * keys, verbatim, after four fixed columns; republishing with new fields
 * appends headers and never moves or deletes existing ones, so rows written
 * against the old layout stay aligned.
 *
 * Writes happen off the call path: the runtime posts the details it has so far
 * and returns to the caller at once; the row is appended or updated by a
 * BullMQ worker (`AGENT_SHEET_QUEUE`, concurrency 1, so saves for one call
 * apply in order). The first write for a call appends a row and keeps its row
 * number on the call; later writes update that row.
 */

export const SHEET_TITLE = 'Calls';
const SPREADSHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Columns every agent sheet starts with, before the agent's own fields. */
export const FIXED_COLUMNS: ReadonlyArray<{ key: string; header: string }> = [
  { key: 'call_time', header: 'Call time' },
  { key: 'caller_number', header: 'Caller number' },
  { key: 'call_id', header: 'Call ID' },
  { key: 'outcome', header: 'Outcome' },
];

const ColumnsSchema = z.array(z.object({ key: z.string(), header: z.string() }));
type Column = z.infer<typeof ColumnsSchema>[number];

export interface SheetSyncJob {
  callId: string;
  workspaceId: string;
}

@Injectable()
export class AgentSheetService {
  private readonly logger = new Logger(AgentSheetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleConnectionService,
    private readonly queue: QueueService,
  ) {}

  /**
   * Creates the agent's sheet on first publish and appends headers for fields
   * added since. Never fails the publish: a Google problem is recorded on the
   * resource row and logged, and the agent goes live without live rows until
   * the next publish retries.
   */
  async ensureForPublish(
    agent: { id: string; workspaceId: string; organizationId: string; name: string },
    spec: AgentSpec,
  ): Promise<{ spreadsheetUrl: string } | null> {
    const status = await this.google.getStatus(agent.workspaceId);
    if (!status.connected || !status.scopes.includes(SPREADSHEETS_SCOPE)) return null;

    const wanted: Column[] = [
      ...FIXED_COLUMNS,
      ...spec.required_fields.map((field) => ({ key: field.key, header: field.key })),
    ];
    const existing = await this.prisma.agentGoogleResource.findFirst({
      where: { agentId: agent.id, workspaceId: agent.workspaceId },
    });

    try {
      const accessToken = await this.google.getUsableAccessToken(agent.workspaceId);
      if (!existing) {
        const created = await this.createSpreadsheet(accessToken, agent.name);
        await this.writeRange(accessToken, created.spreadsheetId, `${SHEET_TITLE}!A1`, [
          wanted.map((column) => column.header),
        ]);
        const row = await this.prisma.agentGoogleResource.create({
          data: {
            agentId: agent.id,
            workspaceId: agent.workspaceId,
            organizationId: agent.organizationId,
            spreadsheetId: created.spreadsheetId,
            spreadsheetUrl: created.spreadsheetUrl,
            sheetTitle: SHEET_TITLE,
            columns: wanted as unknown as Prisma.InputJsonValue,
            headerSyncedAt: new Date(),
            status: 'ready',
            lastError: null,
          },
        });
        return { spreadsheetUrl: row.spreadsheetUrl };
      }

      const columns = readColumns(existing.columns);
      const known = new Set(columns.map((column) => column.key));
      const added = wanted.filter((column) => !known.has(column.key));
      if (added.length > 0) {
        // Append-only: new headers go to the right of the last existing column.
        await this.writeRange(
          accessToken,
          existing.spreadsheetId,
          `${SHEET_TITLE}!${columnLetter(columns.length)}1`,
          [added.map((column) => column.header)],
        );
      }
      await this.prisma.agentGoogleResource.update({
        where: { id: existing.id },
        data: {
          columns: [...columns, ...added] as unknown as Prisma.InputJsonValue,
          headerSyncedAt: new Date(),
          status: 'ready',
          lastError: null,
        },
      });
      return { spreadsheetUrl: existing.spreadsheetUrl };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`Agent sheet for ${agent.id} could not be prepared: ${message}`);
      if (existing) {
        await this.prisma.agentGoogleResource.update({
          where: { id: existing.id },
          data: { status: 'error', lastError: message.slice(0, 500) },
        });
      }
      return null;
    }
  }

  /**
   * Accepts what the caller has said so far and returns immediately. The
   * fields are merged onto the call; the sheet write is a queued job so the
   * conversation never waits on Google.
   */
  async recordCallerDetails(input: CallerDetailsRequest): Promise<CallerDetailsResponse> {
    const call = await this.prisma.call.findUnique({
      where: { id: input.callId },
      select: { id: true, workspaceId: true, agentId: true, metadata: true },
    });
    if (!call || call.agentId !== input.agentId) {
      throw new ForbiddenError('Call is not bound to this agent.');
    }
    const resource = await this.prisma.agentGoogleResource.findFirst({
      where: { agentId: input.agentId, workspaceId: call.workspaceId, status: 'ready' },
      select: { columns: true },
    });
    if (!resource) return { saved: false, reason: 'no_sheet' };

    const allowed = new Set(readColumns(resource.columns).map((column) => column.key));
    const current = objectValue(call.metadata);
    const details: Record<string, string> = { ...objectStrings(current.caller_details) };
    for (const [key, value] of Object.entries(input.fields)) {
      if (!allowed.has(key) || value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text) details[key] = text;
    }
    await this.prisma.call.update({
      where: { id: call.id },
      data: { metadata: { ...current, caller_details: details } as Prisma.InputJsonValue },
    });
    await this.enqueueSync(call.id, call.workspaceId);
    return { saved: true, reason: null };
  }

  /** Queues a row refresh for a call that has details, e.g. when the call ends and the outcome is known. */
  async syncIfTracked(call: { id: string; workspaceId: string }): Promise<void> {
    const row = await this.prisma.call.findFirst({
      where: { id: call.id, workspaceId: call.workspaceId },
      select: { metadata: true },
    });
    const metadata = objectValue(row?.metadata);
    if (!metadata.caller_details && !metadata.sheet_row) return;
    await this.enqueueSync(call.id, call.workspaceId);
  }

  /** Worker entry: writes the call's row from its current state (append once, then update). */
  async syncCallRow(job: SheetSyncJob): Promise<void> {
    const call = await this.prisma.call.findFirst({
      where: { id: job.callId, workspaceId: job.workspaceId },
      select: {
        id: true,
        workspaceId: true,
        agentId: true,
        direction: true,
        fromNumber: true,
        toNumber: true,
        status: true,
        outcome: true,
        startedAt: true,
        createdAt: true,
        metadata: true,
      },
    });
    if (!call) return;
    const resource = await this.prisma.agentGoogleResource.findFirst({
      where: { agentId: call.agentId, workspaceId: call.workspaceId, status: 'ready' },
    });
    if (!resource) return;

    const metadata = objectValue(call.metadata);
    const details = objectStrings(metadata.caller_details);
    const fixed: Record<string, string> = {
      call_time: (call.startedAt ?? call.createdAt).toISOString(),
      caller_number: (call.direction === 'outbound' ? call.toNumber : call.fromNumber) ?? '',
      call_id: call.id,
      outcome: call.outcome ?? call.status,
    };
    const values = readColumns(resource.columns).map(
      (column) => fixed[column.key] ?? details[column.key] ?? '',
    );

    const accessToken = await this.google.getUsableAccessToken(call.workspaceId);
    const row = typeof metadata.sheet_row === 'number' ? metadata.sheet_row : null;
    if (row) {
      await this.writeRange(accessToken, resource.spreadsheetId, `${resource.sheetTitle}!A${row}`, [
        values,
      ]);
      return;
    }
    const appendedRow = await this.appendRow(
      accessToken,
      resource.spreadsheetId,
      resource.sheetTitle,
      values,
    );
    // Re-read: another save may have merged more details while Google worked.
    const latest = await this.prisma.call.findFirst({
      where: { id: call.id, workspaceId: call.workspaceId },
      select: { metadata: true },
    });
    await this.prisma.call.update({
      where: { id: call.id },
      data: {
        metadata: {
          ...objectValue(latest?.metadata ?? call.metadata),
          sheet_row: appendedRow,
        } as Prisma.InputJsonValue,
      },
    });
  }

  private async enqueueSync(callId: string, workspaceId: string): Promise<void> {
    // One job per save, processed in order by a single-concurrency worker; the
    // job reads the call's latest state when it runs, so a burst of saves
    // converges on the final row.
    await this.queue.enqueue<SheetSyncJob>(
      AGENT_SHEET_QUEUE,
      'sync',
      { callId, workspaceId },
      {
        jobId: `sheet:${callId}:${randomUUID()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
      },
    );
  }

  private async createSpreadsheet(
    accessToken: string,
    title: string,
  ): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
    const response = await safeFetch(SHEETS_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: { title },
        sheets: [{ properties: { title: SHEET_TITLE } }],
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      spreadsheetId?: string;
      spreadsheetUrl?: string;
      error?: { message?: string };
    };
    if (!response.ok || !body.spreadsheetId) {
      throw new Error(
        `Sheets create failed (${response.status}): ${body.error?.message ?? 'no id returned'}`,
      );
    }
    return {
      spreadsheetId: body.spreadsheetId,
      spreadsheetUrl:
        body.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${body.spreadsheetId}/edit`,
    };
  }

  private async writeRange(
    accessToken: string,
    spreadsheetId: string,
    range: string,
    values: string[][],
  ): Promise<void> {
    const url =
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}` +
      '?valueInputOption=USER_ENTERED';
    const response = await safeFetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    if (!response.ok) throw new Error(`Sheets write failed (${response.status}) for ${range}`);
  }

  /** Appends one row and returns its 1-based row number, read back from Google's updated range. */
  private async appendRow(
    accessToken: string,
    spreadsheetId: string,
    sheetTitle: string,
    values: string[],
  ): Promise<number> {
    const url =
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${sheetTitle}!A1`)}:append` +
      '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
    const response = await safeFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [values] }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      updates?: { updatedRange?: string };
    };
    if (!response.ok) throw new Error(`Sheets append failed (${response.status})`);
    const match = /![A-Z]+(\d+)(?::[A-Z]+\d+)?$/.exec(body.updates?.updatedRange ?? '');
    if (!match)
      throw new Error(`Sheets append returned no row: ${body.updates?.updatedRange ?? 'none'}`);
    return Number(match[1]);
  }
}

export function readColumns(value: Prisma.JsonValue | null | undefined): Column[] {
  const parsed = ColumnsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** 0-based column index to a sheet column letter: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function objectStrings(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(objectValue(value))) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}
