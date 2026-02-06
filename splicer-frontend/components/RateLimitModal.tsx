import React from "react";
import { Dialog } from "@headlessui/react";
import { motion, AnimatePresence } from "framer-motion";
import { Clock, LogIn, X, Sparkles } from "lucide-react";
import { RateLimitError } from "../types";

interface RateLimitModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSignIn: () => void;
  rateLimitInfo?: RateLimitError | null;
}

/**
 * Format seconds into a human-readable time remaining string.
 */
function formatTimeRemaining(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days} day${days !== 1 ? "s" : ""} ${hours} hour${hours !== 1 ? "s" : ""}`;
  }
  if (hours > 0) {
    return `${hours} hour${hours !== 1 ? "s" : ""} ${minutes} minute${minutes !== 1 ? "s" : ""}`;
  }
  return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
}

export const RateLimitModal: React.FC<RateLimitModalProps> = ({
  isOpen,
  onClose,
  onSignIn,
  rateLimitInfo,
}) => {
  const timeRemaining = rateLimitInfo?.time_remaining_seconds
    ? formatTimeRemaining(rateLimitInfo.time_remaining_seconds)
    : null;
  
  // Determine if this is a check/network error vs rate limit error
  const isCheckError = rateLimitInfo?.error === 'check_failed' || rateLimitInfo?.error === 'network_error';

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
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="w-full max-w-md bg-[#0F0F11] border border-white/10 rounded-2xl shadow-2xl overflow-hidden pointer-events-auto"
            >
              {/* Header */}
              <div className="p-4 border-b border-white/10 flex items-center justify-between bg-white/5">
                <h2 className="text-lg font-medium text-white flex items-center gap-2">
                  <Clock className="w-5 h-5 text-amber-400" />
                  Guest Limit Reached
                </h2>
                <button
                  onClick={onClose}
                  className="p-1 hover:bg-white/10 rounded-full transition-colors text-white/50 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <div className="p-6 space-y-6">
                {/* Icon and message */}
                <div className="flex flex-col items-center text-center">
                  <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center mb-4">
                    <Clock className="w-8 h-8 text-amber-400" />
                  </div>
                  <h3 className="text-white font-medium mb-2">
                    {isCheckError 
                      ? "Unable to verify guest access"
                      : "You've used your free guest migration"
                    }
                  </h3>
                  <p className="text-sm text-white/50">
                    {isCheckError ? (
                      rateLimitInfo?.message || "Please try again or sign in to continue."
                    ) : timeRemaining ? (
                      <>
                        Guest users get one free migration every 2 weeks. Your next
                        free migration will be available in{" "}
                        <span className="text-amber-400 font-medium">
                          {timeRemaining}
                        </span>
                        .
                      </>
                    ) : (
                      "Guest users get one free migration every 2 weeks. Sign in for unlimited access."
                    )}
                  </p>
                </div>

                {/* Sign in CTA */}
                <div className="bg-gradient-to-r from-violet-500/10 to-fuchsia-500/10 border border-violet-500/20 rounded-xl p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-violet-500/20 flex items-center justify-center shrink-0">
                      <Sparkles className="w-5 h-5 text-violet-400" />
                    </div>
                    <div>
                      <h4 className="text-white font-medium text-sm mb-1">
                        Sign in for unlimited migrations
                      </h4>
                      <p className="text-xs text-white/50">
                        Create a free account to migrate your own repositories
                        with no limits. Connect your GitHub and start migrating
                        in seconds.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-3">
                  <button
                    onClick={() => {
                      onClose();
                      onSignIn();
                    }}
                    className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-violet-500 hover:bg-violet-600 rounded-xl text-white font-medium transition-colors"
                  >
                    <LogIn className="w-4 h-4" />
                    Sign in to continue
                  </button>
                  <button
                    onClick={onClose}
                    className="w-full px-5 py-2.5 text-white/50 hover:text-white hover:bg-white/5 rounded-xl text-sm transition-colors"
                  >
                    Maybe later
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        </Dialog>
      )}
    </AnimatePresence>
  );
};
