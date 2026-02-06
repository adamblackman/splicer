import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import Galaxy from "../components/Galaxy";
import { AnimatedAIChat } from "../components/AnimatedAIChat";
import { Header } from "../components/Header";
import { RepoPicker } from "../components/RepoPicker";
import { ChatSidebar } from "../components/ChatSidebar";
import { ForkPublicRepoModal } from "../components/ForkPublicRepoModal";
import { Repository, UserProfile, Thread, RateLimitError, UserRateLimitError } from "../types";
import { motion, AnimatePresence } from "framer-motion";
import { GitBranch, ArrowRightLeft, AlertCircle, X, GitFork } from "lucide-react";
import { cn } from "../lib/utils";
import { supabase } from "../lib/supabaseClient";
import { RateLimitModal } from "../components/RateLimitModal";
import { UserRateLimitModal } from "../components/UserRateLimitModal";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

/**
 * Generate a title for a thread based on the user's first message.
 * Fire-and-forget - doesn't block the main flow.
 */
async function generateThreadTitle(
  threadId: string,
  userInput: string,
  accessToken: string
): Promise<void> {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/generate-title`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          thread_id: threadId,
          user_input: userInput,
        }),
      }
    );

    if (!response.ok) {
      console.warn("Failed to generate thread title:", response.status);
    }
  } catch (err) {
    // Silently ignore errors - title generation is non-critical
    console.debug("Title generation failed:", err);
  }
}

interface LandingPageProps {
  user: UserProfile | null;
  session: any;
  onSignIn: () => void;
  onSignOut: () => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({
  user,
  session,
  onSignIn,
  onSignOut,
}) => {
  const navigate = useNavigate();
  const [sourceRepo, setSourceRepo] = useState<Repository | null>(null);
  const [targetRepo, setTargetRepo] = useState<Repository | null>(null);
  const [isRepoPickerOpen, setIsRepoPickerOpen] = useState(false);
  const [activePickerType, setActivePickerType] = useState<
    "source" | "target" | null
  >(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  
  // Guest rate limit state
  const [showRateLimitModal, setShowRateLimitModal] = useState(false);
  const [rateLimitInfo, setRateLimitInfo] = useState<RateLimitError | null>(null);
  const [isCheckingRateLimit, setIsCheckingRateLimit] = useState(false);
  
  // User rate limit state (for authenticated users)
  const [showUserRateLimitModal, setShowUserRateLimitModal] = useState(false);
  const [userRateLimitInfo, setUserRateLimitInfo] = useState<UserRateLimitError | null>(null);

  // Fork public repo modal state
  const [showForkModal, setShowForkModal] = useState(false);

  // Auto-hide toast after 3 seconds
  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => setToastMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  // Handle thread selection from sidebar
  const handleThreadSelect = (thread: Thread) => {
    // Navigate to main page with the selected thread
    navigate(`/app?thread=${thread.id}`);
  };

  const openRepoPicker = (type: "source" | "target") => {
    // Allow opening repo picker even when not signed in (guest mode)
    setActivePickerType(type);
    setIsRepoPickerOpen(true);
  };

  const handleRepoSelect = (repo: Repository | null) => {
    if (activePickerType === "source") {
      setSourceRepo(repo);
    } else {
      setTargetRepo(repo);
    }
    setIsRepoPickerOpen(false);
  };

  const handleSwitchRepos = () => {
    if (sourceRepo && targetRepo) {
      const temp = sourceRepo;
      setSourceRepo(targetRepo);
      setTargetRepo(temp);
    } else if (sourceRepo) {
      setTargetRepo(sourceRepo);
      setSourceRepo(null);
    } else if (targetRepo) {
      setSourceRepo(targetRepo);
      setTargetRepo(null);
    }
  };

  /**
   * Check if a guest is rate limited before allowing migration.
   * Makes a preflight check to the backend without consuming the rate limit quota.
   */
  const checkGuestRateLimit = async (): Promise<{ allowed: boolean; error?: RateLimitError }> => {
    try {
      // Use the dedicated check-rate-limit endpoint (GET, check-only, no increment)
      const response = await fetch(
        `${SUPABASE_URL}/functions/v1/agent/check-rate-limit`,
        {
          method: "GET",
          headers: {
            "x-guest-mode": "true",
          },
        }
      );

      // Handle rate limit exceeded (429)
      if (response.status === 429) {
        const errorData = await response.json();
        return {
          allowed: false,
          error: {
            error: errorData.error || 'rate_limit_exceeded',
            message: errorData.message || 'You have reached the guest usage limit.',
            next_allowed_at: errorData.next_allowed_at,
            time_remaining_seconds: errorData.time_remaining_seconds,
          },
        };
      }

      // Handle other errors (endpoint not found, server error, etc.)
      if (!response.ok) {
        console.error("Rate limit check failed with status:", response.status);
        // Don't allow through if the check endpoint itself fails
        // This prevents bypassing rate limits when endpoint is unavailable
        return {
          allowed: false,
          error: {
            error: 'check_failed',
            message: 'Unable to verify guest access. Please try again or sign in.',
            next_allowed_at: null,
            time_remaining_seconds: null,
          },
        };
      }

      // Parse successful response
      const data = await response.json();
      
      // Double-check the response says allowed
      if (data.allowed === false) {
        return {
          allowed: false,
          error: {
            error: data.error || 'rate_limit_exceeded',
            message: data.message || 'You have reached the guest usage limit.',
            next_allowed_at: data.next_allowed_at,
            time_remaining_seconds: data.time_remaining_seconds,
          },
        };
      }

      return { allowed: true };
    } catch (err) {
      console.error("Failed to check rate limit:", err);
      // On network error, show error instead of allowing through
      return {
        allowed: false,
        error: {
          error: 'network_error',
          message: 'Unable to verify guest access. Please check your connection or sign in.',
          next_allowed_at: null,
          time_remaining_seconds: null,
        },
      };
    }
  };

  /**
   * Check if an authenticated user is rate limited before allowing migration.
   * Makes a preflight check to the backend without consuming the rate limit quota.
   */
  const checkUserRateLimit = async (): Promise<{ allowed: boolean; error?: UserRateLimitError }> => {
    if (!session) {
      return { allowed: false, error: { error: 'not_authenticated', message: 'Not authenticated', next_allowed_at: null, time_remaining_seconds: null } };
    }
    
    try {
      const response = await fetch(
        `${SUPABASE_URL}/functions/v1/agent/check-rate-limit`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${session.access_token}`,
          },
        }
      );

      // Handle rate limit exceeded (429)
      if (response.status === 429) {
        const errorData = await response.json();
        return {
          allowed: false,
          error: {
            error: errorData.error || 'rate_limit_exceeded',
            message: errorData.message || 'You have reached your migration limit.',
            next_allowed_at: errorData.next_allowed_at,
            time_remaining_seconds: errorData.time_remaining_seconds,
            usage_count: errorData.usage_count,
            max_calls: errorData.max_calls,
          },
        };
      }

      // Handle other errors
      if (!response.ok) {
        console.error("User rate limit check failed with status:", response.status);
        return {
          allowed: false,
          error: {
            error: 'check_failed',
            message: 'Unable to verify access. Please try again.',
            next_allowed_at: null,
            time_remaining_seconds: null,
          },
        };
      }

      // Parse successful response
      const data = await response.json();
      
      if (data.allowed === false) {
        return {
          allowed: false,
          error: {
            error: data.error || 'rate_limit_exceeded',
            message: data.message || 'You have reached your migration limit.',
            next_allowed_at: data.next_allowed_at,
            time_remaining_seconds: data.time_remaining_seconds,
            usage_count: data.usage_count,
            max_calls: data.max_calls,
          },
        };
      }

      return { allowed: true };
    } catch (err) {
      console.error("Failed to check user rate limit:", err);
      return {
        allowed: false,
        error: {
          error: 'network_error',
          message: 'Unable to verify access. Please check your connection.',
          next_allowed_at: null,
          time_remaining_seconds: null,
        },
      };
    }
  };

  // Handle thread creation and navigation from landing page
  const handleChatSubmit = async (message: string) => {
    // Validate repos are selected
    if (!sourceRepo && !targetRepo) {
      setToastMessage("Please select both source and target repositories");
      throw new Error("Repos not selected"); // Throw to prevent navigation
    }
    if (!sourceRepo) {
      setToastMessage("Please select a source repository");
      throw new Error("Source repo not selected");
    }
    if (!targetRepo) {
      setToastMessage("Please select a target repository");
      throw new Error("Target repo not selected");
    }

    // Guest mode: check rate limit first, then navigate
    const isGuestMode = !session;
    
    if (isGuestMode) {
      setIsCheckingRateLimit(true);
      try {
        const rateLimitCheck = await checkGuestRateLimit();
        
        if (!rateLimitCheck.allowed && rateLimitCheck.error) {
          // Show rate limit modal instead of navigating
          setRateLimitInfo(rateLimitCheck.error);
          setShowRateLimitModal(true);
          setIsCheckingRateLimit(false);
          throw new Error("Rate limit exceeded"); // Prevent navigation
        }
        
        // Rate limit check passed - navigate to main page
        navigate(`/app`, {
          state: {
            initialMessage: message,
            sourceRepo,
            targetRepo,
            isGuestMode: true,
            rateLimitAlreadyChecked: true, // Skip duplicate check in MainPage
          },
        });
      } finally {
        setIsCheckingRateLimit(false);
      }
      return;
    }

    // Authenticated mode: check rate limit first, then create thread
    setIsCheckingRateLimit(true);
    try {
      const userRateLimitCheck = await checkUserRateLimit();
      
      if (!userRateLimitCheck.allowed && userRateLimitCheck.error) {
        // Show user rate limit modal instead of navigating
        setUserRateLimitInfo(userRateLimitCheck.error);
        setShowUserRateLimitModal(true);
        setIsCheckingRateLimit(false);
        throw new Error("User rate limit exceeded"); // Prevent navigation
      }
      
      // Rate limit check passed - create thread locally
      const { data: thread, error } = await supabase
        .from("threads")
        .insert({
          user_id: session.user.id,
          source_repo: sourceRepo.full_name,
          target_repo: targetRepo.full_name,
        })
        .select()
        .single();

      if (error) throw error;

      const newThreadId = thread.id;

      // Store thread ID
      localStorage.setItem("splicer_thread_id", newThreadId);

      // Generate title for the new thread (fire-and-forget)
      generateThreadTitle(newThreadId, message, session.access_token);

      // Navigate to main view with the thread, initial message, and selected repos
      navigate(`/app?thread=${newThreadId}`, {
        state: {
          initialMessage: message,
          sourceRepo,
          targetRepo,
          isGuestMode: false,
          rateLimitAlreadyChecked: true, // Skip duplicate check in MainPage
        },
      });
    } finally {
      setIsCheckingRateLimit(false);
    }
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-black text-white font-sans selection:bg-violet-500/30">
      {/* Chat Sidebar */}
      <ChatSidebar
        isAuthenticated={!!session}
        onThreadSelect={handleThreadSelect}
      />

      {/* Background Layer */}
      <div className="absolute inset-0 z-0 opacity-80">
        <Galaxy
          mouseRepulsion={false}
          mouseInteraction
          density={1.5}
          glowIntensity={0.3}
          saturation={1}
          hueShift={150}
          twinkleIntensity={0.3}
          rotationSpeed={0.1}
          repulsionStrength={0}
          autoCenterRepulsion={0}
          starSpeed={0.5}
          speed={1}
        />
      </div>

      {/* Content Layer */}
      <div className="relative z-10 flex flex-col h-full">
        <Header user={user} onSignIn={onSignIn} onSignOut={onSignOut} />

        <main className="flex-1 flex flex-col items-center justify-center p-6 mt-16">
          <div className="w-full max-w-4xl flex flex-col items-center gap-12">
            {/* Chat Interface */}
            <div className="w-full">
              <AnimatedAIChat
                isAuthenticated={!!session}
                onSubmit={handleChatSubmit}
                onSignIn={onSignIn}
                canSubmit={!!sourceRepo && !!targetRepo}
                allowGuestMode={true}
              />
            </div>

            {/* Repo Connection Buttons */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-8 w-full">
              <RepoButton
                type="source"
                repo={sourceRepo}
                onClick={() => openRepoPicker("source")}
                onClear={sourceRepo ? () => setSourceRepo(null) : undefined}
              />

              <button
                type="button"
                onClick={
                  sourceRepo || targetRepo ? handleSwitchRepos : undefined
                }
                disabled={!sourceRepo && !targetRepo}
                className={cn(
                  "flex items-center justify-center w-10 h-10 sm:w-12 sm:h-12 rounded-full transition-colors shrink-0",
                  "outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50",
                  sourceRepo || targetRepo
                    ? "cursor-pointer text-white/50 hover:text-violet-400 hover:bg-violet-500/20"
                    : "text-white/20 cursor-not-allowed"
                )}
                title={
                  sourceRepo && targetRepo
                    ? "Swap source and target"
                    : sourceRepo || targetRepo
                    ? "Move to other slot"
                    : "Select a repository first"
                }
              >
                <ArrowRightLeft className="w-5 h-5" />
              </button>

              <RepoButton
                type="target"
                repo={targetRepo}
                onClick={() => openRepoPicker("target")}
                onClear={targetRepo ? () => setTargetRepo(null) : undefined}
              />
            </div>

            {/* Fork Public Repo Button - Only visible to authenticated users */}
            {session && (
              <motion.button
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                onClick={() => setShowForkModal(true)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-all duration-200",
                  "bg-black/40 border-white/10 hover:border-white/20 hover:bg-white/5",
                  "text-white/40 hover:text-white/60 text-sm font-medium",
                  "outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50"
                )}
              >
                <GitFork className="w-4 h-4" />
                Fork public repo
              </motion.button>
            )}
          </div>
        </main>
      </div>

      {/* Modals */}
      <RepoPicker
        isOpen={isRepoPickerOpen}
        onClose={() => setIsRepoPickerOpen(false)}
        onSelect={handleRepoSelect}
        selectedRepo={activePickerType === "source" ? sourceRepo : targetRepo}
        excludedRepoId={
          activePickerType === "source" ? targetRepo?.id : sourceRepo?.id
        }
        onTokenExpired={onSignIn}
        isAuthenticated={!!session}
        onSignIn={onSignIn}
      />

      {/* Toast */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-200 text-sm font-medium shadow-lg backdrop-blur-sm flex items-center gap-2"
          >
            <AlertCircle className="w-4 h-4 text-amber-400" />
            {toastMessage}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Rate Limit Modal for Guests */}
      <RateLimitModal
        isOpen={showRateLimitModal}
        onClose={() => setShowRateLimitModal(false)}
        onSignIn={onSignIn}
        rateLimitInfo={rateLimitInfo}
      />

      {/* Rate Limit Modal for Authenticated Users */}
      <UserRateLimitModal
        isOpen={showUserRateLimitModal}
        onClose={() => setShowUserRateLimitModal(false)}
        rateLimitInfo={userRateLimitInfo}
      />

      {/* Fork Public Repo Modal */}
      <ForkPublicRepoModal
        isOpen={showForkModal}
        onClose={() => setShowForkModal(false)}
        onSuccess={(forkedRepoName) => {
          console.log("Successfully forked:", forkedRepoName);
          // Could optionally refresh repo list or show toast here
        }}
      />
    </div>
  );
};

