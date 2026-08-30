import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Ratchet for randomness quality.
 *
 * `Math.random()` is V8's xorshift128+. It is not seeded from a CSPRNG and its
 * internal state is recoverable from a handful of consecutive outputs, so every
 * value it will ever produce — past and future — is derivable by anyone who has
 * seen a few. Two real defects had exactly that shape: referral invite tokens
 * (`S-012`), where the token IS the authorization, and Twilio call-session ids
 * (`S-011`), which are handed out as `wss://.../voice/stream/<id>` capability
 * URLs. Both are fixed; this test is what stops the third.
 *
 * WHEN THIS TEST FAILS you have introduced `Math.random` into production source.
 * Either draw the value from `node:crypto` (`randomUUID`, `randomBytes`,
 * `randomInt`), or — if it is genuinely a non-security use such as retry jitter,
 * backoff or sampling — add the file to `NON_SECURITY_RANDOM` in the same commit
 * WITH a written reason. An entry without a reason is a rubber stamp; an entry
 * whose reason is "not security-sensitive" without saying what the value is used
 * for is the same thing in more words.
 *
 * WHY THIS IS AN AST WALK AND NOT A GREP: a grep is satisfied by prose. The
 * tenant-scope analyzer was defeated exactly this way — a comment inside a
 * `where` literal made a platform-wide sweep read as tenant-scoped, and the
 * finding silently left the ratchet while still reading as coverage. Comments
 * are trivia and never appear as AST nodes, so a comment cannot create a finding
 * (see `referral.service.ts`, whose docstring names `Math.random()` to explain
 * why it is NOT used there) and, more importantly, cannot silence one either.
 * The behaviour is pinned by tests below rather than asserted here.
 */

const SRC_DIR = path.resolve(__dirname, '..');

/**
 * Reviewed non-security uses of `Math.random`, keyed by path relative to `src/`.
 *
 * ponytail: keyed by FILE, not by line, so it survives edits above the call
 * site — the trade is that one entry approves every `Math.random` in that file.
 * Keep files on this list small, or move the jitter into a helper of its own.
 * The pinned length below is the other half of the control: growing this set
 * must show up as a reviewed diff on both, never as an incidentally green build.
 */
const NON_SECURITY_RANDOM: Record<string, string> = {
  // Empty, and worth keeping empty. `node:crypto` costs nothing at the call
  // rates this API runs at, so even jitter has no real reason to reach for the
  // weak generator. This list exists so that a legitimate need is recorded
  // rather than smuggled in behind a comment.
};

export interface WeakRandomUse {
  file: string;
  line: number;
}

/**
 * Every reference to `Math.random` in non-test source under `root`.
 *
 * Matches the property access rather than the call, so aliasing
 * (`const r = Math.random`) is caught too.
 */
function findWeakRandomUses(root: string): WeakRandomUse[] {
  const found: WeakRandomUse[] = [];

  for (const file of listSourceFiles(root)) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Math' &&
        node.name.text === 'random'
      ) {
        found.push({
          file: path.relative(root, file).replace(/\\/g, '/'),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return found.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('CSPRNG baseline', () => {
  it('parses the source tree rather than passing vacuously', () => {
    // A zero-finding result is only meaningful if the walker read the files.
    // Without this, a broken glob or a thrown-and-swallowed parse would report
    // an empty list and the assertion below would pass for the wrong reason.
    expect(listSourceFiles(SRC_DIR).length).toBeGreaterThan(100);
    expect(listSourceFiles(SRC_DIR).some((f) => f.endsWith('referral.service.ts'))).toBe(true);
  });

  it('uses no weak randomness outside the reviewed list', () => {
    const findings = findWeakRandomUses(SRC_DIR).filter(
      (use) => !(use.file in NON_SECURITY_RANDOM),
    );

    expect(
      findings.map((use) => `${use.file}:${use.line} — Math.random(); use node:crypto`),
    ).toEqual([]);
  });

  it('pins the reviewed list and rejects stale entries', () => {
    expect(Object.keys(NON_SECURITY_RANDOM)).toHaveLength(0);

    // An entry whose call site was since fixed or deleted must be removed, or
    // the list rots into cover for the next weak draw in that file.
    const current = new Set(findWeakRandomUses(SRC_DIR).map((use) => use.file));
    expect(Object.keys(NON_SECURITY_RANDOM).filter((f) => !current.has(f))).toEqual([]);
  });

  it('is not satisfied by prose, and reports a real call', () => {
    // The failure mode this ratchet exists to avoid, pinned as a fixture pair:
    // a comment (or a string, or an identifier that merely reads like it)
    // must not register, and a real reference must.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csprng-ratchet-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'prose.ts'),
        `
        /**
         * The token is drawn from node:crypto rather than Math.random(), whose
         * state is recoverable. Math.random() must never be used here.
         */
        export const token = () => randomBytes(16).toString('hex');
        export const label = 'Math.random()';
        export const notIt = { Math: { random: 1 } };
        export const alsoNotIt = mathRandom();
        `,
      );
      fs.writeFileSync(
        path.join(dir, 'weak.ts'),
        `export const id = () => Math.random().toString(36).slice(2);\n`,
      );

      const files = findWeakRandomUses(dir).map((use) => use.file);
      expect(files).toContain('weak.ts');
      expect(files).not.toContain('prose.ts');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches an aliased reference, not only a direct call', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csprng-alias-'));
    try {
      fs.writeFileSync(path.join(dir, 'alias.ts'), `const r = Math.random;\nexport const v = r();\n`);
      expect(findWeakRandomUses(dir).map((use) => use.file)).toContain('alias.ts');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
