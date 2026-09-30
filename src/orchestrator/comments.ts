import type { DiffCheck, DiffFinding } from '../model/types.ts';

/** `text` in a Markdown code block whose fence is longer than any backtick run inside it. */
export function codeBlock(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(longest + 1);
  return [fence, text.replace(/\n+$/, ''), fence].join('\n');
}

function bullets(items: readonly string[]): string {
  return items.length === 0 ? '- (none)' : items.map((item) => `- ${item}`).join('\n');
}

/** Question text recorded for a session that stopped and waits without a structured question. */
export function sessionWaitingSummary(sessionUrl: string): string {
  return `Devin stopped and is waiting without recording a question; open the session to see what it needs: ${sessionUrl}`;
}

const FLAG_GUIDANCE: Partial<Record<DiffCheck, string>> = {
  'deletion-only': 'Some real fixes only delete code; check that this one removes the bug rather than the behaviour under test.',
  'check-silenced':
    'A person should look at each added suppression comment and confirm the fix needs it, rather than silencing a check that found the bug.',
};

/** Findings that do not fail verification but that should be looked at before the merge, as message text. */
export function verificationFlagsText(flags: readonly DiffFinding[]): string {
  const guidance = [...new Set(flags.map((flag) => flag.check))].flatMap((check) => FLAG_GUIDANCE[check] ?? []);
  return [
    bullets(flags.map((flag) => (flag.file === '' ? `${flag.check}: ${flag.detail}` : `${flag.check} in \`${flag.file}\`: ${flag.detail}`))),
    ...guidance,
  ].join('\n\n');
}
