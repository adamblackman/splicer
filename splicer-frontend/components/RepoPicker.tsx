import React, { useState, useEffect, useMemo } from "react";
import { Dialog } from "@headlessui/react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Github,
  X,
  Loader2,
  GitFork,
  Star,
  Lock,
  Globe,
  Download,
  RefreshCw,
  ExternalLink,
  LogIn,
  Eye,
} from "lucide-react";
import { Repository, GUEST_TEST_REPOS, guestRepoToRepository } from "../types";
import { cn } from "../lib/utils";
import { supabase } from "../lib/supabaseClient";
import { GITHUB_APP_INSTALL_URL } from "../App";

interface RepoPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (repo: Repository | null) => void;
  selectedRepo: Repository | null;
  excludedRepoId?: number;
  onTokenExpired?: () => void;
  /** Whether the user is authenticated */
  isAuthenticated?: boolean;
  /** Callback when user wants to sign in */
  onSignIn?: () => void;
}

type InstallationStatus = "checking" | "not_installed" | "installed" | "error";

export const RepoPicker: React.FC<RepoPickerProps> = ({
  isOpen,
  onClose,
  onSelect,
  selectedRepo,
  excludedRepoId,
  isAuthenticated = false,
  onSignIn,
}) => {
  const [search, setSearch] = useState("");
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [installationStatus, setInstallationStatus] =
    useState<InstallationStatus>("checking");
  const [error, setError] = useState<string | null>(null);

  // Check if user has GitHub App installed and fetch repos (only for authenticated users)
  useEffect(() => {
    // Skip fetching for guest mode
    if (!isAuthenticated) {
      setInstallationStatus("installed"); // Show guest repos without loading state
      return;
    }

    if (isOpen && !fetched) {
      const fetchRepos = async () => {
        setLoading(true);
        setError(null);
        setInstallationStatus("checking");

        try {
          // Get current session
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (!session) {
            setLoading(false);
            setInstallationStatus("error");
            setError("Not logged in");
            return;
          }

          // Call github-repos edge function
          const response = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/github-repos`,
            {
              headers: {
                Authorization: `Bearer ${session.access_token}`,
                "Content-Type": "application/json",
              },
            }
          );

          const data = await response.json();

          if (response.status === 404 && data.has_installation === false) {
            // User doesn't have GitHub App installed
            setInstallationStatus("not_installed");
            setLoading(false);
            return;
          }

          if (!response.ok) {
            throw new Error(data.error || "Failed to fetch repositories");
          }

          // Success - repos fetched
          setRepos(data.repos);
          setInstallationStatus("installed");
          setFetched(true);
        } catch (err) {
          console.error("Error fetching repos:", err);
          setError(err instanceof Error ? err.message : "Unknown error");
          setInstallationStatus("error");
        } finally {
          setLoading(false);
        }
      };

      fetchRepos();
    }
  }, [isOpen, fetched, isAuthenticated]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSearch("");
      setError(null);
    }
  }, [isOpen]);

  const handleRefresh = () => {
    setFetched(false);
    setLoading(true);
    setError(null);
  };

  // Handle installing GitHub App
  const handleInstallApp = () => {
    // Open GitHub App installation page in new tab
    // Include state parameter to redirect back after installation
    const state = encodeURIComponent(window.location.href);
    window.open(`${GITHUB_APP_INSTALL_URL}?state=${state}`, "_blank");
    onClose();
  };

  const filteredRepos = useMemo(() => {
    return repos.filter((repo) => {
      if (excludedRepoId && repo.id === excludedRepoId) return false;
      if (!search) return true;
      return repo.full_name.toLowerCase().includes(search.toLowerCase());
    });
  }, [repos, search, excludedRepoId]);

  // Separate public and private repos for display
  const { publicRepos, privateRepos } = useMemo(() => {
    return {
      publicRepos: filteredRepos.filter((r) => !r.private),
      privateRepos: filteredRepos.filter((r) => r.private),
    };
  }, [filteredRepos]);

  // Convert guest repos to Repository type and filter by excluded ID
  const guestRepos = useMemo(() => {
    return GUEST_TEST_REPOS.map(guestRepoToRepository).filter(
      (repo) => !excludedRepoId || repo.id !== excludedRepoId
    );
  }, [excludedRepoId]);

  return (
    <AnimatePresence>
      {isOpen && (
        <Dialog
          static
          as={motion.div}
          open={isOpen}
          onClose={onClose}
          className="relative z-50"
        >
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            aria-hidden="true"
            onClick={onClose}
          />

          <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none">
            <motion.div
              layout
              transition={{
                layout: { duration: 0.22, ease: [0.32, 0.72, 0, 1] },
              }}
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="w-full max-w-lg bg-[#0F0F11] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh] pointer-events-auto"
            >
              {/* Header */}
              <div className="p-4 border-b border-white/10 flex items-center justify-between bg-white/5">
                <h2 className="text-lg font-medium text-white flex items-center gap-2">
                  <Github className="w-5 h-5" />
                  Select Repository
                </h2>
                <div className="flex items-center gap-1">
                  {(installationStatus === "installed" ||
                    installationStatus === "error") && (
                    <button
                      onClick={handleRefresh}
                      disabled={loading}
                      className="p-1.5 hover:bg-white/10 rounded-full transition-colors text-white/50 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Refresh repositories"
                    >
                      <RefreshCw
                        className={cn("w-5 h-5", loading && "animate-spin")}
                      />
                    </button>
                  )}
                  <button
                    onClick={onClose}
                    className="p-1 hover:bg-white/10 rounded-full transition-colors text-white/50 hover:text-white"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Search - only show when installed AND authenticated */}
              {installationStatus === "installed" && isAuthenticated && (
                <div className="p-4 border-b border-white/5">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                    <input
                      type="text"
                      placeholder="Search repositories..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="w-full bg-black/20 border border-white/10 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-violet-500/50 transition-colors"
                      autoFocus
                    />
                  </div>
                </div>
              )}

              {/* List */}
              <div className="flex-1 overflow-y-auto min-h-[300px] p-2">
                {/* ============ GUEST MODE UI ============ */}
                {!isAuthenticated ? (
                  <div className="space-y-4 p-2">
                    {/* Sign in prompt */}
                    <div className="bg-gradient-to-r from-violet-500/10 to-fuchsia-500/10 border border-violet-500/20 rounded-xl p-4 mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-violet-500/20 flex items-center justify-center shrink-0">
                          <LogIn className="w-5 h-5 text-violet-400" />
                        </div>
                        <div className="flex-1">
                          <h4 className="text-white font-medium text-sm">
                            Want to use your own repos?
                          </h4>
                          <p className="text-xs text-white/50">
                            Sign in to access all your GitHub repositories
                          </p>
                        </div>
                        <button
                          onClick={() => {
                            onClose();
                            onSignIn?.();
                          }}
                          className="px-4 py-2 bg-violet-500 hover:bg-violet-600 rounded-lg text-white text-sm font-medium transition-colors shrink-0"
                        >
                          Sign In
                        </button>
                      </div>
                    </div>

                    {/* Demo repos header */}
                    <div className="flex items-center gap-2 px-2 py-1 text-xs text-white/40 uppercase tracking-wider">
                      <Globe className="w-3 h-3" />
                      Demo Repositories
                    </div>

                    {/* Demo repos list */}
                    <div className="space-y-2">
                      {guestRepos.map((repo) => {
                        const guestRepo = GUEST_TEST_REPOS.find(
                          (gr) => gr.full_name === repo.full_name
                        );
                        return (
                          <GuestRepoButton
                            key={repo.id}
                            repo={repo}
                            previewUrl={guestRepo?.previewUrl}
                            isSelected={selectedRepo?.full_name === repo.full_name}
                            onSelect={onSelect}
                          />
                        );
                      })}
                    </div>

                    {/* View websites tip */}
                    <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg mt-4">
                      <Eye className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-200/80">
                        <span className="font-medium">Tip:</span> Click "View
                        Website" to preview each demo site before choosing which
                        features to migrate!
                      </p>
                    </div>
                  </div>
                ) : loading || installationStatus === "checking" ? (
                  <div className="flex flex-col items-center justify-center h-full text-white/30 gap-2">
                    <Loader2 className="w-6 h-6 animate-spin" />
                    <span className="text-sm">
                      {installationStatus === "checking"
                        ? "Checking GitHub App..."
                        : "Loading repositories..."}
                    </span>
                  </div>
                ) : installationStatus === "not_installed" ? (
                  <div className="flex flex-col items-center justify-center h-full text-white/30 gap-4 px-6">
                    <div className="w-16 h-16 rounded-full bg-violet-500/10 flex items-center justify-center">
                      <Download className="w-8 h-8 text-violet-400" />
                    </div>
                    <div className="text-center">
                      <h3 className="text-white font-medium mb-2">
                        Install GitHub App
                      </h3>
                      <p className="text-sm text-white/50 mb-1">
                        To access your repositories, you need to install the
                        Splicer GitHub App.
                      </p>
                      <p className="text-xs text-white/30">
                        This gives you permanent access to both public and
                        private repos.
                      </p>
                    </div>
                    <button
                      onClick={handleInstallApp}
                      className="flex items-center gap-2 px-5 py-2.5 bg-violet-500 hover:bg-violet-600 rounded-lg text-white font-medium transition-colors"
                    >
                      <Github className="w-4 h-4" />
                      Install GitHub App
                    </button>
                    <p className="text-xs text-white/20 text-center">
                      After installing, close this dialog and reopen to see your
                      repos.
                    </p>
                  </div>
                ) : error ? (
                  <div className="flex flex-col items-center justify-center h-full text-white/30 gap-3">
                    <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
                      <X className="w-6 h-6 text-red-400" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm text-white/50 mb-1">
                        Failed to load repositories
                      </p>
                      <p className="text-xs text-white/30">{error}</p>
                    </div>
                    <button
                      onClick={() => {
                        setFetched(false);
                        setError(null);
                      }}
                      className="mt-2 flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/70 text-sm transition-colors"
                    >
                      Try Again
                    </button>
                  </div>
                ) : filteredRepos.length > 0 ? (
                  <div className="space-y-4">
                    {/* Private repos section */}
                    {privateRepos.length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 px-2 py-1 text-xs text-white/40 uppercase tracking-wider">
                          <Lock className="w-3 h-3" />
                          Private Repositories ({privateRepos.length})
                        </div>
                        <div className="space-y-1">
                          {privateRepos.map((repo) => (
                            <RepoButton
                              key={repo.id}
                              repo={repo}
                              isSelected={selectedRepo?.id === repo.id}
                              onSelect={onSelect}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Public repos section */}
                    {publicRepos.length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 px-2 py-1 text-xs text-white/40 uppercase tracking-wider">
                          <Globe className="w-3 h-3" />
                          Public Repositories ({publicRepos.length})
                        </div>
                        <div className="space-y-1">
                          {publicRepos.map((repo) => (
                            <RepoButton
                              key={repo.id}
                              repo={repo}
                              isSelected={selectedRepo?.id === repo.id}
                              onSelect={onSelect}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-white/30 gap-2">
                    <GitFork className="w-8 h-8 opacity-50" />
                    <span className="text-sm">
                      {search
                        ? "No repositories match your search"
                        : "No repositories found"}
                    </span>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="p-3 border-t border-white/10 bg-white/5 flex justify-between items-center">
                <div className="text-xs text-white/30">
                  {installationStatus === "installed" && repos.length > 0 && (
                    <span>{repos.length} repositories available</span>
                  )}
                </div>
                {selectedRepo && (
                  <button
                    onClick={() => onSelect(null)}
                    className="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 hover:bg-red-500/10 rounded transition-colors"
                  >
                    Clear Selection
                  </button>
                )}
              </div>
            </motion.div>
          </div>
        </Dialog>
      )}
    </AnimatePresence>
  );
};

// Separate component for repo button to reduce repetition
function RepoButton({
  repo,
  isSelected,
  onSelect,
}: {
  repo: Repository;
  isSelected: boolean;
  onSelect: (repo: Repository) => void;
}) {
  return (
    <button
      onClick={() => onSelect(repo)}
      className={cn(
        "w-full text-left p-3 rounded-lg flex items-center justify-between group transition-all",
        isSelected
          ? "bg-violet-500/20 border border-violet-500/30"
          : "hover:bg-white/5 border border-transparent"
      )}
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          {repo.private && <Lock className="w-3 h-3 text-amber-400/70" />}
          <span
            className={cn(
              "font-medium text-sm",
              isSelected ? "text-violet-200" : "text-white/90"
            )}
          >
            {repo.full_name}
          </span>
        </div>
        {repo.description && (
          <span className="text-xs text-white/40 line-clamp-1 pl-5">
            {repo.description}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 text-white/30 text-xs">
        {repo.stargazers_count > 0 && (
          <span className="flex items-center gap-1">
            <Star className="w-3 h-3" /> {repo.stargazers_count}
          </span>
        )}
        <span className="opacity-0 group-hover:opacity-100 transition-opacity">
          Select
        </span>
      </div>
    </button>
  );
}

// Guest mode repo button with preview link
function GuestRepoButton({
  repo,
  previewUrl,
  isSelected,
  onSelect,
}: {
  repo: Repository;
  previewUrl?: string;
  isSelected: boolean;
  onSelect: (repo: Repository) => void;
}) {
  const handleViewWebsite = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (previewUrl) {
      window.open(previewUrl, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div
      className={cn(
        "w-full p-3 rounded-lg flex items-center justify-between group transition-all",
        isSelected
          ? "bg-violet-500/20 border border-violet-500/30"
          : "bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20"
      )}
    >
      <button
        onClick={() => onSelect(repo)}
        className="flex flex-col gap-1 text-left flex-1 min-w-0"
      >
        <div className="flex items-center gap-2">
          <Globe className="w-3.5 h-3.5 text-emerald-400/70 shrink-0" />
          <span
            className={cn(
              "font-medium text-sm truncate",
              isSelected ? "text-violet-200" : "text-white/90"
            )}
          >
            {repo.full_name}
          </span>
        </div>
        {repo.description && (
          <span className="text-xs text-white/40 line-clamp-1 pl-5">
            {repo.description}
          </span>
        )}
      </button>

      <div className="flex items-center gap-2 shrink-0 ml-3">
        {previewUrl && (
          <button
            onClick={handleViewWebsite}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-lg text-emerald-300 text-xs font-medium transition-colors"
            title="View the live website"
          >
            <ExternalLink className="w-3 h-3" />
            View Website
          </button>
        )}
        <button
          onClick={() => onSelect(repo)}
          className={cn(
            "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
            isSelected
              ? "bg-violet-500 text-white"
              : "bg-white/10 hover:bg-violet-500/20 text-white/70 hover:text-violet-300"
          )}
        >
          {isSelected ? "Selected" : "Select"}
        </button>
      </div>
    </div>
  );
}
