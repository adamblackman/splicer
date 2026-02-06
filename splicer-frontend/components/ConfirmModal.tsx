import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string | React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warning" | "default";
  icon?: LucideIcon;
}

const variantStyles = {
  danger: {
    iconBg: "bg-red-500/10 border-red-500/20",
    iconColor: "text-red-400",
    confirmButton: "bg-red-500 hover:bg-red-600",
  },
  warning: {
    iconBg: "bg-amber-500/10 border-amber-500/20",
    iconColor: "text-amber-400",
    confirmButton: "bg-amber-500 hover:bg-amber-600",
  },
  default: {
    iconBg: "bg-violet-500/10 border-violet-500/20",
    iconColor: "text-violet-400",
    confirmButton: "bg-violet-500 hover:bg-violet-600",
  },
};

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "default",
  icon: Icon,
}) => {
  const styles = variantStyles[variant];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100]"
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed inset-0 flex items-center justify-center z-[100] pointer-events-none p-4"
          >
            <div className="w-full max-w-sm bg-[#0F0F11] border border-white/10 rounded-2xl shadow-2xl p-6 pointer-events-auto">
              {/* Icon */}
              {Icon && (
                <div
                  className={cn(
                    "w-12 h-12 rounded-full border flex items-center justify-center mx-auto mb-4",
                    styles.iconBg
                  )}
                >
                  <Icon className={cn("w-6 h-6", styles.iconColor)} />
                </div>
              )}

              {/* Title */}
              <h3 className="text-lg font-semibold text-white text-center mb-2">
                {title}
              </h3>

              {/* Description */}
              <p className="text-sm text-white/50 text-center mb-6">
                {description}
              </p>

              {/* Buttons */}
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 hover:text-white text-sm font-medium transition-colors"
                >
                  {cancelText}
                </button>
                <button
                  onClick={onConfirm}
                  className={cn(
                    "flex-1 px-4 py-2.5 rounded-xl text-white text-sm font-medium transition-colors",
                    styles.confirmButton
                  )}
                >
                  {confirmText}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