interface RepoButtonProps {
  type: "source" | "target";
  repo: Repository | null;
  onClick: () => void;
  onClear?: () => void;
}

function RepoButton({ type, repo, onClick, onClear }: RepoButtonProps) {
  const isSource = type === "source";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex items-center gap-4 px-5 py-4 rounded-xl border transition-all duration-300 min-w-[200px] max-w-[280px] sm:min-w-[220px] sm:max-w-[300px]",
        "backdrop-blur-md outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50",
        repo
          ? "bg-white/10 border-white/20 hover:bg-white/15"
          : "bg-black/40 border-white/10 hover:border-white/20 hover:bg-white/5"
      )}
    >
      {/* Clear X - only when repo is selected, visible on hover */}
      {repo && onClear && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClear();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onClear();
            }
          }}
          className="absolute top-2 right-2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-white/10 text-white/50 hover:text-white transition-opacity focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
          title="Clear selection"
          aria-label="Clear selection"
        >
          <X className="w-4 h-4" />
        </span>
      )}

      <div
        className={cn(
          "flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center transition-colors",
          repo
            ? "bg-violet-500/20 text-violet-300"
            : "bg-white/5 text-white/30 group-hover:text-white/50"
        )}
      >
        <GitBranch className="w-5 h-5" />
      </div>

      <div className="flex flex-col items-start text-left overflow-hidden">
        <span className="text-xs uppercase tracking-wider text-white/40 font-medium mb-0.5">
          {isSource ? "Source Repository" : "Target Repository"}
        </span>
        <span
          className={cn(
            "text-sm font-medium truncate w-full",
            repo ? "text-white" : "text-white/30 group-hover:text-white/60"
          )}
        >
          {repo ? repo.name : `Connect ${isSource ? "Source" : "Target"}`}
        </span>
      </div>

      {/* Connector line decoration (visual only) */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 h-[1px] bg-gradient-to-r from-transparent via-violet-500/50 to-transparent opacity-0 transition-opacity",
          repo && "opacity-100"
        )}
      />
    </button>
  );
}
