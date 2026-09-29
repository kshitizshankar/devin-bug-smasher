export interface BugKeyParts {
  owner: string;
  repo: string;
  number: number;
}

const KEY_PATTERN = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)#([1-9]\d*)$/;

export function formatBugKey(parts: BugKeyParts): string {
  const key = `${parts.owner}/${parts.repo}#${parts.number}`;
  if (parseBugKey(key) === null) {
    throw new Error(`Invalid bug key parts: ${key}`);
  }
  return key;
}

/** Parses `owner/repo#number`; returns `null` when the key is malformed. */
export function parseBugKey(key: string): BugKeyParts | null {
  const match = KEY_PATTERN.exec(key);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return null;
  return { owner: match[1], repo: match[2], number };
}
