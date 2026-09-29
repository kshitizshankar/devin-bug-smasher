/**
 * Devin API v3 wire shapes, as documented at https://docs.devin.ai/api-reference/v3 (field names are the
 * provider's). Responses are validated at runtime by the parsers in `parse.ts` before use.
 */

export const DEVIN_SESSION_STATUSES = ['new', 'claimed', 'running', 'exit', 'error', 'suspended', 'resuming'] as const;
export type DevinSessionStatus = (typeof DEVIN_SESSION_STATUSES)[number];

export const DEVIN_STATUS_DETAILS = [
  'working',
  'waiting_for_user',
  'waiting_for_approval',
  'finished',
  'inactivity',
  'user_request',
  'usage_limit_exceeded',
  'out_of_credits',
  'out_of_quota',
  'no_quota_allocation',
  'payment_declined',
  'org_usage_limit_exceeded',
  'user_usage_limit_exceeded',
  'total_session_limit_exceeded',
  'contract_expired',
  'error',
] as const;
export type DevinStatusDetail = (typeof DEVIN_STATUS_DETAILS)[number];

/** `SessionCreateRequest` (POST /v3/organizations/{org_id}/sessions), limited to the fields this service sets. */
export interface WireSessionCreateRequest {
  prompt: string;
  title: string | null;
  tags: string[];
  max_acu_limit: number;
  structured_output_schema: Record<string, unknown>;
  structured_output_required: false;
  secret_ids: string[];
  session_secrets: never[];
  repos: string[] | null;
  playbook_id: string | null;
  knowledge_ids: string[] | null;
}

/** `SessionResponse`. */
export interface WireSession {
  session_id: string;
  url: string;
  status: string;
  status_detail?: string | null;
  tags: string[];
  org_id: string;
  created_at: number;
  updated_at: number;
  acus_consumed: number;
  pull_requests: { pr_url: string; pr_state: string | null }[];
  structured_output?: unknown;
  title?: string | null;
  is_archived?: boolean;
  playbook_id?: string | null;
}

/** `PaginatedResponse[...]`. */
export interface WirePage<T> {
  items: T[];
  has_next_page?: boolean;
  end_cursor?: string | null;
  total?: number | null;
}

/** `SessionMessage`. */
export interface WireSessionMessage {
  event_id: string;
  source: 'devin' | 'user';
  message: string;
  created_at: number;
}

export const DEVIN_REVIEW_STATUSES = ['pending', 'running', 'completed', 'errored', 'cancelled', 'skipped'] as const;
export type DevinReviewStatus = (typeof DEVIN_REVIEW_STATUSES)[number];

/** `PrReviewResponse`. */
export interface WirePrReview {
  status: string;
  repo_path: string;
  pr_number: number;
  commit_sha: string;
  created_at: string;
}

/** `SessionInsightsAnalysis`. */
export interface WireInsightsAnalysis {
  issues?: { id?: string; title?: string; issue: string; impact: string; label: string }[];
  action_items?: { action_item: string; type?: string; issue_id?: string | null }[];
  suggested_prompt?: {
    original_prompt: string;
    suggested_prompt: string;
    feedback_items?: { summary: string; excerpt: string; details: string; issue_id?: string | null }[];
  } | null;
  note_usage?: {
    good_usages?: { note_id: string; reason: string; message: string }[];
    bad_usages?: { note_id: string; reason: string; message: string }[];
  } | null;
  skill_usage?: {
    good_usages?: { skill_name: string; reason: string; repo_origin: string; skill_rel_path: string }[];
    bad_usages?: { skill_name: string; reason: string; repo_origin: string; skill_rel_path: string }[];
  } | null;
}

/** `SessionInsightsResponse` (a `SessionResponse` plus analysis fields). */
export interface WireSessionInsights extends WireSession {
  num_user_messages: number;
  num_devin_messages: number;
  session_size: string;
  analysis?: WireInsightsAnalysis | null;
  analysis_status?: 'started' | 'completed' | 'failed' | null;
}
