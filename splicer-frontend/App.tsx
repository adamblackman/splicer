import React, { useEffect, useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useSearchParams,
  useNavigate,
} from "react-router-dom";
import { supabase } from "./lib/supabaseClient";
import { Session } from "@supabase/supabase-js";
import { UserProfile } from "./types";
import { LandingPage } from "./pages/LandingPage";
import { MainPage } from "./pages/MainPage";

// GitHub App installation URL
export const GITHUB_APP_INSTALL_URL =
  "https://github.com/apps/splicer-online/installations/new";

// Component to handle GitHub App callback
function GitHubCallbackHandler() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"processing" | "success" | "error">(
    "processing"
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const linkInstallation = async () => {
      const installationId = searchParams.get("installation_id");

      if (!installationId) {
        setError("Missing installation ID");
        setStatus("error");
        return;
      }

      try {
        // Get current session
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session) {
          // Store installation_id and redirect to login
          localStorage.setItem("pending_github_installation", installationId);
          navigate("/", { replace: true });
          return;
        }

        // Check if installation is already linked (the edge function may have handled it)
        const { data: existingInstall } = await supabase
          .from("github_app_installations")
          .select("installation_id")
          .eq("user_id", session.user.id)
          .single();

        if (existingInstall) {
          // Already linked - redirect to landing page
          setStatus("success");
          setTimeout(() => {
            navigate("/?github_app_installed=true", { replace: true });
          }, 500);
          return;
        }

        // Not yet linked - call the edge function to complete linking
        // Use redirect: 'manual' to prevent fetch from following the redirect
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/github-callback?installation_id=${installationId}&setup_action=install`,
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
            redirect: "manual", // Don't follow redirects
          }
        );

        // 302 redirect means success
        if (response.status === 302 || response.type === "opaqueredirect") {
          setStatus("success");
          setTimeout(() => {
            navigate("/?github_app_installed=true", { replace: true });
          }, 500);
          return;
        }

        // Check again if it was linked
        const { data: checkAgain } = await supabase
          .from("github_app_installations")
          .select("installation_id")
          .eq("user_id", session.user.id)
          .single();

        if (checkAgain) {
          setStatus("success");
          setTimeout(() => {
            navigate("/?github_app_installed=true", { replace: true });
          }, 500);
          return;
        }

        throw new Error("Failed to link installation");
      } catch (err) {
        console.error("Failed to link installation:", err);

        // One final check - maybe it worked despite the error
        const {
          data: { session: finalSession },
        } = await supabase.auth.getSession();
        if (finalSession) {
          const { data: finalCheck } = await supabase
            .from("github_app_installations")
            .select("installation_id")
            .eq("user_id", finalSession.user.id)
            .single();

          if (finalCheck) {
            setStatus("success");
            setTimeout(() => {
              navigate("/?github_app_installed=true", { replace: true });
            }, 500);
            return;
          }
        }

        setError(err instanceof Error ? err.message : "Unknown error");
        setStatus("error");
      }
    };

    linkInstallation();
  }, [searchParams, navigate]);

  return (
    <div className="w-screen h-screen bg-black flex items-center justify-center">
      <div className="text-center">
        {status === "processing" && (
          <>
            <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-white/70">Linking GitHub App installation...</p>
          </>
        )}
        {status === "success" && (
          <>
            <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-6 h-6 text-green-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <p className="text-white/70">GitHub App installed successfully!</p>
          </>
        )}
        {status === "error" && (
          <>
            <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-6 h-6 text-red-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>
            <p className="text-red-400 mb-2">Failed to link installation</p>
            <p className="text-white/50 text-sm">{error}</p>
            <button
              onClick={() => navigate("/", { replace: true })}
              className="mt-4 px-4 py-2 bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/30 rounded-lg text-violet-200 text-sm"
            >
              Go to Home
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user) {
        setUserProfile({
          id: session.user.id,
          email: session.user.email,
          avatar_url: session.user.user_metadata.avatar_url,
          full_name: session.user.user_metadata.full_name,
          user_name: session.user.user_metadata.user_name,
        });

        // Check for pending GitHub App installation
        const pendingInstallation = localStorage.getItem(
          "pending_github_installation"
        );
        if (pendingInstallation) {
          localStorage.removeItem("pending_github_installation");
          // Redirect to complete the installation linking
          window.location.href = `/github/callback?installation_id=${pendingInstallation}`;
        }
      }
      setIsLoading(false);
    });

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      if (session?.user) {
        setUserProfile({
          id: session.user.id,
          email: session.user.email,
          avatar_url: session.user.user_metadata.avatar_url,
          full_name: session.user.user_metadata.full_name,
          user_name: session.user.user_metadata.user_name,
        });
      } else {
        setUserProfile(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleSignIn = async () => {
    await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        scopes: "read:user user:email",
        redirectTo: window.location.origin,
      },
    });
  };

  const handleSignOut = async () => {
    localStorage.removeItem("splicer_thread_id");
    await supabase.auth.signOut();
  };

  // Show nothing while loading initial auth state
  if (isLoading) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <LandingPage
              user={userProfile}
              session={session}
              onSignIn={handleSignIn}
              onSignOut={handleSignOut}
            />
          }
        />
        <Route
          path="/app"
          element={
            <MainPage
              user={userProfile}
              session={session}
              onSignIn={handleSignIn}
              onSignOut={handleSignOut}
            />
          }
        />
        {/* GitHub App installation callback */}
        <Route path="/github/callback" element={<GitHubCallbackHandler />} />
        {/* Redirect any unknown routes to landing */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
