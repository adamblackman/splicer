import React, { useEffect, useRef, useCallback, useState } from "react";
import { cn } from "../lib/utils";
import { LoaderIcon, SendIcon, LogIn, Info } from "lucide-react";
import { motion } from "framer-motion";
import { supabase } from "../lib/supabaseClient";
import { SplicerInfoModal } from "./SplicerInfoModal";

interface UseAutoResizeTextareaProps {
  minHeight: number;
  maxHeight?: number;
}

function useAutoResizeTextarea({
  minHeight,
  maxHeight,
}: UseAutoResizeTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(
    (reset?: boolean) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      if (reset) {
        textarea.style.height = `${minHeight}px`;
        return;
      }

      // Reset to 0 to get accurate scrollHeight when content shrinks (retraction)
      textarea.style.height = "0px";
      const newHeight = Math.max(
        minHeight,
        Math.min(textarea.scrollHeight, maxHeight ?? Number.POSITIVE_INFINITY)
      );
      textarea.style.height = `${newHeight}px`;
    },
    [minHeight, maxHeight]
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = `${minHeight}px`;
    }
  }, [minHeight]);

  useEffect(() => {
    const handleResize = () => adjustHeight();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [adjustHeight]);

  return { textareaRef, adjustHeight };
}

interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  containerClassName?: string;
  showRing?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, containerClassName, showRing = true, ...props }, ref) => {
    return (
      <div className={cn("relative w-full", containerClassName)}>
        <textarea
          className={cn(
            "flex min-h-[96px] w-full rounded-2xl border border-white/10 bg-white/5 px-6 py-4 text-base",
            "transition-[color,background-color,box-shadow,border-color] duration-200 ease-in-out",
            "placeholder:text-white/30",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 focus-visible:bg-white/10",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "resize-none overflow-hidden",
            className
          )}
          ref={ref}
          {...props}
        />
      </div>
    );
  }
);
Textarea.displayName = "Textarea";

interface AnimatedAIChatProps {
  isAuthenticated: boolean;
  onSubmit: (message: string) => Promise<void>;
  onSignIn: () => void;
  canSubmit?: boolean; // Whether repos are selected
  /** Allow guest mode - shows send button instead of sign-in when not authenticated */
  allowGuestMode?: boolean;
}

export function AnimatedAIChat({
  isAuthenticated,
  onSubmit,
  onSignIn,
  canSubmit = true,
  allowGuestMode = false,
}: AnimatedAIChatProps) {
  // In guest mode, treat as "authenticated" for UI purposes (show send button)
  const showSendButton = isAuthenticated || allowGuestMode;
  const [value, setValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const { textareaRef, adjustHeight } = useAutoResizeTextarea({
    minHeight: 96, // 2 lines of text-lg (28px line-height × 2 + padding)
    maxHeight: 280,
  });

  // Run after React commits new value to DOM so scrollHeight reflects actual content
  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) {
        handleSendMessage();
      }
    }
  };

  const handleSendMessage = async () => {
    if (!value.trim() || isSubmitting) return;

    // Only require sign-in if not in guest mode
    if (!isAuthenticated && !allowGuestMode) {
      onSignIn();
      return;
    }

    // Block if repos not selected
    if (!canSubmit) {
      return;
    }

    const message = value.trim();
    setIsSubmitting(true);
    setValue("");
    adjustHeight(true);

    try {
      await onSubmit(message);
    } catch (error) {
      console.error("Failed to submit:", error);
      setValue(message); // Restore on error
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto relative z-10">
      <motion.div
        className="space-y-8"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
      >
        <div className="text-center space-y-4">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.5 }}
            className="text-center"
          >
            <div className="inline-flex items-center gap-3">
              <h1 className="text-2xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-white drop-shadow-lg whitespace-normal sm:whitespace-nowrap max-w-[min(100%,22ch)] sm:max-w-none">
                What would you like to migrate?
              </h1>
              <button
                type="button"
                onClick={() => setShowInfoModal(true)}
                className="p-2 rounded-full text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent shrink-0"
                aria-label="How Splicer works and limitations"
              >
                <Info className="w-6 h-6 md:w-7 md:h-7" />
              </button>
            </div>
          </motion.div>
          <motion.p
            className="text-lg text-white/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
          >
            Describe your migration goal and I'll help you splice it together.
          </motion.p>
        </div>

        <motion.div
          className="relative group"
          initial={{ scale: 0.98, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.5 }}
        >
          <div className="relative backdrop-blur-xl rounded-3xl shadow-2xl shadow-violet-500/10 transition-all duration-300 group-hover:shadow-violet-500/20">
            <Textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                !showSendButton
                  ? "Sign in to start..."
                  : !canSubmit
                  ? "Select repositories below to start..."
                  : "Describe your migration..."
              }
              disabled={isSubmitting}
              className="pr-14 text-lg rounded-3xl"
            />

            <div className="absolute right-3 bottom-3">
              {!showSendButton ? (
                <motion.button
                  type="button"
                  onClick={onSignIn}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className="p-3 rounded-xl bg-violet-600 text-white shadow-lg shadow-violet-600/30 hover:bg-violet-500 transition-all duration-200"
                >
                  <LogIn className="w-5 h-5" />
                </motion.button>
              ) : (
                <motion.button
                  type="button"
                  onClick={handleSendMessage}
                  whileHover={value.trim() && canSubmit ? { scale: 1.05 } : {}}
                  whileTap={value.trim() && canSubmit ? { scale: 0.95 } : {}}
                  disabled={isSubmitting || !value.trim() || !canSubmit}
                  className={cn(
                    "p-3 rounded-xl transition-all duration-200",
                    value.trim() && canSubmit
                      ? "bg-violet-600 text-white shadow-lg shadow-violet-600/30 hover:bg-violet-500"
                      : "bg-white/5 text-white/20 cursor-not-allowed"
                  )}
                >
                  {isSubmitting ? (
                    <LoaderIcon className="w-5 h-5 animate-spin" />
                  ) : (
                    <SendIcon className="w-5 h-5" />
                  )}
                </motion.button>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>

      <SplicerInfoModal
        isOpen={showInfoModal}
        onClose={() => setShowInfoModal(false)}
      />
    </div>
  );
}
