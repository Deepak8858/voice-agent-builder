import { describe, expect, it } from 'vitest';
import { FileParser } from './parsers/file-parser';
import { cosineSim, splitIntoChunks } from './knowledge.service';

describe('splitIntoChunks', () => {
  it('returns empty array for empty input', () => {
    expect(splitIntoChunks('', 100, 10)).toEqual([]);
  });

  it('returns single chunk when text fits size', () => {
    expect(splitIntoChunks('short text', 100, 10)).toEqual(['short text']);
  });

  it('splits long text with overlap', () => {
    const text = 'a'.repeat(250);
    const chunks = splitIntoChunks(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it('does not produce empty chunks', () => {
    const text = 'hello'.repeat(60);
    const chunks = splitIntoChunks(text, 50, 10);
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });
});

describe('cosineSim', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it('returns 0 when either vector is zero-magnitude', () => {
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });
});

describe('FileParser', () => {
  const parser = new FileParser();

  it('detects kind by mime then extension', () => {
    expect(parser.detectKind('application/pdf', 'x.pdf')).toBe('pdf');
    expect(parser.detectKind(undefined, 'data.csv')).toBe('csv');
    expect(parser.detectKind('text/plain', 'notes.txt')).toBe('txt');
    expect(parser.detectKind(undefined, 'README.md')).toBe('txt');
  });

  it('rejects unsupported file types', () => {
    expect(() => parser.detectKind('application/zip', 'bundle.zip')).toThrow();
  });

  it('parses CSV into key:value rows', async () => {
    const csv = 'name,hours\nClinic A,9-5\nClinic B,"10-6, weekdays"\n';
    const result = await parser.parse(Buffer.from(csv, 'utf8'), 'text/csv', 'data.csv');
    expect(result.kind).toBe('csv');
    expect(result.text).toContain('name: Clinic A');
    expect(result.text).toContain('hours: 9-5');
    expect(result.text).toContain('hours: 10-6, weekdays');
  });

  it('parses plain text', async () => {
    const result = await parser.parse(Buffer.from('Hello world\r\n', 'utf8'), 'text/plain', 'a.txt');
    expect(result.kind).toBe('txt');
    expect(result.text).toBe('Hello world');
  });

  it('rejects empty buffers', async () => {
    await expect(
      parser.parse(Buffer.from('', 'utf8'), 'text/plain', 'a.txt'),
    ).rejects.toThrow();
  });
});
