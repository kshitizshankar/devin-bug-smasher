import type { SessionInsights } from '../model/types.ts';
import { acuReading, acuUsed, type AcuReading } from './usage.ts';
import type { WireInsightsAnalysis } from './wire.ts';

export interface InsightsIssue {
  id: string | null;
  title: string | null;
  issue: string;
  impact: string;
  label: string;
}

export interface InsightsActionItem {
  type: string | null;
  text: string;
  issueId: string | null;
}

export interface KnowledgeUsage {
  noteId: string;
  reason: string;
  message: string;
}

export interface DevinInsights {
  sessionId: string;
  acus: AcuReading;
  sessionSize: string | null;
  userMessages: number | null;
  devinMessages: number | null;
  issues: InsightsIssue[];
  actionItems: InsightsActionItem[];
  suggestedPrompt: {
    original: string;
    suggested: string;
    feedback: { summary: string; excerpt: string; details: string }[];
  } | null;
  /** Knowledge notes Devin used, split the way the provider reports them; null when not reported. */
  knowledgeUsed: { helpful: KnowledgeUsage[]; unhelpful: KnowledgeUsage[] } | null;
  skillsUsed: { helpful: string[]; unhelpful: string[] } | null;
}

export type InsightsResult =
  | { status: 'available'; insights: DevinInsights }
  /** Generation was requested and has not finished. */
  | { status: 'pending' }
  | { status: 'unavailable'; reason: 'not-generated' | 'failed' | 'forbidden' | 'not-found'; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function notes(value: unknown): KnowledgeUsage[] {
  return records(value)
    .filter((item) => typeof item.note_id === 'string')
    .map((item) => ({ noteId: item.note_id as string, reason: str(item.reason) ?? '', message: str(item.message) ?? '' }));
}

function skills(value: unknown): string[] {
  return records(value)
    .map((item) => str(item.skill_name))
    .filter((name): name is string => name !== null);
}

function analysisInsights(sessionId: string, wire: Record<string, unknown>, analysis: WireInsightsAnalysis): DevinInsights {
  const raw = analysis as unknown as Record<string, unknown>;
  const prompt = isRecord(raw.suggested_prompt) ? raw.suggested_prompt : null;
  const noteUsage = isRecord(raw.note_usage) ? raw.note_usage : null;
  const skillUsage = isRecord(raw.skill_usage) ? raw.skill_usage : null;
  return {
    sessionId,
    acus: acuReading(wire.acus_consumed),
    sessionSize: str(wire.session_size),
    userMessages: typeof wire.num_user_messages === 'number' ? wire.num_user_messages : null,
    devinMessages: typeof wire.num_devin_messages === 'number' ? wire.num_devin_messages : null,
    issues: records(raw.issues)
      .filter((item) => typeof item.issue === 'string')
      .map((item) => ({
        id: str(item.id),
        title: str(item.title),
        issue: item.issue as string,
        impact: str(item.impact) ?? '',
        label: str(item.label) ?? '',
      })),
    actionItems: records(raw.action_items)
      .filter((item) => typeof item.action_item === 'string')
      .map((item) => ({ type: str(item.type), text: item.action_item as string, issueId: str(item.issue_id) })),
    suggestedPrompt:
      prompt !== null && typeof prompt.suggested_prompt === 'string'
        ? {
            original: str(prompt.original_prompt) ?? '',
            suggested: prompt.suggested_prompt,
            feedback: records(prompt.feedback_items).map((item) => ({
              summary: str(item.summary) ?? '',
              excerpt: str(item.excerpt) ?? '',
              details: str(item.details) ?? '',
            })),
          }
        : null,
    knowledgeUsed:
      noteUsage === null ? null : { helpful: notes(noteUsage.good_usages), unhelpful: notes(noteUsage.bad_usages) },
    skillsUsed:
      skillUsage === null ? null : { helpful: skills(skillUsage.good_usages), unhelpful: skills(skillUsage.bad_usages) },
  };
}

/** Interprets a `SessionInsightsResponse`. A missing analysis is `unavailable`, never an empty success. */
export function interpretInsights(sessionId: string, wire: unknown): InsightsResult {
  if (!isRecord(wire)) return { status: 'unavailable', reason: 'not-generated', detail: 'Insights response was not an object' };
  const status = wire.analysis_status ?? null;
  const analysis = isRecord(wire.analysis) ? (wire.analysis as WireInsightsAnalysis) : null;
  if (status === 'started') return { status: 'pending' };
  if (status === 'failed') return { status: 'unavailable', reason: 'failed', detail: 'Insights generation failed' };
  if (analysis === null) {
    return { status: 'unavailable', reason: 'not-generated', detail: 'No insights have been generated for this session' };
  }
  return { status: 'available', insights: analysisInsights(sessionId, wire, analysis) };
}

/** Projection onto the shared model's `SessionInsights` (ACUs only when reported; notes as plain text). */
export function toModelInsights(insights: DevinInsights): SessionInsights {
  const lines: string[] = [];
  for (const issue of insights.issues) lines.push(`Issue (${issue.impact || 'unknown impact'}): ${issue.title ?? issue.issue}`);
  for (const item of insights.actionItems) lines.push(`Action item${item.type ? ` [${item.type}]` : ''}: ${item.text}`);
  if (insights.suggestedPrompt !== null) lines.push(`Suggested prompt: ${insights.suggestedPrompt.suggested}`);
  if (insights.knowledgeUsed !== null) {
    for (const note of insights.knowledgeUsed.helpful) lines.push(`Knowledge used (helpful): ${note.noteId}`);
    for (const note of insights.knowledgeUsed.unhelpful) lines.push(`Knowledge used (unhelpful): ${note.noteId}`);
  }
  return { acuUsed: acuUsed(insights.acus), notes: lines.length > 0 ? lines.join('\n') : null };
}
