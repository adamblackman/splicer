import React, { useEffect, useRef, useCallback, useState } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { Session } from "@supabase/supabase-js";
import { WebContainer } from "../components/WebContainer";
import { ChatSidebar } from "../components/ChatSidebar";
import { Header } from "../components/Header";
import { UserProfile, Repository, Thread, RateLimitError, UserRateLimitError, generateGuestBranchName } from "../types";
import { RateLimitModal } from "../components/RateLimitModal";
import { UserRateLimitModal } from "../components/UserRateLimitModal";
import { useAgentStream } from "../hooks/useAgentStream";
import { supabase } from "../lib/supabaseClient";
import { ChatMessage, MessageSkeleton } from "../components/ChatMessage";
import { motion, AnimatePresence } from "framer-motion";
import {
  SendIcon,
  StopCircle,
  MessageSquare,
  AlertCircle,
  RefreshCw,
  GitBranch,
} from "lucide-react";
import { cn } from "../lib/utils";
import { WebContainerToolbarState } from "../components/WebContainer";

interface MainPageProps {
  user: UserProfile | null;
  session: Session | null;
  onSignIn: () => void;
  onSignOut: () => void;
}

const getStatusColor = (status?: string) => {
  switch (status) {
    case "ready":
      return "text-emerald-400";
    case "failed":
      return "text-red-400";
    case "pending":
    case "cloning":
    case "installing":
    case "starting":
      return "text-amber-400";
    default:
      return "text-white/50";
  }
};

const WebContainerHeaderControls = ({
  toolbar,
}: {
  toolbar: WebContainerToolbarState | null;
}) => {
  const activeRepo = toolbar?.activeRepo ?? null;
  const repoOptions = toolbar?.repoOptions ?? null;
  const activeRepoIndex = toolbar?.activeRepoIndex ?? 0;
  const isLoading = toolbar?.isLoading ?? false;
  const reposReady = toolbar?.reposReady ?? false;
  const sessionStatus = toolbar?.sessionStatus;

  const otherRepo = repoOptions
    ? repoOptions[activeRepoIndex === 0 ? 1 : 0]
    : null;

  return (
    <div className="flex items-center gap-2">
      {activeRepo && repoOptions ? (
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={toolbar?.onToggleRepo}
          disabled={isLoading || !reposReady}
          className="flex items-center gap-2 px-3 py-1.5 bg-violet-500/10 hover:bg-violet-500/20 border border-violet-500/30 hover:border-violet-500/50 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed group shrink-0"
          title={otherRepo ? `Switch to ${otherRepo.repo}` : "Switch repo"}
        >
          <GitBranch className="w-3.5 h-3.5 text-violet-400 shrink-0" />
          <span className="text-xs font-medium text-violet-300 whitespace-nowrap">
            {activeRepo.repo}
          </span>
          <div className="w-px h-3 bg-violet-500/30 mx-1" />
          <svg
            className="w-3 h-3 text-violet-400 group-hover:translate-x-0.5 transition-transform"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
            />
          </svg>
        </motion.button>
      ) : (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg">
          <GitBranch className="w-3.5 h-3.5 text-white/30" />
          <span className="text-xs font-medium text-white/30">
            Loading repos...
          </span>
        </div>
      )}

      {sessionStatus && (
        <div className="flex items-center gap-2 px-2 py-0.5 rounded-full bg-black/20 border border-white/5">
          <div
            className={`w-2 h-2 rounded-full ${
              sessionStatus === "ready"
                ? "bg-emerald-500"
                : "bg-amber-500 animate-pulse"
            }`}
          />
          <span
            className={`text-xs uppercase tracking-wider font-medium ${getStatusColor(
              sessionStatus,
            )}`}
          >
            {sessionStatus}
          </span>
        </div>
      )}

      <button
        onClick={toolbar?.onRefresh}
        disabled={!reposReady}
        className="p-2 hover:bg-white/10 rounded-lg transition-colors text-white/70 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        title="Restart Session"
      >
        <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
      </button>
    </div>
  );
};

