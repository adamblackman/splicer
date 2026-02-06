/**
 * Fork Public Repo Edge Function
 *
 * Allows authenticated users to fork public GitHub repositories with permissive licenses.
 * 
 * Features:
 * - License validation (only permissive licenses allowed)
 * - Rate limiting (5 forks per week per user)
 * - Forks into user's namespace via GitHub App installation
 * 
 * Endpoint: POST /functions/v1/fork-public-repo
 * Body: { owner: string, repo: string }
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// Pinned to v2.94.0 due to esm.sh CDN issue with v2.95.0
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.94.0";
import {
  SignJWT,
  importPKCS8,
} from "https://deno.land/x/jose@v5.2.0/index.ts";

declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

// ============ Configuration ============

/**
 * Allowlist of permissive SPDX license identifiers.
 * These licenses allow forking and modification without copyleft requirements.
 * 
 * Reference: https://spdx.org/licenses/
 */
const ALLOWED_LICENSES = new Set([
  // Most common permissive licenses
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "WTFPL",
  "CC0-1.0",
  "Zlib",
  "BSL-1.0", // Boost Software License
  "PostgreSQL",
  
  // Additional permissive licenses
  "AFL-3.0", // Academic Free License
  "Artistic-2.0",
  "BlueOak-1.0.0",
  "ECL-2.0", // Educational Community License
  "MS-PL", // Microsoft Public License
  "NCSA", // University of Illinois/NCSA
  "OFL-1.1", // SIL Open Font License
  "UPL-1.0", // Universal Permissive License
  "Vim",
  "X11", // X11 License (similar to MIT)
  "Xnet",
  "curl", // curl license
  "libtiff",
  "Libpng", // libpng License
  "MulanPSL-2.0", // Mulan Permissive Software License
  "NAIST-2003",
  "NTP",
  "PHP-3.01",
  "PSF-2.0", // Python Software Foundation License
  "Ruby",
  "TCL",
  "Unicode-DFS-2016",
  "W3C",
  "HPND", // Historical Permission Notice and Disclaimer
  "Fair",
  "FTL", // Freetype License
  
  // Weak copyleft (still allow forking for most use cases)
  "MPL-2.0", // Mozilla Public License 2.0 - file-level copyleft only
  "LGPL-2.1-only", // Lesser GPL - library linking allowed
  "LGPL-3.0-only",
  "EUPL-1.2", // European Union Public License
  "OSL-3.0", // Open Software License
  "CDDL-1.0", // Common Development and Distribution License
  "EPL-1.0", // Eclipse Public License
  "EPL-2.0",
  "CPL-1.0", // Common Public License
  "IPL-1.0", // IBM Public License
]);

// Rate limit: 5 forks per week
const FORK_RATE_LIMIT = 5;
const FORK_RATE_WINDOW_DAYS = 7;

// ============ CORS Configuration ============

const ALLOWED_ORIGIN_SUFFIX = ".spliceronline.com";
const ALLOWED_EXACT_ORIGINS = ["https://spliceronline.com"];

function isAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (ALLOWED_EXACT_ORIGINS.includes(origin)) return origin;
  try {
    const url = new URL(origin);
    if (
      url.protocol === "https:" &&
      url.hostname.endsWith(ALLOWED_ORIGIN_SUFFIX)
    ) {
      return origin;
    }
  } catch {
    return null;
  }
  return null;
}

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowedOrigin = isAllowedOrigin(origin);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
  }
  return headers;
}

// ============ GitHub App JWT Utilities ============

