import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeFileInvalidError } from '../../common/errors';

export type SupportedMimeKind = 'pdf' | 'csv' | 'txt';

export interface ParsedFile {
  kind: SupportedMimeKind;
  text: string;
  bytes: number;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB hard cap

const PDF_MIMES = new Set(['application/pdf', 'application/x-pdf']);
const CSV_MIMES = new Set(['text/csv', 'application/vnd.ms-excel']);
const TXT_MIMES = new Set(['text/plain', 'text/markdown']);

/**
 * File ingestion adapter. Detects kind from mime + filename, extracts plain
 * text, returns it for chunking. PDF parsing uses `pdf-parse` (lazy import so
 * the module can boot even before the dep is installed).
 */
@Injectable()
export class FileParser {
  private readonly logger = new Logger(FileParser.name);

  detectKind(mimeType: string | undefined, filename: string | undefined): SupportedMimeKind {
    const mt = (mimeType ?? '').toLowerCase();
    const fn = (filename ?? '').toLowerCase();
    if (PDF_MIMES.has(mt) || fn.endsWith('.pdf')) return 'pdf';
    if (CSV_MIMES.has(mt) || fn.endsWith('.csv')) return 'csv';
    if (TXT_MIMES.has(mt) || fn.endsWith('.txt') || fn.endsWith('.md')) return 'txt';
    throw new KnowledgeFileInvalidError(
      `Unsupported file type. Allowed: pdf, csv, txt, md. Received mime="${mt}" name="${fn}".`,
      { mimeType: mt, filename: fn },
    );
  }

  async parse(buffer: Buffer, mimeType: string | undefined, filename: string | undefined): Promise<ParsedFile> {
    if (buffer.length === 0) {
      throw new KnowledgeFileInvalidError('Uploaded file is empty.');
    }
    if (buffer.length > MAX_FILE_BYTES) {
      throw new KnowledgeFileInvalidError(
        `File exceeds max size of ${MAX_FILE_BYTES} bytes.`,
        { size: buffer.length, max: MAX_FILE_BYTES },
      );
    }
    const kind = this.detectKind(mimeType, filename);
    let text: string;
    if (kind === 'pdf') text = await this.parsePdf(buffer);
    else if (kind === 'csv') text = this.parseCsv(buffer.toString('utf8'));
    else text = buffer.toString('utf8');

    text = text.replace(/\r\n/g, '\n').replace(/[\t\f\v ]+/g, ' ').trim();
    if (text.length === 0) {
      throw new KnowledgeFileInvalidError('File contained no extractable text.');
    }
    return { kind, text, bytes: buffer.length };
  }

  private async parsePdf(buffer: Buffer): Promise<string> {
    let pdfParse: (b: Buffer) => Promise<{ text: string }>;
    try {
      // Lazy require so vitest + dev startup don't fail if dep absent.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{ text: string }>;
    } catch (err) {
      this.logger.error(`pdf-parse not installed: ${(err as Error).message}`);
      throw new KnowledgeFileInvalidError(
        'PDF parsing dependency is not installed. Run `npm install` in apps/api.',
      );
    }
    try {
      const result = await pdfParse(buffer);
      return result.text ?? '';
    } catch (err) {
      throw new KnowledgeFileInvalidError(`Failed to parse PDF: ${(err as Error).message}`);
    }
  }

  /**
   * Minimal RFC4180-ish CSV parser. Handles quoted fields, escaped quotes,
   * embedded commas/newlines. Output is "header: value" per row joined with
   * blank lines so chunking + embedding gets meaningful context.
   */
  private parseCsv(input: string): string {
    const rows = this.splitCsvRows(input);
    if (rows.length === 0) return '';
    const header = rows[0];
    if (rows.length === 1) return header.join(', ');
    const out: string[] = [];
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      const parts: string[] = [];
      for (let c = 0; c < header.length; c += 1) {
        const key = header[c]?.trim() ?? `col_${c}`;
        const val = (row[c] ?? '').trim();
        if (val.length > 0) parts.push(`${key}: ${val}`);
      }
      if (parts.length > 0) out.push(parts.join('\n'));
    }
    return out.join('\n\n');
  }

  private splitCsvRows(input: string): string[][] {
    const rows: string[][] = [];
    let cur: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      if (inQuotes) {
        if (ch === '"') {
          if (input[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cur.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && input[i + 1] === '\n') i += 1;
        cur.push(field);
        field = '';
        if (cur.some((c) => c.length > 0)) rows.push(cur);
        cur = [];
      } else {
        field += ch;
      }
    }
    if (field.length > 0 || cur.length > 0) {
      cur.push(field);
      if (cur.some((c) => c.length > 0)) rows.push(cur);
    }
    return rows;
  }
}
