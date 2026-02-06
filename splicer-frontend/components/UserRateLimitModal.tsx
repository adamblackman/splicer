import React, { useState } from "react";
import { Dialog } from "@headlessui/react";
import { motion, AnimatePresence } from "framer-motion";
import { Clock, Mail, X, Copy, Check } from "lucide-react";

interface UserRateLimitInfo {
  error: string;
  message: string;
  next_allowed_at: string | null;
  time_remaining_seconds: number | null;
}

interface UserRateLimitModalProps {
  isOpen: boolean;
  onClose: () => void;
  rateLimitInfo?: UserRateLimitInfo | null;
}

const CONTACT_EMAIL = "adam@notifai.info";

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

export const UserRateLimitModal: React.FC<UserRateLimitModalProps> = ({
  isOpen,
  onClose,
  rateLimitInfo,
}) => {
  const [copied, setCopied] = useState(false);
  
  const timeRemaining = rateLimitInfo?.time_remaining_seconds
    ? formatTimeRemaining(rateLimitInfo.time_remaining_seconds)
    : null;

  const handleCopyEmail = async () => {
    try {
      await navigator.clipboard.writeText(CONTACT_EMAIL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy email:", err);
    }
  };

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
                  Migration Limit Reached
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
                    You've used your free migration
                  </h3>
                  <p className="text-sm text-white/50">
                    {timeRemaining ? (
                      <>
                        Free accounts get one migration every 2 weeks. Your next
                        free migration will be available in{" "}
                        <span className="text-amber-400 font-medium">
                          {timeRemaining}
                        </span>
                        .
                      </>
                    ) : (
                      "Free accounts get one migration every 2 weeks."
                    )}
                  </p>
                </div>

                {/* Contact for more access */}
                <div className="bg-gradient-to-r from-violet-500/10 to-fuchsia-500/10 border border-violet-500/20 rounded-xl p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-violet-500/20 flex items-center justify-center shrink-0">
                      <Mail className="w-5 h-5 text-violet-400" />
                    </div>
                    <div className="flex-1">
                      <h4 className="text-white font-medium text-sm mb-1">
                        Need more migrations?
                      </h4>
                      <p className="text-xs text-white/50 mb-3">
                        Contact us to unlock unlimited migrations and access to
                        all your repositories.
                      </p>
                      
                      {/* Email with copy button */}
                      <div className="flex items-center gap-2">
                        <a
                          href={`mailto:${CONTACT_EMAIL}?subject=Splicer%20Migration%20Access%20Request`}
                          className="text-sm text-violet-400 hover:text-violet-300 transition-colors font-medium"
                        >
                          {CONTACT_EMAIL}
                        </a>
                        <button
                          onClick={handleCopyEmail}
                          className="p-1.5 hover:bg-white/10 rounded-md transition-colors text-white/50 hover:text-white"
                          title="Copy email"
                        >
                          {copied ? (
                            <Check className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-3">
                  <a
                    href={`mailto:${CONTACT_EMAIL}?subject=Splicer%20Migration%20Access%20Request`}
                    className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-violet-500 hover:bg-violet-600 rounded-xl text-white font-medium transition-colors"
                  >
                    <Mail className="w-4 h-4" />
                    Request More Access
                  </a>
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