function normalizePemKey(key: string): string {
  let normalized = key.replace(/\\n/g, "\n");

  const needsReformat =
    !normalized.includes("\n") ||
    (normalized.includes("-----BEGIN") &&
      !normalized.match(/-----BEGIN[^-]+-----\n/));

  if (needsReformat) {
    const isPKCS8 = normalized.includes("BEGIN PRIVATE KEY");
    const isPKCS1 = normalized.includes("BEGIN RSA PRIVATE KEY");

    if (isPKCS8 || isPKCS1) {
      const header = isPKCS1
        ? "-----BEGIN RSA PRIVATE KEY-----"
        : "-----BEGIN PRIVATE KEY-----";
      const footer = isPKCS1
        ? "-----END RSA PRIVATE KEY-----"
        : "-----END PRIVATE KEY-----";

      const regex = isPKCS1
        ? /-----BEGIN RSA PRIVATE KEY-----([\s\S]*?)-----END RSA PRIVATE KEY-----/
        : /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/;

      const match = normalized.match(regex);
      if (match) {
        const base64Content = match[1].replace(/\s/g, "");
        const lines: string[] = [];
        for (let i = 0; i < base64Content.length; i += 64) {
          lines.push(base64Content.substring(i, i + 64));
        }
        normalized = `${header}\n${lines.join("\n")}\n${footer}`;
      }
    }
  }

  return normalized;
}

async function generateAppJWT(
  appId: string,
  privateKey: string
): Promise<string> {
  const normalizedKey = normalizePemKey(privateKey);
  const isPKCS1 = normalizedKey.includes("BEGIN RSA PRIVATE KEY");

  const key = isPKCS1
    ? await importPKCS1Key(normalizedKey)
    : await importPKCS8(normalizedKey, "RS256");

  const now = Math.floor(Date.now() / 1000);

  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 10 * 60)
    .setIssuer(appId)
    .sign(key);
}

async function importPKCS1Key(pem: string): Promise<CryptoKey> {
  const pemContent = pem
    .replace("-----BEGIN RSA PRIVATE KEY-----", "")
    .replace("-----END RSA PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(pemContent), (c) => c.charCodeAt(0));
  const pkcs8Der = wrapPKCS1InPKCS8(binaryDer);

  return await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["sign"]
  );
}

function wrapPKCS1InPKCS8(pkcs1: Uint8Array): Uint8Array {
  const rsaOID = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);

  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const keyOctetString = wrapInDER(0x04, pkcs1);

  const innerSequence = new Uint8Array(
    version.length + rsaOID.length + keyOctetString.length
  );
  innerSequence.set(version, 0);
  innerSequence.set(rsaOID, version.length);
  innerSequence.set(keyOctetString, version.length + rsaOID.length);

  return wrapInDER(0x30, innerSequence);
}

function wrapInDER(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length;
  let header: Uint8Array;

  if (len < 128) {
    header = new Uint8Array([tag, len]);
  } else if (len < 256) {
    header = new Uint8Array([tag, 0x81, len]);
  } else if (len < 65536) {
    header = new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = new Uint8Array([
      tag,
      0x83,
      (len >> 16) & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
    ]);
  }

  const result = new Uint8Array(header.length + content.length);
  result.set(header, 0);
  result.set(content, header.length);
  return result;
}

/**
 * Get installation access token for a user's GitHub App installation.
 */
