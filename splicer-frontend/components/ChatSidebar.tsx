import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus,
  MessageSquare,
  ArrowRight,
  MoreVertical,
  Pencil,
  Trash2,
  X,
  Check,
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { Thread } from "../types";
import { cn } from "../lib/utils";
import { ConfirmModal } from "./ConfirmModal";

interface ChatSidebarProps {
  isAuthenticated: boolean;
  currentThreadId?: string | null;
  onThreadSelect?: (thread: Thread) => void;
}

// Sidebar width wide enough for logo matching header (h-8)
const SIDEBAR_WIDTH = 300;
// Hover trigger zone width
const TRIGGER_ZONE_WIDTH = 40;

export const ChatSidebar: React.FC<ChatSidebarProps> = ({
  isAuthenticated,
  currentThreadId,
  onThreadSelect,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [deleteConfirmThread, setDeleteConfirmThread] = useState<Thread | null>(
    null
  );

  // Fetch threads when sidebar opens
  const fetchThreads = useCallback(async () => {
    if (!isAuthenticated) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("threads")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      setThreads(data || []);
    } catch (err) {
      console.error("Failed to fetch threads:", err);
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated]);

  // Fetch threads when sidebar opens or auth changes
  useEffect(() => {
    if (isOpen && isAuthenticated) {
      fetchThreads();
    }
  }, [isOpen, isAuthenticated, fetchThreads]);

  // Handle mouse enter on trigger zone
  const handleTriggerEnter = useCallback(() => {
    if (isAuthenticated && !isPinned) {
      setIsOpen(true);
    }
  }, [isAuthenticated, isPinned]);

  // Handle mouse leave from sidebar
  const handleSidebarLeave = useCallback(() => {
    if (!isPinned) {
      setIsOpen(false);
    }
  }, [isPinned]);

  // Handle thread click
  const handleThreadClick = (thread: Thread) => {
    setIsOpen(false);
    if (onThreadSelect) {
      onThreadSelect(thread);
    } else {
      // Default navigation if no handler provided
      navigate(`/app?thread=${thread.id}`);
    }
  };

  // Handle new chat click
  const handleNewChat = () => {
    // Clear current thread and go to landing
    localStorage.removeItem("splicer_thread_id");
    navigate("/");
    setIsOpen(false);
  };

  // Extract just the repo name from owner/repo format
  const getRepoName = (fullName: string | null): string => {
    if (!fullName) return "Unknown";
    const parts = fullName.split("/");
    return parts[1] || parts[0];
  };

  // Handle rename thread
  const handleRenameThread = async (threadId: string, newTitle: string) => {
    if (!newTitle.trim()) return;

    try {
      const { error } = await supabase
        .from("threads")
        .update({
          title: newTitle.trim(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", threadId);

      if (error) throw error;

      // Update local state
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId ? { ...t, title: newTitle.trim() } : t
        )
      );
    } catch (err) {
      console.error("Failed to rename thread:", err);
    } finally {
      setEditingThreadId(null);
    }
  };

  // Show delete confirmation modal
  const handleDeleteClick = (thread: Thread) => {
    setActiveMenuId(null);
    setDeleteConfirmThread(thread);
  };

  // Handle confirmed delete thread
  const handleConfirmDelete = async () => {
    if (!deleteConfirmThread) return;

    const threadId = deleteConfirmThread.id;

    try {
      // First delete all messages associated with the thread
      const { error: messagesError } = await supabase
        .from("messages")
        .delete()
        .eq("thread_id", threadId);

      if (messagesError) throw messagesError;

      // Then delete the thread itself
      const { error: threadError } = await supabase
        .from("threads")
        .delete()
        .eq("id", threadId);

      if (threadError) throw threadError;

      // Update local state
      setThreads((prev) => prev.filter((t) => t.id !== threadId));

      // If we deleted the current thread, navigate away
      if (threadId === currentThreadId) {
        localStorage.removeItem("splicer_thread_id");
        navigate("/");
      }
    } catch (err) {
      console.error("Failed to delete thread:", err);
    } finally {
      setDeleteConfirmThread(null);
    }
  };

  // Don't render if not authenticated
  if (!isAuthenticated) return null;

  return (
    <>
      {/* Invisible trigger zone on left edge */}
      <div
        className="fixed left-0 top-0 bottom-0 z-40"
        style={{ width: TRIGGER_ZONE_WIDTH }}
        onMouseEnter={handleTriggerEnter}
      />

      {/* Backdrop when open (mobile-friendly) */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/20 backdrop-blur-[2px] z-40 lg:hidden"
            onClick={() => setIsOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <AnimatePresence>
        {isOpen && (
          <motion.aside
            initial={{ x: -SIDEBAR_WIDTH }}
            animate={{ x: 0 }}
            exit={{ x: -SIDEBAR_WIDTH }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            onMouseLeave={handleSidebarLeave}
            className="fixed left-0 top-0 bottom-0 z-50 flex flex-col bg-[#0a0a0b]/95 backdrop-blur-xl border-r border-white/10"
            style={{ width: SIDEBAR_WIDTH }}
          >
            {/* Header */}
            <div className="h-14 flex items-center justify-between px-4 border-b border-white/10 flex-shrink-0">
              {/* Logo */}
              <div className="flex items-center gap-2">
                <img src="/Logo.png" alt="Splicer" className="h-8 w-auto" />
              </div>

              {/* New Chat Button */}
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleNewChat}
                className="p-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-black shadow-lg shadow-violet-600/20 transition-colors"
                title="New Chat"
              >
                <Plus className="w-4 h-4" />
              </motion.button>
            </div>

            {/* Thread List */}
            <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent py-2">
              {isLoading ? (
                <div className="px-3 space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <div
                      key={i}
                      className="h-16 rounded-lg bg-white/5 animate-pulse"
                    />
                  ))}
                </div>
              ) : threads.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full px-4 text-center">
                  <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/5 flex items-center justify-center mb-3">
                    <MessageSquare className="w-6 h-6 text-white/30" />
                  </div>
                  <p className="text-sm text-white/40">No conversations yet</p>
                  <p className="text-xs text-white/20 mt-1">
                    Start a new chat to begin
                  </p>
                </div>
              ) : (
                <div className="px-2 space-y-1">
                  {threads.map((thread) => (
                    <ThreadItem
                      key={thread.id}
                      thread={thread}
                      isActive={thread.id === currentThreadId}
                      onClick={() => handleThreadClick(thread)}
                      getRepoName={getRepoName}
                      isMenuOpen={activeMenuId === thread.id}
                      isEditing={editingThreadId === thread.id}
                      onMenuToggle={(isOpen) =>
                        setActiveMenuId(isOpen ? thread.id : null)
                      }
                      onStartEdit={() => {
                        setActiveMenuId(null);
                        setEditingThreadId(thread.id);
                      }}
                      onRename={(newTitle) =>
                        handleRenameThread(thread.id, newTitle)
                      }
                      onCancelEdit={() => setEditingThreadId(null)}
                      onDelete={() => handleDeleteClick(thread)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="h-12 border-t border-white/10 flex items-center justify-center px-4 flex-shrink-0">
              <span className="text-[10px] text-white/20 uppercase tracking-wider">
                {threads.length} conversation{threads.length !== 1 ? "s" : ""}
              </span>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={!!deleteConfirmThread}
        onClose={() => setDeleteConfirmThread(null)}
        onConfirm={handleConfirmDelete}
        title="Delete Conversation"
        description={
          <>
            Are you sure you want to delete{" "}
            <span className="text-white/80 font-medium">
              "{deleteConfirmThread?.title || "Untitled"}"
            </span>
            ? This action cannot be undone.
          </>
        }
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        icon={Trash2}
      />
    </>
  );
};

interface ThreadItemProps {
  thread: Thread;
  isActive: boolean;
  onClick: () => void;
  getRepoName: (fullName: string | null) => string;
  isMenuOpen: boolean;
  isEditing: boolean;
  onMenuToggle: (isOpen: boolean) => void;
  onStartEdit: () => void;
  onRename: (newTitle: string) => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}

const ThreadItem: React.FC<ThreadItemProps> = ({
  thread,
  isActive,
  onClick,
  getRepoName,
  isMenuOpen,
  isEditing,
  onMenuToggle,
  onStartEdit,
  onRename,
  onCancelEdit,
  onDelete,
}) => {
  const hasRepos = thread.source_repo || thread.target_repo;
  const [isHovered, setIsHovered] = useState(false);
  const [editValue, setEditValue] = useState(thread.title || "");
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Reset edit value when thread changes
  useEffect(() => {
    setEditValue(thread.title || "");
  }, [thread.title]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onMenuToggle(false);
      }
    };

    if (isMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isMenuOpen, onMenuToggle]);

  const handleSubmitRename = () => {
    if (editValue.trim() && editValue.trim() !== thread.title) {
      onRename(editValue);
    } else {
      onCancelEdit();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSubmitRename();
    } else if (e.key === "Escape") {
      setEditValue(thread.title || "");
      onCancelEdit();
    }
  };

  // If editing, show inline edit mode
  if (isEditing) {
    return (
      <div
        className={cn(
          "w-full px-3 py-2.5 rounded-lg transition-all duration-200",
          "bg-white/5 border border-violet-500/30"
        )}
      >
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-white/10 text-white text-sm px-2 py-1 rounded border border-white/20 focus:border-violet-500/50 focus:outline-none"
          />
          <button
            onClick={handleSubmitRename}
            className="p-1 rounded hover:bg-green-500/20 text-green-400 transition-colors"
            title="Save"
          >
            <Check className="w-4 h-4" />
          </button>
          <button
            onClick={() => {
              setEditValue(thread.title || "");
              onCancelEdit();
            }}
            className="p-1 rounded hover:bg-red-500/20 text-red-400 transition-colors"
            title="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        if (!isMenuOpen) onMenuToggle(false);
      }}
    >
      <motion.button
        whileHover={{ x: 2 }}
        onClick={onClick}
        className={cn(
          "w-full text-left px-3 py-2.5 pr-10 rounded-lg transition-all duration-200 group",
          isActive
            ? "bg-violet-600/20 border border-violet-500/30"
            : "hover:bg-white/5 border border-transparent"
        )}
      >
        {/* Title */}
        <p
          className={cn(
            "text-sm font-medium truncate mb-1.5 pr-6",
            isActive
              ? "text-violet-200"
              : "text-white/80 group-hover:text-white"
          )}
        >
          {thread.title || "Untitled"}
        </p>

        {/* Repo Badge */}
        {hasRepos && (
          <div className="flex items-center gap-1.5">
            <div
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium",
                isActive
                  ? "bg-violet-500/30 text-violet-200 border border-violet-500/30"
                  : "bg-violet-500/10 text-violet-300/70 border border-violet-500/20"
              )}
            >
              <span className="truncate max-w-[70px]">
                {getRepoName(thread.source_repo)}
              </span>
              <ArrowRight className="w-2.5 h-2.5 flex-shrink-0 opacity-60" />
              <span className="truncate max-w-[70px]">
                {getRepoName(thread.target_repo)}
              </span>
            </div>
          </div>
        )}
      </motion.button>

      {/* Three dots menu trigger */}
      <AnimatePresence>
        {(isHovered || isMenuOpen) && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={(e) => {
              e.stopPropagation();
              onMenuToggle(!isMenuOpen);
            }}
            className={cn(
              "absolute right-2 top-2.5 p-1 rounded-md transition-colors",
              isMenuOpen
                ? "bg-white/10 text-white"
                : "hover:bg-white/10 text-white/50 hover:text-white"
            )}
          >
            <MoreVertical className="w-4 h-4" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Timestamp */}
      <p className="absolute right-2 bottom-3 text-[10px] text-white/30 text-right">
        {formatRelativeTime(thread.updated_at)}
      </p>

      {/* Dropdown menu */}
      <AnimatePresence>
        {isMenuOpen && (
          <motion.div
            ref={menuRef}
            initial={{ opacity: 0, scale: 0.95, y: -5 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -5 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-8 z-50 min-w-[140px] py-1 rounded-lg bg-[#1a1a1c] border border-white/10 shadow-xl shadow-black/40"
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                onStartEdit();
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-white/80 hover:text-white hover:bg-white/5 transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              Rename
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Format relative time (e.g., "2 hours ago", "Yesterday")
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
