import React, { useEffect, useState, useRef, useMemo } from "react";
import { supabase } from "../lib/supabaseClient";
import { PreviewSession, Repository } from "../types";
import { Loader2, AlertCircle } from "lucide-react";
import { motion } from "framer-motion";

export type RepoConfig = {
  owner: string;
  repo: string;
  branch: string;
  label: string;
};

export type WebContainerToolbarState = {
  activeRepo: RepoConfig | null;
  repoOptions: [RepoConfig, RepoConfig] | null;
  activeRepoIndex: number;
  isLoading: boolean;
  reposReady: boolean;
  sessionStatus?: string;
  onToggleRepo: () => void;
  onRefresh: () => void;
  /** Refresh and reset to target repo (index 0) - used when agent completes */
  onRefreshToTarget: () => void;
};

interface WebContainerProps {
  sourceRepo?: Repository | null;
  targetRepo?: Repository | null;
  /** Custom branch name for guest mode (e.g., splice-guest-20260204143025) */
  guestBranch?: string;
  /** Whether this is a guest mode session */
  isGuestMode?: boolean;
  onToolbarUpdate?: (state: WebContainerToolbarState | null) => void;
}

export const WebContainer: React.FC<WebContainerProps> = ({
  sourceRepo,
  targetRepo,
  guestBranch,
  isGuestMode = false,
  onToolbarUpdate,
}) => {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeRepoIndex, setActiveRepoIndex] = useState(0); // 0 = target (splice), 1 = source (main)
  const pollInterval = useRef<number | null>(null);
  // Track if we've started a session to avoid duplicate starts
  const hasStartedSession = useRef(false);

  // Check if repos are ready
  const reposReady = !!(sourceRepo && targetRepo);

  // Determine target branch name - use guest branch if provided, otherwise 'splice'
  const targetBranchName = guestBranch || "splice";

  // Build repo options from props (only when repos are available)
  const repoOptions: [RepoConfig, RepoConfig] | null = useMemo(() => {
    if (!sourceRepo || !targetRepo) return null;

    const [targetOwner, targetName] = targetRepo.full_name.split("/");
    const [sourceOwner, sourceName] = sourceRepo.full_name.split("/");

    return [
      // Index 0: Target repo with splice/guest branch (where changes are pushed)
      {
        owner: targetOwner,
        repo: targetName,
        branch: targetBranchName,
        label: `${targetRepo.full_name}/${targetBranchName}`,
      },
      // Index 1: Source repo with main branch (reading the feature to copy)
      {
        owner: sourceOwner,
        repo: sourceName,
        branch: "main",
        label: `${sourceRepo.full_name}/main`,
      },
    ];
  }, [sourceRepo, targetRepo, targetBranchName]);

  const activeRepo = repoOptions ? repoOptions[activeRepoIndex] : null;

  const stopPolling = React.useCallback(() => {
    if (pollInterval.current) {
      window.clearInterval(pollInterval.current);
      pollInterval.current = null;
    }
  }, []);

  const pollStatus = async (sessionId: string) => {
    try {
      let statusData: PreviewSession;
      
      if (isGuestMode) {
        // Guest mode: use direct fetch with x-guest-mode header
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const response = await fetch(
          `${supabaseUrl}/functions/v1/preview-status`,
          {
            method: "GET",
            headers: {
              "x-session-id": sessionId,
              "x-guest-mode": "true",
            },
          }
        );
        
        if (!response.ok) {
          throw new Error("Failed to poll status");
        }
        
        statusData = await response.json() as PreviewSession;
      } else {
        // Authenticated mode: use supabase client
        const { data, error } = await supabase.functions.invoke(
          "preview-status",
          {
            method: "GET",
            headers: { "x-session-id": sessionId },
          }
        );

        if (error) throw error;
        statusData = data as PreviewSession;
      }

      setSession(statusData);

      if (
        statusData.status === "ready" ||
        statusData.status === "failed" ||
        statusData.status === "stopped"
      ) {
        stopPolling();
        setIsLoading(false);
      }
    } catch (err: any) {
      console.error("Polling error:", err);
      // Don't stop polling immediately on one error, could be transient network issue
    }
  };

  const createSession = React.useCallback(
    async (repoConfig?: RepoConfig, forceNew: boolean = false) => {
      const config = repoConfig || activeRepo;
      if (!config) {
        console.warn("Cannot create session: no repo config available");
        return;
      }

      setIsLoading(true);
      setError(null);
      setSession(null);
      stopPolling();

      try {
        // For guest mode, use direct fetch with x-guest-mode header
        // For authenticated mode, use supabase.functions.invoke
        if (isGuestMode) {
          const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
          const response = await fetch(
            `${supabaseUrl}/functions/v1/preview-create`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-guest-mode": "true",
              },
              body: JSON.stringify({
                owner: config.owner,
                repo: config.repo,
                branch: config.branch,
                force_new: forceNew,
              }),
            }
          );

          const data = await response.json();

          if (!response.ok) {
            // Handle rate limit error for guests
            if (response.status === 429 && data.error === "rate_limit_exceeded") {
              throw new Error("Guest rate limit exceeded. Please sign in for unlimited access.");
            }
            throw new Error(data.error || "Failed to create preview session");
          }

          const newSession = data as PreviewSession;
          setSession(newSession);

          if (newSession.status !== "ready") {
            pollInterval.current = window.setInterval(() => {
              pollStatus(newSession.session_id);
            }, 1500);
          } else {
            setIsLoading(false);
          }
        } else {
          // Authenticated mode - use supabase client
          const { data, error } = await supabase.functions.invoke(
            "preview-create",
            {
              method: "POST",
              body: {
                owner: config.owner,
                repo: config.repo,
                branch: config.branch,
                // force_new: false allows session reuse (default)
                // force_new: true forces a fresh session (used for refresh button)
                force_new: forceNew,
              },
            }
          );

          if (error) throw error;

          const newSession = data as PreviewSession;
          setSession(newSession);

          // Start polling if session is not already ready
          if (newSession.status !== "ready") {
            pollInterval.current = window.setInterval(() => {
              pollStatus(newSession.session_id);
            }, 1500);
          } else {
            // Session was reused and is already ready
            setIsLoading(false);
          }
        }
      } catch (err: any) {
        console.error("Create session error:", err);
        setError(err.message || "Failed to create preview session.");
        setIsLoading(false);
      }
    },
    [activeRepo, stopPolling, isGuestMode]
  );

  const handleRefresh = React.useCallback(async () => {
    if (session?.session_id) {
      // Best effort stop
      try {
        if (isGuestMode) {
          // Guest mode: use direct fetch with x-guest-mode header
          const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
          await fetch(
            `${supabaseUrl}/functions/v1/preview-stop`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-guest-mode": "true",
              },
              body: JSON.stringify({ session_id: session.session_id }),
            }
          );
        } else {
          await supabase.functions.invoke("preview-stop", {
            method: "POST",
            body: { session_id: session.session_id },
          });
        }
      } catch (e) {
        console.warn("Failed to stop previous session cleanly", e);
      }
    }
    // Force new session on explicit refresh - user wants a fresh environment
    createSession(undefined, true);
  }, [createSession, session?.session_id, isGuestMode]);

  const handleRepoToggle = React.useCallback(async () => {
    if (!repoOptions) return;

    const newIndex = activeRepoIndex === 0 ? 1 : 0;
    const newRepo = repoOptions[newIndex];
    setActiveRepoIndex(newIndex);

    // Don't stop the current session - it can be reused if user toggles back
    // Session reuse will find an existing session for the new repo if available
    createSession(newRepo, false);
  }, [activeRepoIndex, createSession, repoOptions]);

  // Refresh and reset to target repo (index 0) - used when agent completes
  const handleRefreshToTarget = React.useCallback(async () => {
    if (!repoOptions) return;

    // Always reset to target repo (index 0)
    const targetRepo = repoOptions[0];
    setActiveRepoIndex(0);

    // Stop current session if exists
    if (session?.session_id) {
      try {
        if (isGuestMode) {
          const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
          await fetch(
            `${supabaseUrl}/functions/v1/preview-stop`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-guest-mode": "true",
              },
              body: JSON.stringify({ session_id: session.session_id }),
            }
          );
        } else {
          await supabase.functions.invoke("preview-stop", {
            method: "POST",
            body: { session_id: session.session_id },
          });
        }
      } catch (e) {
        console.warn("Failed to stop previous session cleanly", e);
      }
    }

    // Force new session on target repo
    createSession(targetRepo, true);
  }, [repoOptions, createSession, session?.session_id, isGuestMode]);

  const toolbarState = useMemo<WebContainerToolbarState>(
    () => ({
      activeRepo,
      repoOptions,
      activeRepoIndex,
      isLoading,
      reposReady,
      sessionStatus: session?.status,
      onToggleRepo: handleRepoToggle,
      onRefresh: handleRefresh,
      onRefreshToTarget: handleRefreshToTarget,
    }),
    [
      activeRepo,
      repoOptions,
      handleRepoToggle,
      handleRefresh,
      handleRefreshToTarget,
      isLoading,
      reposReady,
      session?.status,
    ]
  );

  useEffect(() => {
    onToolbarUpdate?.(toolbarState);
    return () => {
      onToolbarUpdate?.(null);
    };
  }, [onToolbarUpdate, toolbarState]);

  // Start session when repos become available
  useEffect(() => {
    // Only start if repos are ready and we haven't started yet
    if (!reposReady || !repoOptions) {
      return;
    }

    // Reset the flag when component remounts (key changes)
    if (!hasStartedSession.current) {
      hasStartedSession.current = true;
      // Delay to allow splice branch creation after first chat message
      const timer = setTimeout(() => {
        createSession(repoOptions[activeRepoIndex]);
      }, 1000);

      return () => {
        clearTimeout(timer);
      };
    }
  }, [reposReady, repoOptions]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  return (
    <div className="w-full h-full flex flex-col bg-[#0F0F11]">
      {/* Content Area */}
      <div className="flex-1 relative overflow-hidden">
        {!reposReady ? (
          // Waiting for repos to load
          <div className="absolute inset-0 flex flex-col items-center justify-center p-8">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center max-w-md w-full"
            >
              <div className="relative mb-8">
                <div className="absolute inset-0 bg-violet-500/20 blur-xl rounded-full" />
                <Loader2 className="w-12 h-12 text-violet-400 animate-spin relative z-10" />
              </div>

              <h3 className="text-lg font-medium text-white mb-1">
                Loading repository info
              </h3>
              <p className="text-white/40 text-sm mb-8 text-center">
                Fetching thread configuration...
              </p>
            </motion.div>
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
              <AlertCircle className="w-8 h-8 text-red-400" />
            </div>
            <h3 className="text-xl font-medium text-white mb-2">
              Provisioning Failed
            </h3>
            <p className="text-white/50 max-w-md mb-6">{error}</p>
            <button
              onClick={() => createSession()}
              className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm font-medium transition-colors border border-white/10"
            >
              Try Again
            </button>
          </div>
        ) : session?.status === "ready" && session.preview_url ? (
          <iframe
            src={session.preview_url}
            className="w-full h-full border-0 bg-white"
            title="Preview"
            sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-8">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center max-w-md w-full"
            >
              <div className="relative mb-8">
                <div className="absolute inset-0 bg-violet-500/20 blur-xl rounded-full" />
                <Loader2 className="w-12 h-12 text-violet-400 animate-spin relative z-10" />
              </div>

              <h3 className="text-lg font-medium text-white mb-1">
                Setting up environment
              </h3>
              <p className="text-white/40 text-sm mb-8 text-center">
                Allocating resources and configuring the container...
              </p>

              <div className="w-full bg-black/40 rounded-lg border border-white/10 p-4 font-mono text-xs space-y-2">
                <StatusLine
                  active={session?.status === "pending"}
                  done={isStatusDone(session?.status, "pending")}
                  label="Initializing session..."
                />
                <StatusLine
                  active={session?.status === "cloning"}
                  done={isStatusDone(session?.status, "cloning")}
                  label="Cloning repository..."
                />
                <StatusLine
                  active={session?.status === "installing"}
                  done={isStatusDone(session?.status, "installing")}
                  label="Installing dependencies..."
                />
                <StatusLine
                  active={session?.status === "starting"}
                  done={isStatusDone(session?.status, "starting")}
                  label="Starting dev server..."
                />
              </div>
            </motion.div>
          </div>
        )}
      </div>
    </div>
  );
};

// Helper for status list
const isStatusDone = (current: string | undefined, step: string) => {
  const order = ["pending", "cloning", "installing", "starting", "ready"];
  const currIdx = order.indexOf(current || "");
  const stepIdx = order.indexOf(step);
  return currIdx > stepIdx;
};

const StatusLine = ({
  active,
  done,
  label,
}: {
  active: boolean;
  done: boolean;
  label: string;
}) => {
  return (
    <div
      className={`flex items-center gap-3 ${
        active ? "text-violet-300" : done ? "text-emerald-400" : "text-white/20"
      }`}
    >
      <div className="w-4 flex justify-center">
        {active && <Loader2 className="w-3 h-3 animate-spin" />}
        {done && <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
        {!active && !done && (
          <div className="w-1.5 h-1.5 rounded-full bg-white/10" />
        )}
      </div>
      <span>{label}</span>
    </div>
  );
};
