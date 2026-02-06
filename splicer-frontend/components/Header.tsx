import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Github, LogOut } from "lucide-react";
import { UserProfile } from "../types";
import { supabase } from "../lib/supabaseClient";
import { ConfirmModal } from "./ConfirmModal";

interface HeaderProps {
  user: UserProfile | null;
  onSignIn: () => void;
  onSignOut: () => void;
  variant?: "default" | "light";
  layout?: "default" | "split";
  rightSlot?: React.ReactNode;
}

const PROFILE_MENU_Z = 9999;

export const Header: React.FC<HeaderProps> = ({
  user,
  onSignIn,
  onSignOut,
  variant = "default",
  layout = "default",
  rightSlot,
}) => {
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 });

  // Update dropdown position when opening so it aligns with the avatar
  useEffect(() => {
    if (!showProfileMenu || !avatarRef.current) return;
    const rect = avatarRef.current.getBoundingClientRect();
    setMenuPosition({
      top: rect.bottom + 8,
      right: window.innerWidth - rect.right,
    });
  }, [showProfileMenu]);

  const handleSignOutClick = () => {
    setShowProfileMenu(false);
    setShowSignOutConfirm(true);
  };

  const handleConfirmSignOut = () => {
    setShowSignOutConfirm(false);
    onSignOut();
  };

  const profileMenuPortal =
    typeof document !== "undefined" &&
    createPortal(
      <AnimatePresence>
        {showProfileMenu && user && (
          <React.Fragment key="profile-menu">
            <div
              className="fixed inset-0"
              style={{ zIndex: PROFILE_MENU_Z }}
              onClick={() => setShowProfileMenu(false)}
              aria-hidden="true"
            />
            <motion.div
              key="profile-dropdown"
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              className="fixed w-56 bg-[#161618] border border-white/10 rounded-xl shadow-2xl overflow-hidden py-1"
              style={{
                zIndex: PROFILE_MENU_Z + 1,
                top: menuPosition.top,
                right: menuPosition.right,
              }}
            >
              <div className="px-4 py-3 border-b border-white/5">
                <p className="text-sm font-medium text-white truncate">
                  {user.full_name || "User"}
                </p>
                <p className="text-xs text-white/50 truncate">{user.email}</p>
              </div>
              <button
                onClick={handleSignOutClick}
                className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-white/5 flex items-center gap-2 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            </motion.div>
          </React.Fragment>
        )}
      </AnimatePresence>,
      document.body
    );

  return (
    <>
      <header
        style={{ contain: "layout", transform: "translateZ(0)" }}
        className={`fixed top-0 left-0 right-0 z-50 ${
          layout === "split"
            ? "grid grid-cols-[30%_1fr] items-center py-2.5 pt-3"
            : "flex items-center justify-between px-6 py-4"
        } ${
          variant === "light"
            ? "bg-[#1f1f21] border-b border-white/10"
            : "bg-gradient-to-b from-black/80 to-transparent"
        }`}
      >
        <Link
          to="/"
          className={`flex items-center gap-2 ${
            layout === "split" ? "pl-6" : ""
          }`}
        >
          <img src="/Logo.png" alt="Splicer" className="h-8 w-auto" />
        </Link>

        {layout === "split" ? (
          <div className="flex items-center justify-between gap-4 pr-6">
            {rightSlot}
            {!user ? (
              <button
                type="button"
                onClick={onSignIn}
                className="flex items-center gap-2 px-4 py-2 bg-white text-black rounded-full font-medium text-sm hover:bg-gray-100 hover:scale-[1.02] active:scale-[0.98] transition-transform shadow-lg shadow-white/5"
              >
                <Github className="w-4 h-4" />
                <span>Sign in with GitHub</span>
              </button>
            ) : (
              <div ref={avatarRef} className="relative">
                <button
                  type="button"
                  onClick={() => setShowProfileMenu(!showProfileMenu)}
                  className="relative rounded-full overflow-hidden w-9 h-9 border border-white/20 ring-2 ring-transparent hover:ring-white/20 hover:scale-105 active:scale-95 transition-transform"
                >
                  {user.avatar_url ? (
                    <img
                      src={user.avatar_url}
                      alt="Profile"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full bg-violet-600 flex items-center justify-center text-white text-xs font-bold">
                      {user.email?.substring(0, 2).toUpperCase() || "US"}
                    </div>
                  )}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-4">
            {rightSlot}
            {!user ? (
              <button
                type="button"
                onClick={onSignIn}
                className="flex items-center gap-2 px-4 py-2 bg-white text-black rounded-full font-medium text-sm hover:bg-gray-100 hover:scale-[1.02] active:scale-[0.98] transition-transform shadow-lg shadow-white/5"
              >
                <Github className="w-4 h-4" />
                <span>Sign in with GitHub</span>
              </button>
            ) : (
              <div ref={avatarRef} className="relative">
                <button
                  type="button"
                  onClick={() => setShowProfileMenu(!showProfileMenu)}
                  className="relative rounded-full overflow-hidden w-9 h-9 border border-white/20 ring-2 ring-transparent hover:ring-white/20 hover:scale-105 active:scale-95 transition-transform"
                >
                  {user.avatar_url ? (
                    <img
                      src={user.avatar_url}
                      alt="Profile"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full bg-violet-600 flex items-center justify-center text-white text-xs font-bold">
                      {user.email?.substring(0, 2).toUpperCase() || "US"}
                    </div>
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      {/* Profile menu: portal so click-away works on all pages (e.g. landing page content) */}
      {profileMenuPortal}

      {/* Sign Out Confirmation Modal */}
      <ConfirmModal
        isOpen={showSignOutConfirm}
        onClose={() => setShowSignOutConfirm(false)}
        onConfirm={handleConfirmSignOut}
        title="Sign Out"
        description="Are you sure you want to sign out? You'll need to sign in again to access your conversations."
        confirmText="Sign Out"
        cancelText="Cancel"
        variant="danger"
        icon={LogOut}
      />
    </>
  );
};
