import { useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { 
  StreamingMessage, 
  AgentInput, 
  ToolCall, 
  MessageMetadata, 
  Repository,
  RateLimitError,
  UserRateLimitError,
  generateGuestBranchName,
} from '../types';
import { 
  MigrationData, 
  MigrationStage, 
  PlannerData, 
  SourceData, 
  TargetData, 
  PasterData, 
  IntegratorData, 
  CheckerData 
} from '../components/MigrationStreamMessage';

// Default fallback repos when none selected
const DEFAULT_SOURCE_REPO = 'adamblackman/0pera1te-demo-2';
const DEFAULT_TARGET_REPO = 'adamblackman/0pera1te-demo-1';

interface UseAgentStreamOptions {
  threadId: string | null;
  sourceRepo?: Repository | null;
  targetRepo?: Repository | null;
  /** Custom branch name (used for guest mode) */
  branch?: string;
  /** Whether this is a guest mode session */
  isGuestMode?: boolean;
  onThreadId?: (id: string) => void;
  onFinish?: (messages: StreamingMessage[]) => void;
  onError?: (error: Error) => void;
  /** Called when guest rate limit is exceeded */
  onRateLimitExceeded?: (info: RateLimitError) => void;
  /** Called when authenticated user rate limit is exceeded */
  onUserRateLimitExceeded?: (info: UserRateLimitError) => void;
}

/** Represents a node update from the agent graph */
export interface NodeUpdate {
  node: string;
  data: Record<string, unknown>;
  timestamp: number;
}

interface StreamState {
  messages: StreamingMessage[];
  isLoading: boolean;
  error: Error | null;
  currentToolCalls: ToolCall[];
  thinking: string | null;
  /** Track which node is currently executing */
  currentNode: string | null;
  /** Accumulated node updates for display */
  nodeUpdates: NodeUpdate[];
  /** Custom status messages from the agent */
  statusMessage: string | null;
  /** Structured migration data for formatted display */
  migrationData: MigrationData;
}

/** Initial migration data state */
const initialMigrationData: MigrationData = {
  stage: 'idle',
};

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

/**
 * Cancel a running agent on the server.
 * Uses the LangGraph Server cancel API via the Edge Function proxy.
 */
async function cancelRunOnServer(
  threadId: string,
  runId: string,
  accessToken: string
): Promise<void> {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/agent/threads/${threadId}/runs/${runId}/cancel?action=interrupt`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    // Silently ignore errors (run may have already completed)
    if (!response.ok) {
      console.debug('Cancel request returned:', response.status);
    }
  } catch (err) {
    // Silently ignore network errors
    console.debug('Cancel request failed:', err);
  }
}

/**
 * LangGraph SSE Event Types
 * @see https://docs.langchain.com/langsmith/streaming
 */
type LangGraphEventType = 
  | 'metadata'      // Run metadata at stream start
  | 'updates'       // State updates after each node (format: {node_name: state_delta})
  | 'messages'      // LLM token chunks (format: [message_chunk, metadata])  
  | 'messages-tuple'// Same as messages, explicit tuple format
  | 'custom'        // Custom events from get_stream_writer()
  | 'values'        // Full state after each super-step
  | 'debug'         // Debug information
  | 'error'         // Error events
  | 'end';          // Stream end signal

/** Map node names to migration stages */
const NODE_TO_STAGE: Record<string, MigrationStage> = {
  splicer_setup: 'planning',
  planner_api: 'planning',
  target_agent: 'analyzing',
  source_agent: 'analyzing',
  paster_agent: 'pasting',
  integrator_agent: 'integrating',
  check_node: 'checking',
  check_revisor_agent: 'checking',
  clean_up: 'cleanup',
};

/** Parse planner node data */
function parsePlannerData(data: Record<string, unknown>): PlannerData | null {
  if (!data.end_goal) return null;
  
  const parseStringArray = (val: unknown): string[] => {
    if (Array.isArray(val)) return val.map(String);
    if (typeof val === 'string') return [val];
    return [];
  };
  
  return {
    source_exploration: parseStringArray(data.source_exploration),
    target_exploration: parseStringArray(data.target_exploration),
    integration_instructions: typeof data.integration_instructions === 'string' 
      ? data.integration_instructions 
      : undefined,
    end_goal: String(data.end_goal),
  };
}

/** Parse source agent data */
function parseSourceData(data: Record<string, unknown>): SourceData | null {
  const parseStringArray = (val: unknown): string[] => {
    if (Array.isArray(val)) return val.map(String);
    if (typeof val === 'string') return [val];
    return [];
  };
  
  return {
    summary: parseStringArray(data.source_summary),
    metadata: (data.source_metadata as Record<string, unknown>) || {},
    paths: parseStringArray(data.source_path),
  };
}

/** Parse target agent data */
function parseTargetData(data: Record<string, unknown>): TargetData | null {
  const parseStringArray = (val: unknown): string[] => {
    if (Array.isArray(val)) return val.map(String);
    if (typeof val === 'string') return [val];
    return [];
  };
  
  return {
    summary: parseStringArray(data.target_summary),
    metadata: (data.target_metadata as Record<string, unknown>) || {},
    integration_instructions: parseStringArray(data.target_integration_instructions),
  };
}

/** Parse paster agent data */
function parsePasterData(data: Record<string, unknown>): PasterData | null {
  if (!data.pasted_files) return null;
  
  const files = Array.isArray(data.pasted_files) ? data.pasted_files : [];
  const parsedFiles = files.map(f => {
    if (typeof f === 'string') {
      try {
        return JSON.parse(f);
      } catch {
        return { path: f, type: 'unknown', original_source_path: '' };
      }
    }
    return f as { path: string; type: string; original_source_path: string };
  });
  
  return { pasted_files: parsedFiles };
}

/** Parse integrator agent data */
function parseIntegratorData(data: Record<string, unknown>): IntegratorData | null {
  if (!data.integration_summary) return null;
  return { integration_summary: String(data.integration_summary) };
}

/** Parse checker node data */
function parseCheckerData(data: Record<string, unknown>): CheckerData | null {
  const checkOutput = data.check_output;
  if (!checkOutput) return null;
  
  let parsed: { errors?: string[]; passed?: boolean } = {};
  
  if (typeof checkOutput === 'string') {
    try {
      parsed = JSON.parse(checkOutput);
    } catch {
      return { errors: [], passed: true };
    }
  } else if (typeof checkOutput === 'object') {
    parsed = checkOutput as { errors?: string[]; passed?: boolean };
  }
  
  return {
    errors: Array.isArray(parsed.errors) ? parsed.errors : [],
    passed: parsed.passed ?? true,
  };
}

export function useAgentStream(options: UseAgentStreamOptions & { skipInitialLoad?: boolean }) {
  const { 
    threadId, 
    sourceRepo, 
    targetRepo, 
    branch,
    isGuestMode = false,
    skipInitialLoad = false,
    onThreadId, 
    onFinish, 
    onError,
    onRateLimitExceeded,
    onUserRateLimitExceeded,
  } = options;
  
  const [state, setState] = useState<StreamState>({
    messages: [],
    isLoading: false,
    error: null,
    currentToolCalls: [],
    thinking: null,
    currentNode: null,
    nodeUpdates: [],
    statusMessage: null,
    migrationData: { ...initialMigrationData },
  });
  
  const migrationDataRef = useRef<MigrationData>({ ...initialMigrationData });
  
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<StreamingMessage[]>([]);
  const nodeUpdatesRef = useRef<NodeUpdate[]>([]);
  // Track current run for cancellation
  const currentRunIdRef = useRef<string | null>(null);
  const currentThreadIdRef = useRef<string | null>(null);
  // Track if we've already loaded history for this thread
  const loadedThreadIdRef = useRef<string | null>(null);

  // Load thread history on mount or threadId change
  // Skip if we have an initial message (new thread with no history)
  useEffect(() => {
    if (threadId && !skipInitialLoad && loadedThreadIdRef.current !== threadId) {
      loadThreadHistory(threadId);
    }
  }, [threadId, skipInitialLoad]);

  const loadThreadHistory = async (tid: string) => {
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('thread_id', tid)
        .order('created_at', { ascending: true });

      if (error) throw error;

      const loadedMessages: StreamingMessage[] = (data || []).map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        metadata: msg.metadata,
        isStreaming: false,
      }));

      // Only update if we haven't already added optimistic messages
      // (prevents race condition with initial message submission)
      if (messagesRef.current.length === 0) {
        messagesRef.current = loadedMessages;
        setState((prev) => ({ ...prev, messages: loadedMessages }));
      }
      loadedThreadIdRef.current = tid;
    } catch (err) {
      console.error('Failed to load thread history:', err);
    }
  };

  const createThread = async (): Promise<string> => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

    const { data, error } = await supabase
      .from('threads')
      .insert({
        user_id: user.id,
        source_repo: sourceRepo?.full_name || null,
        target_repo: targetRepo?.full_name || null,
      })
      .select()
      .single();

    if (error) throw error;
    return data.id;
  };

  const saveMessage = async (
    tid: string,
    role: 'human' | 'assistant' | 'tool',
    content: string,
    metadata?: MessageMetadata
  ) => {
    const { error } = await supabase.from('messages').insert({
      thread_id: tid,
      role,
      content,
      metadata,
    });
    if (error) console.error('Failed to save message:', error);
  };

  const submit = useCallback(async (
    userMessage: string,
    optimisticValues?: { threadId?: string }
  ) => {
    // Cancel any existing stream
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Set stage to 'planning' immediately so the loader shows right away
    const planningState: MigrationData = { stage: 'planning' };
    
    // IMPORTANT: Add optimistic messages IMMEDIATELY, before any async operations
    // This ensures the user message and "Planning Migration..." appear instantly
    // and prevents race conditions with loadThreadHistory
    const userMsg: StreamingMessage = {
      id: `temp-${Date.now()}`,
      role: 'human',
      content: userMessage,
      isStreaming: false,
    };
    
    const optimisticAssistantMsg: StreamingMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      metadata: { isMigration: true },
      isStreaming: true,
    };
    
    messagesRef.current = [...messagesRef.current, userMsg, optimisticAssistantMsg];
    
    setState((prev) => ({
      ...prev,
      isLoading: true,
      error: null,
      thinking: null,
      currentToolCalls: [],
      currentNode: null,
      nodeUpdates: [],
      statusMessage: null,
      migrationData: planningState,
      messages: [...messagesRef.current],
    }));
    nodeUpdatesRef.current = [];
    migrationDataRef.current = planningState;
    currentRunIdRef.current = null;

    try {
      // Determine branch name - use provided or default
      const branchName = branch || (isGuestMode ? generateGuestBranchName() : 'splice');
      
      // For guest mode, we don't need auth
      let session = null;
      if (!isGuestMode) {
        const { data } = await supabase.auth.getSession();
        session = data.session;
        if (!session) throw new Error('Not authenticated');
      }

      // Create or use existing thread (for authenticated users only)
      // Guest threads are created by the server
      let tid = threadId || optimisticValues?.threadId;
      if (!tid && !isGuestMode) {
        tid = await createThread();
        onThreadId?.(tid);
      }
      // Store for use in stop()
      currentThreadIdRef.current = tid || null;

      // Save user message to DB (skip for guests - server handles it)
      if (!isGuestMode && tid) {
        await saveMessage(tid, 'human', userMessage);
      }

      // Prepare agent input with selected repos or fallback defaults
      const agentInput: AgentInput = {
        user_input: userMessage,
        source_repo: sourceRepo?.full_name || DEFAULT_SOURCE_REPO,
        target_repo: targetRepo?.full_name || DEFAULT_TARGET_REPO,
        branch: branchName,
      };

      // Prepare the request body (used for both token request and streaming)
      const requestBody = {
        assistant_id: 'splicer',
        input: { 
          messages: [{ role: 'human', content: userMessage }], 
          ...agentInput 
        },
        config: {
          configurable: {
            thread_id: tid || undefined,
          },
        },
        // Stream ALL available modes for maximum information
        // - messages-tuple: LLM tokens with metadata
        // - updates: State updates after each node
        // - debug: Maximum debugging information
        // - custom: Custom events from stream_writer
        stream_mode: ['messages-tuple', 'updates', 'debug', 'custom'],
      };

      // ============ Step 1: Get Stream Token ============
      // Request a short-lived JWT from the Edge Function
      // Guest mode uses x-guest-mode header instead of Authorization
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      
      if (isGuestMode) {
        headers['x-guest-mode'] = 'true';
      } else if (session) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }

      const tokenResponse = await fetch(`${SUPABASE_URL}/functions/v1/agent/stream-token`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: abortControllerRef.current.signal,
      });

      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.json().catch(() => ({}));
        
        // Handle rate limit error (429)
        if (tokenResponse.status === 429 && errorData.error === 'rate_limit_exceeded') {
          if (isGuestMode) {
            // Guest rate limit
            const rateLimitInfo: RateLimitError = {
              error: 'rate_limit_exceeded',
              message: errorData.message,
              next_allowed_at: errorData.next_allowed_at,
              time_remaining_seconds: errorData.time_remaining_seconds,
            };
            onRateLimitExceeded?.(rateLimitInfo);
            throw new Error('Guest rate limit exceeded');
          } else {
            // Authenticated user rate limit
            const userRateLimitInfo: UserRateLimitError = {
              error: 'rate_limit_exceeded',
              message: errorData.message,
              next_allowed_at: errorData.next_allowed_at,
              time_remaining_seconds: errorData.time_remaining_seconds,
              usage_count: errorData.usage_count,
              max_calls: errorData.max_calls,
            };
            onUserRateLimitExceeded?.(userRateLimitInfo);
            throw new Error('User rate limit exceeded');
          }
        }
        
        throw new Error(errorData.error || errorData.details || `Failed to get stream token: HTTP ${tokenResponse.status}`);
      }

      const tokenData = await tokenResponse.json();
      const { stream_url, token, thread_id: serverThreadId } = tokenData;
      
      // For guest mode, use the thread ID from server response
      if (isGuestMode && serverThreadId) {
        tid = serverThreadId;
        currentThreadIdRef.current = tid;
        onThreadId?.(tid);
      }
      
      if (!stream_url || !token) {
        throw new Error('Invalid stream token response: missing stream_url or token');
      }

      // ============ Step 2: Stream from Cloud Run ============
      // Use the JWT to stream directly to Cloud Run (bypasses Edge Function for streaming)
      const response = await fetch(stream_url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        // Handle specific error cases
        if (response.status === 401) {
          throw new Error('Stream token expired or invalid. Please try again.');
        }
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Stream failed: HTTP ${response.status}`);
      }

      // Process SSE stream
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      // Use the optimistic assistant message we created earlier
      let currentAssistantMsg: StreamingMessage | null = 
        messagesRef.current.find(m => m.role === 'assistant' && m.isStreaming) || null;
      // Accumulate raw content separately for DB persistence (not displayed during streaming)
      let rawContentForDB = '';
      // Track current event type from SSE "event:" line
      let currentEventType: LangGraphEventType | null = null;
      // Flag to exit the read loop when stream ends
      let streamEnded = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done || streamEnded) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          // Skip empty lines and comments
          if (!line.trim() || line.startsWith(':')) continue;

          // Parse SSE event type line
          if (line.startsWith('event:')) {
            currentEventType = line.slice(6).trim() as LangGraphEventType;
            continue;
          }

          // Parse SSE data line
          if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const data = JSON.parse(dataStr);

              // Route to appropriate handler based on event type
              switch (currentEventType) {
                case 'metadata': {
                  // Run metadata at stream start - contains run_id, thread_id, etc.
                  if (data.run_id) {
                    currentRunIdRef.current = data.run_id;
                  }
                  // Set stage to planning immediately when stream starts
                  migrationDataRef.current = {
                    ...migrationDataRef.current,
                    stage: 'planning',
                  };
                  // Create assistant message for migration view to render into
                  if (!currentAssistantMsg) {
                    currentAssistantMsg = {
                      id: `assistant-${Date.now()}`,
                      role: 'assistant',
                      content: '', // Empty - migration view will display formatted content
                      metadata: { isMigration: true },
                      isStreaming: true,
                    };
                    messagesRef.current = [...messagesRef.current, currentAssistantMsg];
                  }
                  setState((prev) => ({
                    ...prev,
                    messages: [...messagesRef.current],
                    migrationData: { ...migrationDataRef.current },
                  }));
                  break;
                }

                case 'debug': {
                  // Debug events - only check for end signal, don't display
                  if (data.type === 'task_result' && data.payload?.name === '__end__') {
                    console.log('[useAgentStream] Debug: Received __end__ task result');
                    streamEnded = true;
                  }
                  break;
                }

                case 'updates': {
                  // State updates after each node completes
                  // Format: { node_name: { ...state_delta } }
                  const nodeNames = Object.keys(data);
                  for (const nodeName of nodeNames) {
                    // LangGraph signals graph completion with __end__ node
                    if (nodeName === '__end__') {
                      console.log('[useAgentStream] Received __end__ node, stream complete');
                      migrationDataRef.current = {
                        ...migrationDataRef.current,
                        stage: 'complete',
                      };
                      setState((prev) => ({
                        ...prev,
                        migrationData: { ...migrationDataRef.current },
                      }));
                      streamEnded = true;
                      break;
                    }
                    
                    const nodeData = data[nodeName] as Record<string, unknown>;
                    
                    // Record the node update
                    const update: NodeUpdate = {
                      node: nodeName,
                      data: nodeData,
                      timestamp: Date.now(),
                    };
                    nodeUpdatesRef.current = [...nodeUpdatesRef.current, update];

                    // Accumulate raw content for DB persistence only (not displayed during streaming)
                    // MigrationStreamMessage handles the formatted display via migrationData
                    rawContentForDB += `\n\n[${nodeName}]: ${JSON.stringify(nodeData)}`;
                    
                    // Update migration data based on node type
                    const newStage = NODE_TO_STAGE[nodeName] || migrationDataRef.current.stage;
                    
                    switch (nodeName) {
                      case 'planner_api': {
                        const plannerData = parsePlannerData(nodeData);
                        if (plannerData) {
                          migrationDataRef.current = {
                            ...migrationDataRef.current,
                            stage: 'analyzing',
                            planner: plannerData,
                          };
                        } else {
                          migrationDataRef.current = {
                            ...migrationDataRef.current,
                            stage: 'planning',
                          };
                        }
                        break;
                      }
                      case 'source_agent': {
                        const sourceData = parseSourceData(nodeData);
                        if (sourceData) {
                          migrationDataRef.current = {
                            ...migrationDataRef.current,
                            stage: migrationDataRef.current.target ? 'pasting' : 'analyzing',
                            source: sourceData,
                          };
                        }
                        break;
                      }
                      case 'target_agent': {
                        const targetData = parseTargetData(nodeData);
                        if (targetData) {
                          migrationDataRef.current = {
                            ...migrationDataRef.current,
                            stage: migrationDataRef.current.source ? 'pasting' : 'analyzing',
                            target: targetData,
                          };
                        }
                        break;
                      }
                      case 'paster_agent': {
                        const pasterData = parsePasterData(nodeData);
                        if (pasterData) {
                          migrationDataRef.current = {
                            ...migrationDataRef.current,
                            stage: 'integrating',
                            paster: pasterData,
                          };
                        }
                        break;
                      }
                      case 'integrator_agent': {
                        const integratorData = parseIntegratorData(nodeData);
                        if (integratorData) {
                          migrationDataRef.current = {
                            ...migrationDataRef.current,
                            stage: 'checking',
                            integrator: integratorData,
                          };
                        }
                        break;
                      }
                      case 'check_node': {
                        const checkerData = parseCheckerData(nodeData);
                        if (checkerData) {
                          migrationDataRef.current = {
                            ...migrationDataRef.current,
                            stage: 'cleanup',
                            checker: checkerData,
                          };
                        }
                        break;
                      }
                      case 'clean_up': {
                        migrationDataRef.current = {
                          ...migrationDataRef.current,
                          stage: 'complete',
                        };
                        break;
                      }
                      default: {
                        if (newStage !== migrationDataRef.current.stage) {
                          migrationDataRef.current = {
                            ...migrationDataRef.current,
                            stage: newStage,
                          };
                        }
                      }
                    }
                    
                    setState((prev) => ({
                      ...prev,
                      nodeUpdates: [...nodeUpdatesRef.current],
                      currentNode: nodeName,
                      migrationData: { ...migrationDataRef.current },
                    }));
                  }
                  break;
                }

                case 'messages':
                case 'messages-tuple': {
                  // LLM token streaming - format: [message_chunk, metadata]
                  const [messageChunk, metadata] = Array.isArray(data) ? data : [data, {}];
                  const nodeName = metadata?.langgraph_node;
                  
                  // Stream ALL content from messages - including structured output tokens
                  const chunkContent = messageChunk?.content || messageChunk?.text || '';
                  if (chunkContent) {
                    // Accumulate for DB storage only (MigrationStreamMessage handles display)
                    rawContentForDB += chunkContent;
                  }

                  // Handle tool calls in message chunks
                  if (messageChunk?.tool_calls?.length) {
                    const toolCalls: ToolCall[] = messageChunk.tool_calls.map((tc: any) => ({
                      id: tc.id || `tool-${Date.now()}`,
                      name: tc.name,
                      args: tc.args,
                      state: 'pending' as const,
                    }));

                    // Accumulate tool calls for DB storage
                    const toolContent = '\n\n**Tool Calls:**\n' + toolCalls.map(tc => 
                      `- \`${tc.name}\`(${JSON.stringify(tc.args)})`
                    ).join('\n');
                    rawContentForDB += toolContent;

                    setState((prev) => ({
                      ...prev,
                      currentToolCalls: [...prev.currentToolCalls, ...toolCalls],
                    }));
                  }

                  // Show thinking/reasoning if present
                  if (messageChunk?.additional_kwargs?.thinking || messageChunk?.thinking) {
                    const thinking = messageChunk.additional_kwargs?.thinking || messageChunk.thinking;
                    rawContentForDB += `\n\n**Thinking:**\n${thinking}`;
                    setState((prev) => ({ ...prev, thinking }));
                  }
                  break;
                }

                case 'custom': {
                  // Custom events from get_stream_writer() in agent nodes
                  // Accumulate for DB storage only
                  rawContentForDB += `\n\n[custom]: ${JSON.stringify(data)}`;
                  
                  // Also update state for specific custom event types
                  if (data.type === 'status' || data.message) {
                    setState((prev) => ({
                      ...prev,
                      statusMessage: data.message || data.status,
                      currentNode: data.node || prev.currentNode,
                    }));
                  }
                  
                  if (data.type === 'thinking' || data.thinking) {
                    setState((prev) => ({
                      ...prev,
                      thinking: data.thinking || data.content,
                    }));
                  }

                  if (data.type === 'tool_result') {
                    const toolResultContent = `\n\n**Tool Result (${data.tool_call_id}):**\n${data.content}`;
                    rawContentForDB += toolResultContent;
                    
                    setState((prev) => ({
                      ...prev,
                      currentToolCalls: prev.currentToolCalls.map((tc) =>
                        tc.id === data.tool_call_id
                          ? { ...tc, result: data.content, state: 'completed' as const }
                          : tc
                      ),
                    }));
                  }
                  break;
                }

                case 'values': {
                  // Full state after each super-step
                  // Accumulate for DB storage only
                  rawContentForDB += `\n\n[values]: ${JSON.stringify(data)}`;
                  break;
                }

                case 'error': {
                  // Error event from the stream
                  const errorMsg = data.error || data.message || 'Unknown stream error';
                  rawContentForDB += `\n\n**Error:** ${errorMsg}`;
                  throw new Error(errorMsg);
                }

                case 'end': {
                  // Stream end signal - exit the read loop
                  console.log('[useAgentStream] Received explicit end event');
                  streamEnded = true;
                  break;
                }

                default: {
                  // Log unknown event types for debugging
                  console.log(`[useAgentStream] Unknown event type: ${currentEventType}`, data);
                  rawContentForDB += `\n\n[${currentEventType || 'unknown'}]: ${JSON.stringify(data)}`;
                  
                  // Still try to handle common patterns
                  if (data.type === 'message_chunk' || data.content !== undefined) {
                    const chunk = data.content || data.text || '';
                    if (chunk) {
                      rawContentForDB += chunk;
                    }
                  }
                }
              }

            } catch (parseError) {
              console.warn('Failed to parse SSE data:', dataStr, parseError);
            }
          }
          
          // Break out of line processing if stream ended
          if (streamEnded) break;
        }
      }

      console.log('[useAgentStream] Stream loop exited, finalizing...');
      
      // Finalize assistant message with migration data
      if (currentAssistantMsg) {
        currentAssistantMsg.isStreaming = false;
        // Include migration data in metadata for persistence
        currentAssistantMsg.metadata = {
          ...currentAssistantMsg.metadata,
          isMigration: true,
          migrationData: { ...migrationDataRef.current },
        };
        messagesRef.current = messagesRef.current.map((m) =>
          m.id === currentAssistantMsg!.id ? currentAssistantMsg! : m
        );

        // Save assistant message to DB with raw content and migration data
        // Skip for guest mode (server handles persistence)
        if (!isGuestMode && tid) {
          await saveMessage(tid, 'assistant', rawContentForDB, currentAssistantMsg.metadata);
        }
      }

      setState((prev) => ({
        ...prev,
        isLoading: false,
        messages: [...messagesRef.current],
        thinking: null,
        currentNode: null,
        statusMessage: null,
      }));

      console.log('[useAgentStream] Calling onFinish callback');
      onFinish?.(messagesRef.current);

    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return; // Cancelled, don't treat as error
      }
      
      const err = error instanceof Error ? error : new Error('Unknown error');
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err,
      }));
      onError?.(err);
    }
  }, [threadId, sourceRepo, targetRepo, branch, isGuestMode, onThreadId, onFinish, onError, onRateLimitExceeded, onUserRateLimitExceeded]);

  const stop = useCallback(async () => {
    // Immediately abort the fetch for responsive UX
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setState((prev) => ({ ...prev, isLoading: false }));

    // Cancel the run on the server (fire and forget)
    const runId = currentRunIdRef.current;
    const tid = currentThreadIdRef.current;
    if (runId && tid) {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        cancelRunOnServer(tid, runId, session.access_token);
      }
    }
    // Clear refs
    currentRunIdRef.current = null;
  }, []);

  const reset = useCallback(() => {
    stop();
    messagesRef.current = [];
    nodeUpdatesRef.current = [];
    migrationDataRef.current = { ...initialMigrationData };
    setState({
      messages: [],
      isLoading: false,
      error: null,
      currentToolCalls: [],
      thinking: null,
      currentNode: null,
      nodeUpdates: [],
      statusMessage: null,
      migrationData: { ...initialMigrationData },
    });
  }, [stop]);

  return {
    messages: state.messages,
    isLoading: state.isLoading,
    error: state.error,
    toolCalls: state.currentToolCalls,
    thinking: state.thinking,
    currentNode: state.currentNode,
    nodeUpdates: state.nodeUpdates,
    statusMessage: state.statusMessage,
    migrationData: state.migrationData,
    submit,
    stop,
    reset,
  };
}