export const MainPage: React.FC<MainPageProps> = ({
  user,
  session,
  onSignIn,
  onSignOut,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const handleSignOut = useCallback(async () => {
    await onSignOut();
    navigate("/", { replace: true });
  }, [onSignOut, navigate]);

  // Get thread from URL or localStorage
  const [threadId, setThreadId] = useState<string | null>(() => {
    const urlThread = searchParams.get("thread");
    if (urlThread) return urlThread;
    return localStorage.getItem("splicer_thread_id");
  });

  // When the first message creates a new thread, we get onThreadId(id). If we change
  // the ChatPanel key then, React remounts the panel and the hook state (including
  // the optimistic user message) is lost. Keep the panel key stable until the user
  // explicitly switches thread (e.g. from sidebar).
  const [threadIdFromSubmit, setThreadIdFromSubmit] = useState(false);

  // Get initial message and repos from navigation state
  const [initialMessage, setInitialMessage] = useState<string | null>(
    location.state?.initialMessage || null,
  );
  const [sourceRepo, setSourceRepo] = useState<Repository | null>(
    location.state?.sourceRepo || null,
  );
  const [targetRepo, setTargetRepo] = useState<Repository | null>(
    location.state?.targetRepo || null,
  );
  
  // Guest mode state
  const [isGuestMode] = useState<boolean>(
    location.state?.isGuestMode || false,
  );
  const [guestBranch] = useState<string | null>(
    isGuestMode ? generateGuestBranchName() : null,
  );
  const [rateLimitInfo, setRateLimitInfo] = useState<RateLimitError | null>(null);
  const [showRateLimitModal, setShowRateLimitModal] = useState(false);
  
  // User rate limit state (for authenticated users)
  const [userRateLimitInfo, setUserRateLimitInfo] = useState<UserRateLimitError | null>(null);
  const [showUserRateLimitModal, setShowUserRateLimitModal] = useState(false);

  // Key to force WebContainer remount on thread switch
  const [webContainerKey, setWebContainerKey] = useState(0);
  const [webToolbar, setWebToolbar] = useState<WebContainerToolbarState | null>(
    null,
  );

  // Load thread data (including repos) from DB if not in navigation state
  useEffect(() => {
    const loadThreadRepos = async () => {
      // Skip if we already have repos from navigation state
      if (sourceRepo && targetRepo) return;
      // Skip if no thread to load
      if (!threadId) return;
      // Skip for guest mode - threads aren't persisted locally
      if (isGuestMode) return;

      try {
        const { data: thread, error } = await supabase
          .from("threads")
          .select("source_repo, target_repo")
          .eq("id", threadId)
          .single();

        if (error) {
          console.error("Failed to load thread repos:", error);
          return;
        }

        // Convert owner/repo string to minimal Repository object
        if (thread?.source_repo && !sourceRepo) {
          setSourceRepo({
            id: 0,
            name: thread.source_repo.split("/")[1] || thread.source_repo,
            full_name: thread.source_repo,
            description: null,
            html_url: `https://github.com/${thread.source_repo}`,
            private: false,
            stargazers_count: 0,
            updated_at: "",
          });
        }
        if (thread?.target_repo && !targetRepo) {
          setTargetRepo({
            id: 0,
            name: thread.target_repo.split("/")[1] || thread.target_repo,
            full_name: thread.target_repo,
            description: null,
            html_url: `https://github.com/${thread.target_repo}`,
            private: false,
            stargazers_count: 0,
            updated_at: "",
          });
        }
      } catch (err) {
        console.error("Error loading thread repos:", err);
      }
    };

    loadThreadRepos();
  }, [threadId, sourceRepo, targetRepo, isGuestMode]);

  const handleThreadId = useCallback(
    (id: string) => {
      setThreadId(id);
      setThreadIdFromSubmit(true); // Keep chat panel mounted so first message stays visible
      localStorage.setItem("splicer_thread_id", id);
      setSearchParams({ thread: id });
    },
    [setSearchParams],
  );

  const handleInitialMessageSent = useCallback(() => {
    setInitialMessage(null);
    // Clear the navigation state
    window.history.replaceState({}, document.title);
  }, []);

  // Handle rate limit exceeded for guest users
  const handleRateLimitExceeded = useCallback((info: RateLimitError) => {
    setRateLimitInfo(info);
    setShowRateLimitModal(true);
  }, []);

  // Handle rate limit exceeded for authenticated users
  const handleUserRateLimitExceeded = useCallback((info: UserRateLimitError) => {
    setUserRateLimitInfo(info);
    setShowUserRateLimitModal(true);
  }, []);

  // Handle thread selection from sidebar
  const handleThreadSelect = useCallback(
    async (thread: Thread) => {
      setThreadIdFromSubmit(false); // User explicitly switched thread; allow remount
      // Update URL and state
      setThreadId(thread.id);
      localStorage.setItem("splicer_thread_id", thread.id);
      setSearchParams({ thread: thread.id });

      // Clear navigation state
      setInitialMessage(null);
      window.history.replaceState({}, document.title);

      // Update repos from thread data
      if (thread.source_repo) {
        setSourceRepo({
          id: 0,
          name: thread.source_repo.split("/")[1] || thread.source_repo,
          full_name: thread.source_repo,
          description: null,
          html_url: `https://github.com/${thread.source_repo}`,
          private: false,
          stargazers_count: 0,
          updated_at: "",
        });
      } else {
        setSourceRepo(null);
      }

      if (thread.target_repo) {
        setTargetRepo({
          id: 0,
          name: thread.target_repo.split("/")[1] || thread.target_repo,
          full_name: thread.target_repo,
          description: null,
          html_url: `https://github.com/${thread.target_repo}`,
          private: false,
          stargazers_count: 0,
          updated_at: "",
        });
      } else {
        setTargetRepo(null);
      }

      // Force WebContainer to remount and start fresh
      setWebContainerKey((prev) => prev + 1);
    },
    [setSearchParams],
  );

  // If threadId is in localStorage but not in URL, update URL
  useEffect(() => {
    if (threadId && !searchParams.get("thread")) {
      setSearchParams({ thread: threadId });
    }
  }, [threadId, searchParams, setSearchParams]);

  return (
    <div className="flex flex-col h-screen bg-black text-white">
      <Header
        user={user}
        onSignIn={onSignIn}
        onSignOut={handleSignOut}
        variant="light"
        layout="split"
        rightSlot={<WebContainerHeaderControls toolbar={webToolbar} />}
      />

      <div className="flex flex-1 mt-14 overflow-hidden">
        <ChatSidebar
          isAuthenticated={!!session}
          currentThreadId={threadId}
          onThreadSelect={handleThreadSelect}
        />

        <div className="flex-1 flex overflow-hidden bg-[#09090b]">
          <div className="w-[30%] h-full overflow-hidden shrink-0">
            <ChatPanelWithSubmit
              key={
                threadIdFromSubmit ? "chat-new" : `chat-${threadId || "new"}`
              }
              threadId={threadId}
              onThreadId={handleThreadId}
              initialMessage={initialMessage}
              onInitialMessageSent={handleInitialMessageSent}
              sourceRepo={sourceRepo}
              targetRepo={targetRepo}
              onAgentFinish={webToolbar?.onRefreshToTarget}
              isGuestMode={isGuestMode}
              guestBranch={guestBranch}
              onRateLimitExceeded={handleRateLimitExceeded}
              onUserRateLimitExceeded={handleUserRateLimitExceeded}
            />
          </div>
          <div className="flex-1 h-full overflow-hidden bg-black border-l border-black">
            <WebContainer
              key={webContainerKey}
              sourceRepo={sourceRepo}
              targetRepo={targetRepo}
              onToolbarUpdate={setWebToolbar}
              guestBranch={guestBranch || undefined}
              isGuestMode={isGuestMode}
            />
          </div>
        </div>
      </div>

      {/* Rate Limit Modal for Guest Users */}
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
    </div>
  );
};

interface ChatPanelWithSubmitProps {
  threadId: string | null;
  onThreadId: (id: string) => void;
  initialMessage: string | null;
  onInitialMessageSent: () => void;
  sourceRepo: Repository | null;
  targetRepo: Repository | null;
  onAgentFinish?: () => void;
  isGuestMode?: boolean;
  guestBranch?: string | null;
  onRateLimitExceeded?: (info: RateLimitError) => void;
  onUserRateLimitExceeded?: (info: UserRateLimitError) => void;
}

const ChatPanelWithSubmit: React.FC<ChatPanelWithSubmitProps> = ({
  threadId,
  onThreadId,
  initialMessage,
  onInitialMessageSent,
  sourceRepo,
  targetRepo,
  onAgentFinish,
  isGuestMode = false,
  guestBranch,
  onRateLimitExceeded,
  onUserRateLimitExceeded,
}) => {
  const [inputValue, setInputValue] = React.useState("");
  const [isLoadingHistory, setIsLoadingHistory] = React.useState(true);
  const [toastMessage, setToastMessage] = React.useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const hasSubmittedInitial = useRef(false);
  const hasScrolledToBottom = useRef(false);
  // Track previous loading state to detect completion
  const wasLoadingRef = useRef(false);

  // Auto-hide toast after 3 seconds
  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => setToastMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  const {
    messages,
    isLoading,
    error,
    toolCalls,
    thinking,
    migrationData,
    submit,
    stop,
  } = useAgentStream({
    threadId,
    sourceRepo,
    targetRepo,
    onThreadId,
    onFinish: () => {
      scrollToBottom();
    },
    onError: (err) => {
      console.error("Stream error:", err);
    },
    branch: guestBranch || undefined,
    isGuestMode,
    onRateLimitExceeded,
    onUserRateLimitExceeded,
    // Skip loading thread history when we have an initial message
    // (new thread with no history - prevents race condition)
    skipInitialLoad: !!initialMessage,
  });

  // Watch isLoading to trigger refresh when agent completes
  // This uses the same signal that changes the stop/send button
  useEffect(() => {
    // Detect transition from loading to not loading (completion)
    if (wasLoadingRef.current && !isLoading) {
      console.log(
        "[ChatPanel] Agent finished (isLoading: true → false), refreshing webcontainer",
      );
      onAgentFinish?.();
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading, onAgentFinish]);

  // Handle initial message after mount (only if repos are selected)
  useEffect(() => {
    if (initialMessage && !hasSubmittedInitial.current) {
      // Only auto-submit if both repos were selected
      if (sourceRepo && targetRepo) {
        hasSubmittedInitial.current = true;
        submit(initialMessage).then(() => {
          onInitialMessageSent();
        });
      } else {
        // Clear initial message but show toast
        hasSubmittedInitial.current = true;
        onInitialMessageSent();
        if (!sourceRepo && !targetRepo) {
          setToastMessage("Please select both source and target repositories");
        } else if (!sourceRepo) {
          setToastMessage("Please select a source repository");
        } else {
          setToastMessage("Please select a target repository");
        }
      }
    }
  }, [initialMessage, submit, onInitialMessageSent, sourceRepo, targetRepo]);

  const adjustHeight = React.useCallback((reset?: boolean) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (reset) {
      textarea.style.height = "44px";
      return;
    }

    // Reset to 0 so scrollHeight reflects actual content when shrinking (same as AnimatedAIChat)
    textarea.style.height = "0px";
    const newHeight = Math.max(44, Math.min(textarea.scrollHeight, 200));
    textarea.style.height = `${newHeight}px`;
  }, []);

  // Track if user has scrolled away from bottom
  const isUserScrolledUp = useRef(false);
  const scrollRafRef = useRef<number | null>(null);

  // Check if scrolled to bottom (with small threshold for tolerance)
  const isAtBottom = React.useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    const threshold = 100; // pixels from bottom to consider "at bottom"
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <
      threshold
    );
  }, []);

  // Smooth scroll to bottom using direct scrollTop manipulation
  // This avoids interrupted animations from scrollIntoView during rapid updates
  const scrollToBottom = React.useCallback((immediate = false) => {
    const container = messagesContainerRef.current;
    if (!container) return;

    // Cancel any pending scroll animation
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }

    const targetScroll = container.scrollHeight - container.clientHeight;

    if (immediate) {
      container.scrollTop = targetScroll;
      return;
    }

    // For streaming, use direct scroll (more responsive than smooth animation)
    // This prevents the "jumping" effect when smooth animations get interrupted
    const currentScroll = container.scrollTop;
    const distance = targetScroll - currentScroll;

    // If close to bottom already, just snap to it
    if (Math.abs(distance) < 50) {
      container.scrollTop = targetScroll;
      return;
    }

    // Quick ease-out scroll for larger distances
    const animateScroll = () => {
      const container = messagesContainerRef.current;
      if (!container) return;

      const currentScroll = container.scrollTop;
      const targetScroll = container.scrollHeight - container.clientHeight;
      const distance = targetScroll - currentScroll;

      // Ease-out: move 25% of remaining distance each frame
      // This creates smooth deceleration
      if (Math.abs(distance) > 1) {
        container.scrollTop = currentScroll + distance * 0.25;
        scrollRafRef.current = requestAnimationFrame(animateScroll);
      } else {
        container.scrollTop = targetScroll;
        scrollRafRef.current = null;
      }
    };

    scrollRafRef.current = requestAnimationFrame(animateScroll);
  }, []);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  // Handle scroll events to track user scrolling
  const handleScroll = React.useCallback(() => {
    isUserScrolledUp.current = !isAtBottom();
  }, [isAtBottom]);

  // Scroll to bottom when messages change (for new messages and streaming)
  useEffect(() => {
    if (
      !hasScrolledToBottom.current &&
      messages.length > 0 &&
      !isLoadingHistory
    ) {
      // First load - scroll immediately to bottom
      scrollToBottom(true);
      hasScrolledToBottom.current = true;
      isUserScrolledUp.current = false;
    } else if (hasScrolledToBottom.current && !isUserScrolledUp.current) {
      // Auto-scroll during streaming if user hasn't scrolled up
      scrollToBottom();
    }
  }, [messages, scrollToBottom, isLoadingHistory]);

  // Also scroll during active streaming (content updates)
  useEffect(() => {
    if (isLoading && !isUserScrolledUp.current) {
      scrollToBottom();
    }
  }, [isLoading, messages, migrationData, scrollToBottom]);

  // Reset scroll flags when thread changes
  useEffect(() => {
    hasScrolledToBottom.current = false;
    isUserScrolledUp.current = false;
  }, [threadId]);

  // Re-run adjustHeight when input changes so expand/retract works (same as AnimatedAIChat)
  useEffect(() => {
    adjustHeight();
  }, [inputValue, adjustHeight]);

  useEffect(() => {
    if (messages.length > 0 || !threadId) {
      setIsLoadingHistory(false);
    }
    const timeout = setTimeout(() => setIsLoadingHistory(false), 2000);
    return () => clearTimeout(timeout);
  }, [messages, threadId]);

  const handleSubmit = async () => {
    const trimmedValue = inputValue.trim();
    if (!trimmedValue || isLoading) return;

    // Check if both repos are selected
    if (!sourceRepo && !targetRepo) {
      setToastMessage("Please select both source and target repositories");
      return;
    }
    if (!sourceRepo) {
      setToastMessage("Please select a source repository");
      return;
    }
    if (!targetRepo) {
      setToastMessage("Please select a target repository");
      return;
    }

    setInputValue("");
    adjustHeight(true);

    await submit(trimmedValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleRetry = () => {
    const lastHumanMsg = [...messages]
      .reverse()
      .find((m) => m.role === "human");
    if (lastHumanMsg) {
      submit(lastHumanMsg.content);
    }
  };

  const hasMessages = messages.length > 0;
  const canSend = inputValue.trim() && sourceRepo && targetRepo;

  return (
    <div className="w-full h-full flex flex-col bg-[#0F0F11] relative">
      {/* Messages Area */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
      >
        {isLoadingHistory && threadId ? (
          <div className="p-4 space-y-4">
            <MessageSkeleton />
            <MessageSkeleton />
            <MessageSkeleton />
          </div>
        ) : !hasMessages ? (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center text-white/30 space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/5 flex items-center justify-center">
              <MessageSquare className="w-8 h-8 opacity-50" />
            </div>
            <div className="space-y-2">
              <p className="text-sm">Start a conversation</p>
              <p className="text-xs text-white/20 max-w-[200px]">
                Ask about your repositories or describe what you'd like to
                migrate.
              </p>
            </div>
          </div>
        ) : (
          <div className="py-4">
            {messages.map((message, index) => {
              const isLast = index === messages.length - 1;
              // For the last message, derive isStreaming from isLoading (the reliable signal)
              // This ensures the cursor disappears when the stop button changes to send
              const displayMessage =
                isLast && message.role === "assistant"
                  ? { ...message, isStreaming: isLoading }
                  : message;

              return (
                <ChatMessage
                  key={message.id}
                  message={displayMessage}
                  toolCalls={isLast ? toolCalls : undefined}
                  thinking={isLast ? thinking : null}
                  isLastMessage={isLast}
                  migrationData={
                    isLast && isLoading ? migrationData : undefined
                  }
                  onContentUpdate={
                    // Only pass scroll callback for last message during streaming
                    isLast && isLoading && !isUserScrolledUp.current
                      ? scrollToBottom
                      : undefined
                  }
                />
              );
            })}

            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="mx-4 my-2 p-4 rounded-lg bg-red-500/10 border border-red-500/20 flex items-start gap-3"
                >
                  <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm text-red-300 font-medium">
                      Something went wrong
                    </p>
                    <p className="text-xs text-red-300/70 mt-1">
                      {error.message}
                    </p>
                    <button
                      onClick={handleRetry}
                      className="mt-2 inline-flex items-center gap-1.5 text-xs text-red-300 hover:text-red-200 transition-colors"
                    >
                      <RefreshCw className="w-3 h-3" />
                      Retry
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Toast */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="absolute bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-200 text-sm font-medium shadow-lg backdrop-blur-sm flex items-center gap-2"
          >
            <AlertCircle className="w-4 h-4 text-amber-400" />
            {toastMessage}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input Area - Follow-up prompts disabled */}
      <div className="border-t border-white/10 p-4 bg-[#0a0a0b] flex-shrink-0">
        <div className="relative flex justify-end">
          {/* Text input commented out - no follow-up prompts
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              !sourceRepo || !targetRepo
                ? "Select repositories to start..."
                : "Type a message..."
            }
            disabled={isLoading}
            rows={1}
            className={cn(
              "w-full px-4 py-2.5 pr-12 rounded-xl resize-none overflow-hidden",
              "bg-white/5 border border-white/10 text-sm text-white placeholder:text-white/30",
              "focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-transparent",
              "transition-[color,background-color,box-shadow,border-color] duration-200 ease-in-out",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "scrollbar-thin scrollbar-thumb-white/10",
              "leading-relaxed",
            )}
            style={{ height: "44px", maxHeight: "200px" }}
          />
          */}

          {/* Stop button - only visible when loading */}
          {isLoading && (
            <motion.button
              type="button"
              onClick={stop}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="p-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
            >
              <StopCircle className="w-4 h-4" />
            </motion.button>
          )}
        </div>
      </div>
    </div>
  );
};
