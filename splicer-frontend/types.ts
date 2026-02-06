export interface Repository {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  private: boolean;
  stargazers_count: number;
  updated_at: string;
}

export interface UserProfile {
  id: string;
  email?: string;
  avatar_url?: string;
  full_name?: string;
  user_name?: string;
}

export interface GalaxyProps {
  focal?: [number, number];
  rotation?: [number, number];
  starSpeed?: number;
  density?: number;
  hueShift?: number;
  disableAnimation?: boolean;
  speed?: number;
  mouseInteraction?: boolean;
  glowIntensity?: number;
  saturation?: number;
  mouseRepulsion?: boolean;
  twinkleIntensity?: number;
  rotationSpeed?: number;
  repulsionStrength?: number;
  autoCenterRepulsion?: number;
  transparent?: boolean;
}

export type ViewState = 'landing' | 'main';

export interface PreviewSession {
  session_id: string;
  status: 'pending' | 'cloning' | 'installing' | 'starting' | 'ready' | 'failed' | 'stopped';
  preview_url: string | null;
  error_message: string | null;
}

// ===== Chat & Thread Types =====

export interface Thread {
  id: string;
  user_id: string;
  title: string | null;
  source_repo: string | null;
  target_repo: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  thread_id: string;
  role: 'human' | 'assistant' | 'tool';
  content: string;
  metadata: MessageMetadata | null;
  created_at: string;
}

export interface MessageMetadata {
  langgraph_node?: string;
  tool_calls?: ToolCall[];
  thinking?: string;
  run_id?: string;
  isMigration?: boolean;
  migrationData?: {
    stage: string;
    planner?: unknown;
    source?: unknown;
    target?: unknown;
    paster?: unknown;
    integrator?: unknown;
    checker?: unknown;
  };
  [key: string]: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  state: 'pending' | 'completed' | 'error';
}

export interface StreamingMessage {
  id: string;
  role: 'human' | 'assistant' | 'tool';
  content: string;
  metadata?: MessageMetadata;
  isStreaming?: boolean;
}

export interface AgentInput {
  user_input: string;
  source_repo: string;
  target_repo: string;
  branch: string;
}

export interface StreamEvent {
  event: string;
  data: unknown;
}

export type ChatViewState = 'landing' | 'workspace';

// ===== Guest Mode Types =====

export interface GuestRepo {
  id: string;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  previewUrl: string;
}

export interface RateLimitError {
  error: 'rate_limit_exceeded' | 'check_failed' | 'network_error' | string;
  message: string;
  next_allowed_at: string | null;
  time_remaining_seconds: number | null;
}

// ===== User Rate Limit Types =====

export interface UserRateLimitError {
  error: 'rate_limit_exceeded' | 'check_failed' | 'network_error' | string;
  message: string;
  next_allowed_at: string | null;
  time_remaining_seconds: number | null;
  usage_count?: number;
  max_calls?: number;
}

export interface GuestStreamTokenResponse {
  stream_url: string;
  token: string;
  thread_id: string;
  usage_id: string;
}

// Guest test repositories
export const GUEST_TEST_REPOS: GuestRepo[] = [
  {
    id: 'demo-1',
    owner: 'adamblackman',
    name: '0pera1te-demo-1',
    full_name: 'adamblackman/0pera1te-demo-1',
    description: 'Demo repository 1 for testing migrations',
    previewUrl: 'https://0pera1te-demo-1.vercel.app/',
  },
  {
    id: 'demo-2',
    owner: 'adamblackman',
    name: '0pera1te-demo-2',
    full_name: 'adamblackman/0pera1te-demo-2',
    description: 'Demo repository 2 for testing migrations',
    previewUrl: 'https://0pera1te-demo-2.vercel.app/',
  },
];

/**
 * Generate a guest branch name with ISO timestamp format.
 * Format: splice-guest-YYYYMMDDHHmmss
 */
export function generateGuestBranchName(): string {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '')
    .replace(/\.\d{3}Z$/, '');
  return `splice-guest-${timestamp}`;
}

/**
 * Convert a GuestRepo to a Repository type for compatibility.
 */
export function guestRepoToRepository(guestRepo: GuestRepo): Repository {
  // Generate unique numeric ID from the full string to avoid collisions
  let hash = 0;
  for (let i = 0; i < guestRepo.id.length; i++) {
    hash = ((hash << 5) - hash) + guestRepo.id.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return {
    id: Math.abs(hash),
    name: guestRepo.name,
    full_name: guestRepo.full_name,
    description: guestRepo.description,
    html_url: `https://github.com/${guestRepo.full_name}`,
    private: false,
    stargazers_count: 0,
    updated_at: new Date().toISOString(),
  };
}