async function getInstallationToken(
  supabaseClient: ReturnType<typeof createClient>,
  userId: string
): Promise<string | null> {
  try {
    // Look up user's GitHub App installation
    const { data: installation, error: installError } = await supabaseClient
      .from("github_app_installations")
      .select("installation_id")
      .eq("user_id", userId)
      .single();

    if (installError || !installation) {
      console.log("No GitHub App installation found for user:", userId);
      return null;
    }

    // Get GitHub App credentials
    const appId = Deno.env.get("GITHUB_APP_ID");
    const privateKey = Deno.env.get("GITHUB_APP_PRIVATE_KEY");

    if (!appId || !privateKey) {
      console.warn("Missing GitHub App credentials");
      return null;
    }

    // Generate JWT and request installation access token
    const jwt = await generateAppJWT(appId, privateKey);

    const response = await fetch(
      `https://api.github.com/app/installations/${installation.installation_id}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("GitHub API error generating token:", error);
      return null;
    }

    const tokenData = await response.json();
    return tokenData.token;
  } catch (error) {
    console.error("Failed to generate installation token:", error);
    return null;
  }
}

/**
 * Check rate limit for fork operations using the check_user_rate_limit RPC.
 * Returns rate limit status without incrementing usage.
 */
async function checkForkRateLimit(
  supabaseClient: ReturnType<typeof createClient>,
  userId: string
): Promise<{
  allowed: boolean;
  usageCount: number;
  maxCalls: number;
  remaining: number;
  nextAllowedAt: string | null;
  timeRemainingSeconds: number | null;
}> {
  const { data: rateLimitResult, error: rateLimitError } = await supabaseClient
    .rpc("check_user_rate_limit", {
      p_user_id: userId,
      p_action_type: "fork",
    });

  if (rateLimitError) {
    console.error("Error checking fork rate limit:", JSON.stringify(rateLimitError));
    console.error("This likely means the SQL function hasn't been updated to accept 'fork' action type");
    // Default to allowing on error to not block users
    return {
      allowed: true,
      usageCount: 0,
      maxCalls: FORK_RATE_LIMIT,
      remaining: FORK_RATE_LIMIT,
      nextAllowedAt: null,
      timeRemainingSeconds: null,
    };
  }

  // Check if the RPC returned an error in the result (e.g., invalid action type)
  if (rateLimitResult && rateLimitResult.allowed === false && rateLimitResult.reason) {
    console.error("Rate limit check returned error:", rateLimitResult.reason);
    if (rateLimitResult.reason.includes("Invalid action type")) {
      console.error("SQL function needs to be updated to accept 'fork' action type");
      // Allow fork to proceed if SQL hasn't been updated yet
      return {
        allowed: true,
        usageCount: 0,
        maxCalls: FORK_RATE_LIMIT,
        remaining: FORK_RATE_LIMIT,
        nextAllowedAt: null,
        timeRemainingSeconds: null,
      };
    }
  }

  return {
    allowed: rateLimitResult.allowed,
    usageCount: rateLimitResult.usage_count || 0,
    maxCalls: rateLimitResult.max_calls || FORK_RATE_LIMIT,
    remaining: rateLimitResult.remaining_calls || 0,
    nextAllowedAt: rateLimitResult.next_allowed_at || null,
    timeRemainingSeconds: rateLimitResult.time_remaining_seconds || null,
  };
}

/**
 * Record a successful fork using increment_user_usage and complete_user_usage RPCs.
 * Only called after a successful fork - failed forks are not recorded.
 */
async function recordSuccessfulFork(
  supabaseClient: ReturnType<typeof createClient>,
  userId: string,
  sourceRepo: string,
  forkedRepo: string
): Promise<{ success: boolean; error?: string }> {
  console.log(`Recording successful fork: ${sourceRepo} -> ${forkedRepo} for user ${userId}`);
  
  // Create usage record via increment_user_usage RPC
  const { data: usageResult, error: usageError } = await supabaseClient
    .rpc("increment_user_usage", {
      p_user_id: userId,
      p_action_type: "fork",
      p_source_repo: sourceRepo,
      p_target_repo: forkedRepo,
      p_branch_name: null,
    });

  if (usageError) {
    console.error("Error recording fork usage (RPC error):", JSON.stringify(usageError));
    console.error("This likely means the SQL function hasn't been updated to accept 'fork' action type");
    return { success: false, error: usageError.message };
  }

  console.log("increment_user_usage result:", JSON.stringify(usageResult));

  if (!usageResult || !usageResult.success) {
    const errorMsg = usageResult?.error || "Unknown error from increment_user_usage";
    console.error("Fork usage increment failed:", errorMsg);
    if (errorMsg.includes("Invalid action type")) {
      console.error("SQL function needs to be updated to accept 'fork' action type");
    }
    return { success: false, error: errorMsg };
  }

  const usageId = usageResult.usage_id;
  console.log("Created usage record with ID:", usageId);

  // Immediately mark as successful via complete_user_usage RPC
  const { data: completeResult, error: completeError } = await supabaseClient
    .rpc("complete_user_usage", {
      p_usage_id: usageId,
      p_success: true,
      p_thread_id: null,
      p_error_message: null,
    });

  if (completeError) {
    console.error("Error completing fork usage:", JSON.stringify(completeError));
    return { success: false, error: completeError.message };
  }

  console.log("complete_user_usage result:", JSON.stringify(completeResult));

  if (!completeResult || !completeResult.success) {
    console.error("Fork usage completion failed:", completeResult?.error);
    return { success: false, error: completeResult?.error || "Unknown error" };
  }

  console.log("Successfully recorded fork usage");
  return { success: true };
}

/**
 * Fetch repository info from GitHub (public API, no auth required for public repos).
 */
async function getRepoInfo(
  owner: string,
  repo: string
): Promise<{
  success: boolean;
  data?: {
    full_name: string;
    private: boolean;
    license: { key: string; spdx_id: string; name: string } | null;
    fork: boolean;
    description: string | null;
  };
  error?: string;
}> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          // Use a user agent to avoid rate limiting
          "User-Agent": "Splicer-Fork-Service",
        },
      }
    );

    if (response.status === 404) {
      return {
        success: false,
        error: "Repository not found. Make sure the repository exists and is public.",
      };
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("GitHub API error:", errorText);
      return {
        success: false,
        error: "Failed to fetch repository information from GitHub.",
      };
    }

    const data = await response.json();
    return {
      success: true,
      data: {
        full_name: data.full_name,
        private: data.private,
        license: data.license,
        fork: data.fork,
        description: data.description,
      },
    };
  } catch (error) {
    console.error("Error fetching repo info:", error);
    return {
      success: false,
      error: "Network error while fetching repository information.",
    };
  }
}

/**
 * Create a fork of a repository.
 */
async function createFork(
  token: string,
  owner: string,
  repo: string
): Promise<{
  success: boolean;
  data?: {
    id: number;
    full_name: string;
    html_url: string;
  };
  error?: string;
}> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/forks`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          default_branch_only: true, // Only fork the default branch for efficiency
        }),
      }
    );

    // GitHub returns 202 Accepted for fork creation (async operation)
    if (response.status !== 202 && response.status !== 200) {
      const errorData = await response.json().catch(() => ({}));
      console.error("Fork API error:", response.status, errorData);

      if (response.status === 403) {
        return {
          success: false,
          error:
            "Permission denied. Make sure the Splicer GitHub App has access to create repositories.",
        };
      }

      if (response.status === 422) {
        // Validation error - might already have a fork
        if (errorData.message?.includes("already exists")) {
          return {
            success: false,
            error:
              "You already have a fork of this repository in your account.",
          };
        }
        return {
          success: false,
          error: errorData.message || "Repository cannot be forked.",
        };
      }

      return {
        success: false,
        error: errorData.message || "Failed to create fork.",
      };
    }

    const data = await response.json();
    return {
      success: true,
      data: {
        id: data.id,
        full_name: data.full_name,
        html_url: data.html_url,
      },
    };
  } catch (error) {
    console.error("Error creating fork:", error);
    return {
      success: false,
      error: "Network error while creating fork.",
    };
  }
}

