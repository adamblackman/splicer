import React, { useState, useCallback } from "react";
import { Dialog } from "@headlessui/react";
import { motion, AnimatePresence } from "framer-motion";
import { GitFork, X, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "../lib/utils";
import { supabase } from "../lib/supabaseClient";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

/**
 * Regex to validate and parse GitHub repository URLs.
 * Supports:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - github.com/owner/repo
 * - owner/repo (shorthand)
 */
const GITHUB_URL_REGEX =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$|^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/;

interface ForkPublicRepoModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (forkedRepoFullName: string) => void;
}

type ForkStatus = "idle" | "checking" | "forking" | "success" | "error";

interface ForkError {
  message: string;
  details?: string;
}

/**
 * Parse a GitHub URL or shorthand into owner/repo format.
 * Returns null if invalid.
 */
function parseGitHubUrl(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const match = trimmed.match(GITHUB_URL_REGEX);
  if (!match) return null;

  // Full URL match (groups 1 & 2) or shorthand match (groups 3 & 4)
  const owner = match[1] || match[3];
  const repo = match[2] || match[4];

  if (!owner || !repo) return null;

  return { owner, repo };
}

export const ForkPublicRepoModal: React.FC<ForkPublicRepoModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [repoUrl, setRepoUrl] = useState("");
  const [status, setStatus] = useState<ForkStatus>("idle");
  const [error, setError] = useState<ForkError | null>(null);
  const [forkedRepoName, setForkedRepoName] = useState<string | null>(null);

  // Reset state when modal closes
  const handleClose = useCallback(() => {
    if (status === "checking" || status === "forking") return; // Don't close while in progress
    setRepoUrl("");
    setStatus("idle");
    setError(null);
    setForkedRepoName(null);
    onClose();
  }, [status, onClose]);

  // Handle fork submission
  const handleFork = async () => {
    // Validate URL
    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) {
      setError({
        message: "Invalid GitHub URL",
        details:
          "Please enter a valid GitHub repository URL (e.g., https://github.com/owner/repo)",
      });
      setStatus("error");
      return;
    }

    setError(null);
    setStatus("checking");

    try {
      // Get current session
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        setError({
          message: "Not authenticated",
          details: "Please sign in to fork repositories.",
        });
        setStatus("error");
        return;
      }

      // Call the fork-public-repo edge function
      const response = await fetch(
        `${SUPABASE_URL}/functions/v1/fork-public-repo`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            owner: parsed.owner,
            repo: parsed.repo,
          }),
        }
      );

      const data = await response.json();

      // Handle rate limit
      if (response.status === 429) {
        setError({
          message: "Fork limit reached",
          details:
            data.message ||
            "You can fork up to 5 public repositories per week. Please try again later.",
        });
        setStatus("error");
        return;
      }

      // Handle license error
      if (response.status === 403) {
        setError({
          message: "License not supported",
          details:
            data.message ||
            "This repository's license does not allow forking through Splicer.",
        });
        setStatus("error");
        return;
      }

      // Handle other errors
      if (!response.ok) {
        setError({
          message: data.error || "Fork failed",
          details: data.details || "An unexpected error occurred.",
        });
        setStatus("error");
        return;
      }

      // Success! Update to forking status briefly, then success
      setStatus("forking");

      // Small delay to show "Forking..." state
      await new Promise((resolve) => setTimeout(resolve, 500));

      setForkedRepoName(data.forked_repo?.full_name || `${parsed.owner}/${parsed.repo}`);
      setStatus("success");

      // Auto-close after showing success
      setTimeout(() => {
        onSuccess?.(data.forked_repo?.full_name);
        handleClose();
      }, 1500);
    } catch (err) {
      console.error("Fork error:", err);
      setError({
        message: "Network error",
        details: "Failed to connect to the server. Please try again.",
      });
      setStatus("error");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && status === "idle") {
      e.preventDefault();
      handleFork();
    }
  };

  const isLoading = status === "checking" || status === "forking";
  const canSubmit = repoUrl.trim() && !isLoading && status !== "success";

  return (
    <AnimatePresence>
      {isOpen && (
        <Dialog
          static
          as={motion.div}
          open={isOpen}
          onClose={handleClose}
          className="relative z-50"
        >
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            aria-hidden="true"
            onClick={handleClose}
          />

          <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="w-full max-w-md bg-[#0F0F11] border border-white/10 rounded-2xl shadow-2xl overflow-hidden pointer-events-auto"
            >
              {/* Header */}
              <div className="p-4 border-b border-white/10 flex items-center justify-between bg-white/5">
                <h2 className="text-lg font-medium text-white flex items-center gap-2">
                  <GitFork className="w-5 h-5 text-violet-400" />
                  Fork Public Repository
                </h2>
                <button
                  onClick={handleClose}
                  disabled={isLoading}
                  className="p-1 hover:bg-white/10 rounded-full transition-colors text-white/50 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <div className="p-6 space-y-4">
                {/* Success State */}
                {status === "success" ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center text-center py-4"
                  >
                    <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center mb-4">
                      <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                    </div>
                    <h3 className="text-white font-medium text-lg mb-1">
                      Successfully forked!
                    </h3>
                    {forkedRepoName && (
                      <p className="text-sm text-white/50">{forkedRepoName}</p>
                    )}
                  </motion.div>
                ) : (
                  <>
                    {/* Description */}
                    <p className="text-sm text-white/50">
                      Enter a public GitHub repository URL to fork it to your
                      account. Only repositories with permissive licenses (MIT,
                      Apache-2.0, BSD, etc.) are supported.
                    </p>

                    {/* Input */}
                    <div className="space-y-2">
                      <label
                        htmlFor="repo-url"
                        className="text-sm font-medium text-white/70"
                      >
                        Repository URL
                      </label>
                      <input
                        id="repo-url"
                        type="text"
                        value={repoUrl}
                        onChange={(e) => {
                          setRepoUrl(e.target.value);
                          if (status === "error") {
                            setStatus("idle");
                            setError(null);
                          }
                        }}
                        onKeyDown={handleKeyDown}
                        placeholder="https://github.com/owner/repo"
                        disabled={isLoading}
                        className={cn(
                          "w-full px-4 py-3 rounded-xl bg-black/30 border text-white placeholder:text-white/30",
                          "focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-transparent",
                          "disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
                          error
                            ? "border-red-500/50"
                            : "border-white/10 hover:border-white/20"
                        )}
                        autoFocus
                      />
                    </div>

                    {/* Error Message */}
                    <AnimatePresence>
                      {error && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-start gap-3">
                            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                            <div>
                              <p className="text-sm text-red-300 font-medium">
                                {error.message}
                              </p>
                              {error.details && (
                                <p className="text-xs text-red-300/70 mt-1">
                                  {error.details}
                                </p>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Loading State */}
                    {isLoading && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="flex items-center justify-center gap-3 py-2"
                      >
                        <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
                        <span className="text-sm text-white/70">
                          {status === "checking"
                            ? "Checking license..."
                            : "Forking..."}
                        </span>
                      </motion.div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-3 pt-2">
                      <button
                        onClick={handleClose}
                        disabled={isLoading}
                        className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 hover:text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleFork}
                        disabled={!canSubmit}
                        className={cn(
                          "flex-1 px-4 py-2.5 rounded-xl text-white text-sm font-medium transition-colors",
                          "flex items-center justify-center gap-2",
                          canSubmit
                            ? "bg-violet-500 hover:bg-violet-600"
                            : "bg-violet-500/50 cursor-not-allowed"
                        )}
                      >
                        {isLoading ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <GitFork className="w-4 h-4" />
                        )}
                        Fork
                      </button>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        </Dialog>
      )}
    </AnimatePresence>
  );
};