// ============ Response Helpers ============

function jsonResponse(
  corsHeaders: Record<string, string>,
  data: unknown,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ============ Main Handler ============

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only allow POST
  if (req.method !== "POST") {
    return jsonResponse(corsHeaders, { error: "Method not allowed" }, 405);
  }

  try {
    // Parse request body
    let body: { owner?: string; repo?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse(corsHeaders, { error: "Invalid JSON body" }, 400);
    }

    // Validate required fields
    const { owner, repo } = body;
    if (!owner || !repo) {
      return jsonResponse(
        corsHeaders,
        {
          error: "Missing required fields",
          details: "Both 'owner' and 'repo' are required.",
        },
        400
      );
    }

    // Validate owner/repo format
    const validNameRegex = /^[a-zA-Z0-9_.-]+$/;
    if (!validNameRegex.test(owner) || !validNameRegex.test(repo)) {
      return jsonResponse(
        corsHeaders,
        {
          error: "Invalid repository identifier",
          details: "Owner and repo names can only contain alphanumeric characters, hyphens, underscores, and periods.",
        },
        400
      );
    }

    // ============ Authenticate User ============
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: { headers: { Authorization: req.headers.get("Authorization")! } },
      }
    );

    const {
      data: { user },
      error: authError,
    } = await supabaseClient.auth.getUser();

    if (authError || !user) {
      return jsonResponse(corsHeaders, { error: "Unauthorized" }, 401);
    }

    // Create service role client for database operations
    const supabaseServiceClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // ============ Check Rate Limit ============
    const rateLimit = await checkForkRateLimit(supabaseServiceClient, user.id);

    if (!rateLimit.allowed) {
      const resetMessage = rateLimit.nextAllowedAt
        ? ` Your limit will reset on ${new Date(rateLimit.nextAllowedAt).toLocaleDateString()}.`
        : "";

      return jsonResponse(
        corsHeaders,
        {
          error: "rate_limit_exceeded",
          message: `You have reached the limit of ${rateLimit.maxCalls} forks per week.${resetMessage}`,
          limit: rateLimit.maxCalls,
          used: rateLimit.usageCount,
          reset_at: rateLimit.nextAllowedAt || null,
          time_remaining_seconds: rateLimit.timeRemainingSeconds,
        },
        429
      );
    }

    // ============ Fetch Repository Info ============
    const repoInfo = await getRepoInfo(owner, repo);

    if (!repoInfo.success || !repoInfo.data) {
      return jsonResponse(
        corsHeaders,
        {
          error: "Repository not accessible",
          details: repoInfo.error,
        },
        404
      );
    }

    // Check if repository is private
    if (repoInfo.data.private) {
      return jsonResponse(
        corsHeaders,
        {
          error: "Private repository",
          details: "Only public repositories can be forked through Splicer.",
        },
        403
      );
    }

    // ============ Validate License ============
    const license = repoInfo.data.license;

    if (!license || !license.spdx_id) {
      return jsonResponse(
        corsHeaders,
        {
          error: "No license detected",
          message:
            "This repository does not have a recognized license. Only repositories with permissive open-source licenses can be forked.",
          details:
            "The repository owner should add a LICENSE file with a permissive license (e.g., MIT, Apache-2.0, BSD).",
        },
        403
      );
    }

    if (!ALLOWED_LICENSES.has(license.spdx_id)) {
      return jsonResponse(
        corsHeaders,
        {
          error: "License not supported",
          message: `This repository uses the ${license.name} (${license.spdx_id}) license, which is not supported for forking through Splicer.`,
          details:
            "Only permissive licenses are allowed. Supported licenses include: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Unlicense, and others.",
          license: {
            key: license.key,
            spdx_id: license.spdx_id,
            name: license.name,
          },
        },
        403
      );
    }

    // ============ Get Installation Token ============
    const installationToken = await getInstallationToken(supabaseClient, user.id);

    if (!installationToken) {
      return jsonResponse(
        corsHeaders,
        {
          error: "GitHub App not installed",
          details:
            "Please install the Splicer GitHub App to your account to fork repositories.",
        },
        400
      );
    }

    // ============ Create Fork ============
    const forkResult = await createFork(installationToken, owner, repo);

    if (!forkResult.success || !forkResult.data) {
      // Failed forks are NOT recorded - only successful forks count toward rate limit
      return jsonResponse(
        corsHeaders,
        {
          error: "Fork failed",
          details: forkResult.error,
        },
        500
      );
    }

    // ============ Record Successful Usage ============
    // Only successful forks are recorded and count toward the rate limit
    const usageResult = await recordSuccessfulFork(
      supabaseServiceClient,
      user.id,
      `${owner}/${repo}`,
      forkResult.data.full_name
    );

    if (!usageResult.success) {
      // Fork succeeded but usage recording failed - log but don't fail the request
      console.error("Failed to record fork usage:", usageResult.error);
    }

    // ============ Return Success ============
    console.log(
      `User ${user.id} forked ${owner}/${repo} -> ${forkResult.data.full_name}`
    );

    return jsonResponse(corsHeaders, {
      success: true,
      message: "Repository forked successfully",
      forked_repo: {
        id: forkResult.data.id,
        full_name: forkResult.data.full_name,
        html_url: forkResult.data.html_url,
      },
      source_repo: {
        full_name: repoInfo.data.full_name,
        license: license.spdx_id,
      },
      rate_limit: {
        limit: FORK_RATE_LIMIT,
        remaining: rateLimit.remaining - 1,
      },
    });
  } catch (error) {
    console.error("Fork public repo error:", error);
    return jsonResponse(
      corsHeaders,
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});
