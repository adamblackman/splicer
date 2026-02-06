// Guest mode support v1.0
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SignJWT, importPKCS8 } from 'https://deno.land/x/jose@v5.2.0/index.ts'

// ============ Stream Token Configuration ============
// JWT configuration for stream tokens (HS256)
const STREAM_TOKEN_ISSUER = 'supabase-edge'
const STREAM_TOKEN_AUDIENCE = 'splicer-cloudrun'
const STREAM_TOKEN_LIFETIME_SECONDS = 15 * 60 // 15 minutes

// ============ Guest Mode Configuration ============
// Allowed repos for guest mode (the only repos GUEST_GITHUB_TOKEN has access to)
const GUEST_ALLOWED_REPOS = [
  'adamblackman/0pera1te-demo-1',
  'adamblackman/0pera1te-demo-2',
]

declare const Deno: {
  env: {
    get(key: string): string | undefined
  }
}

// ============ Guest Mode Utilities ============

/**
 * Hash a client IP address using SHA-256 with a secret salt.
 * This is privacy-compliant - raw IPs are never stored.
 */
async function hashClientIP(ip: string): Promise<string> {
  const salt = Deno.env.get('GUEST_IP_HASH')
  if (!salt) {
    throw new Error('GUEST_IP_HASH secret not configured')
  }
  
  // Combine IP with salt and hash
  const data = new TextEncoder().encode(ip + salt)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  
  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Get client IP from request headers.
 * Checks various headers that proxies/CDNs set.
 */
function getClientIP(req: Request): string {
  // Supabase Edge Functions set this header
  const cfConnectingIP = req.headers.get('cf-connecting-ip')
  if (cfConnectingIP) return cfConnectingIP
  
  // Standard forwarded header
  const xForwardedFor = req.headers.get('x-forwarded-for')
  if (xForwardedFor) {
    // Take the first IP (original client)
    return xForwardedFor.split(',')[0].trim()
  }
  
  // Fallback headers
  const xRealIP = req.headers.get('x-real-ip')
  if (xRealIP) return xRealIP
  
  // If all else fails, return a placeholder (should not happen in production)
  return 'unknown-ip'
}

/**
 * Validate that the requested repos are allowed for guest mode.
 */
function validateGuestRepos(sourceRepo: string, targetRepo: string): { valid: boolean; error?: string } {
  const sourceAllowed = GUEST_ALLOWED_REPOS.includes(sourceRepo)
  const targetAllowed = GUEST_ALLOWED_REPOS.includes(targetRepo)
  
  if (!sourceAllowed && !targetAllowed) {
    return { 
      valid: false, 
      error: `Guest mode only supports demo repositories: ${GUEST_ALLOWED_REPOS.join(', ')}` 
    }
  }
  
  if (!sourceAllowed) {
    return { valid: false, error: `Source repo "${sourceRepo}" is not available in guest mode` }
  }
  
  if (!targetAllowed) {
    return { valid: false, error: `Target repo "${targetRepo}" is not available in guest mode` }
  }
  
  // Repos must be different (can't migrate to self)
  if (sourceRepo === targetRepo) {
    return { valid: false, error: 'Source and target repos must be different' }
  }
  
  return { valid: true }
}

// ============ GitHub App JWT Utilities ============

function normalizePemKey(key: string): string {
  let normalized = key.replace(/\\n/g, '\n')
  
  const needsReformat = !normalized.includes('\n') || 
    (normalized.includes('-----BEGIN') && !normalized.match(/-----BEGIN[^-]+-----\n/))
  
  if (needsReformat) {
    const isPKCS8 = normalized.includes('BEGIN PRIVATE KEY')
    const isPKCS1 = normalized.includes('BEGIN RSA PRIVATE KEY')
    
    if (isPKCS8 || isPKCS1) {
      const header = isPKCS1 ? '-----BEGIN RSA PRIVATE KEY-----' : '-----BEGIN PRIVATE KEY-----'
      const footer = isPKCS1 ? '-----END RSA PRIVATE KEY-----' : '-----END PRIVATE KEY-----'
      
      const regex = isPKCS1 
        ? /-----BEGIN RSA PRIVATE KEY-----([\s\S]*?)-----END RSA PRIVATE KEY-----/
        : /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/
      
      const match = normalized.match(regex)
      if (match) {
        const base64Content = match[1].replace(/\s/g, '')
        const lines: string[] = []
        for (let i = 0; i < base64Content.length; i += 64) {
          lines.push(base64Content.substring(i, i + 64))
        }
        normalized = `${header}\n${lines.join('\n')}\n${footer}`
      }
    }
  }
  
  return normalized
}

async function generateAppJWT(appId: string, privateKey: string): Promise<string> {
  const normalizedKey = normalizePemKey(privateKey)
  const isPKCS1 = normalizedKey.includes('BEGIN RSA PRIVATE KEY')
  
  const key = isPKCS1 
    ? await importPKCS1Key(normalizedKey)
    : await importPKCS8(normalizedKey, 'RS256')
  
  const now = Math.floor(Date.now() / 1000)
  
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 10 * 60)
    .setIssuer(appId)
    .sign(key)
}

async function importPKCS1Key(pem: string): Promise<CryptoKey> {
  const pemContent = pem
    .replace('-----BEGIN RSA PRIVATE KEY-----', '')
    .replace('-----END RSA PRIVATE KEY-----', '')
    .replace(/\s/g, '')
  
  const binaryDer = Uint8Array.from(atob(pemContent), c => c.charCodeAt(0))
  const pkcs8Der = wrapPKCS1InPKCS8(binaryDer)
  
  return await crypto.subtle.importKey(
    'pkcs8',
    pkcs8Der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['sign']
  )
}

function wrapPKCS1InPKCS8(pkcs1: Uint8Array): Uint8Array {
  const rsaOID = new Uint8Array([
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00
  ])
  
  const version = new Uint8Array([0x02, 0x01, 0x00])
  const keyOctetString = wrapInDER(0x04, pkcs1)
  
  const innerSequence = new Uint8Array(version.length + rsaOID.length + keyOctetString.length)
  innerSequence.set(version, 0)
  innerSequence.set(rsaOID, version.length)
  innerSequence.set(keyOctetString, version.length + rsaOID.length)
  
  return wrapInDER(0x30, innerSequence)
}

function wrapInDER(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length
  let header: Uint8Array
  
  if (len < 128) {
    header = new Uint8Array([tag, len])
  } else if (len < 256) {
    header = new Uint8Array([tag, 0x81, len])
  } else if (len < 65536) {
    header = new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff])
  } else {
    header = new Uint8Array([tag, 0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff])
  }
  
  const result = new Uint8Array(header.length + content.length)
  result.set(header, 0)
  result.set(content, header.length)
  return result
}

/**
 * Generate an installation access token for GitHub API operations.
 * Returns null if no installation found or token generation fails.
 */
async function getInstallationToken(
  supabaseClient: ReturnType<typeof createClient>,
  userId: string
): Promise<string | null> {
  try {
    // Look up user's GitHub App installation
    const { data: installation, error: installError } = await supabaseClient
      .from('github_app_installations')
      .select('installation_id')
      .eq('user_id', userId)
      .single()

    if (installError || !installation) {
      console.log('No GitHub App installation found for user:', userId)
      return null
    }

    // Get GitHub App credentials
    const appId = Deno.env.get('GITHUB_APP_ID')
    const privateKey = Deno.env.get('GITHUB_APP_PRIVATE_KEY')

    if (!appId || !privateKey) {
      console.warn('Missing GitHub App credentials')
      return null
    }

    // Generate JWT and request installation access token
    const jwt = await generateAppJWT(appId, privateKey)
    
    const response = await fetch(
      `https://api.github.com/app/installations/${installation.installation_id}/access_tokens`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    )

    if (!response.ok) {
      const error = await response.text()
      console.error('GitHub API error generating token:', error)
      return null
    }

    const tokenData = await response.json()
    return tokenData.token
  } catch (error) {
    console.error('Failed to generate installation token:', error)
    return null
  }
}

// ============ Stream Token Generation ============

interface StreamTokenRequest {
  assistant_id?: string
  input: Record<string, unknown> & {
    source_repo?: string
    target_repo?: string
    branch?: string
  }
  config?: {
    configurable?: {
      thread_id?: string
    }
  }
  stream_mode?: string[]
}

interface StreamTokenResponse {
  stream_url: string
  token: string
}

interface GuestStreamTokenResponse extends StreamTokenResponse {
  thread_id: string
  usage_id: string
}

/**
 * Generate a short-lived JWT for direct Cloud Run streaming.
 * 
 * The token contains:
 * - github_token: Installation access token for GitHub API
 * - thread_id: Thread ID for checkpointing
 * - sub: User ID for audit logging
 * - iss/aud: For token validation
 * - exp: 15 minute expiration
 * 
 * Uses HS256 algorithm with CLOUD_RUN_STREAM_SECRET.
 */
async function generateStreamToken(
  userId: string,
  githubToken: string,
  threadId: string
): Promise<string> {
  const secret = Deno.env.get('CLOUD_RUN_STREAM_SECRET')
  if (!secret) {
    throw new Error('CLOUD_RUN_STREAM_SECRET not configured')
  }

  // Create secret key for HS256
  const secretKey = new TextEncoder().encode(secret)

  // Calculate expiration (15 minutes from now)
  const exp = Math.floor(Date.now() / 1000) + STREAM_TOKEN_LIFETIME_SECONDS

  // Create and sign JWT with all required claims
  const token = await new SignJWT({
    github_token: githubToken,
    thread_id: threadId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(STREAM_TOKEN_ISSUER)
    .setAudience(STREAM_TOKEN_AUDIENCE)
    .setExpirationTime(exp)
    .setIssuedAt()
    .sign(secretKey)

  return token
}

/**
 * Handle the /check-rate-limit endpoint for AUTHENTICATED users.
 * 
 * This endpoint ONLY checks rate limit without incrementing usage.
 * Used for pre-flight checks before navigating to the migration page.
 */
async function handleUserCheckRateLimit(
  req: Request,
  user: { id: string },
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Create service role client for DB operations (bypasses RLS)
  const supabaseServiceClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // Call check_user_rate_limit to check without incrementing
  const { data: rateLimitResult, error: rateLimitError } = await supabaseServiceClient
    .rpc('check_user_rate_limit', {
      p_user_id: user.id,
      p_action_type: 'agent',
    })

  if (rateLimitError) {
    console.error('Failed to check user rate limit:', rateLimitError)
    return new Response(
      JSON.stringify({ error: 'Failed to check rate limit' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Return rate limit status
  if (!rateLimitResult.allowed) {
    console.log(`User rate limited (check only): ${user.id}`)
    return new Response(
      JSON.stringify({
        allowed: false,
        error: 'rate_limit_exceeded',
        message: rateLimitResult.reason || 'You have reached your migration limit. Email adam@notifai.info for more access.',
        next_allowed_at: rateLimitResult.next_allowed_at,
        time_remaining_seconds: rateLimitResult.time_remaining_seconds,
        usage_count: rateLimitResult.usage_count,
        max_calls: rateLimitResult.max_calls,
      }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  return new Response(
    JSON.stringify({ 
      allowed: true,
      usage_count: rateLimitResult.usage_count,
      max_calls: rateLimitResult.max_calls,
      remaining_calls: rateLimitResult.remaining_calls,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

/**
 * Handle the /stream-token endpoint for authenticated users.
 * 
 * Validates user auth, checks rate limit, gets GitHub token, and returns a signed JWT
 * that the frontend can use to stream directly to Cloud Run.
 */
async function handleStreamToken(
  req: Request,
  supabaseClient: ReturnType<typeof createClient>,
  user: { id: string },
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Parse request body
  let body: StreamTokenRequest
  try {
    body = await req.json()
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Validate required fields
  if (!body.input) {
    return new Response(
      JSON.stringify({ error: 'Missing required field: input' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Extract repos from input for rate limit tracking
  const sourceRepo = body.input.source_repo as string || null
  const targetRepo = body.input.target_repo as string || null
  const branchName = body.input.branch as string || 'splice'

  // ============ RATE LIMIT CHECK ============
  // Create service role client for rate limit operations
  const supabaseServiceClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // Check rate limit and increment usage atomically (BEFORE starting migration)
  // This prevents users from starting multiple migrations in parallel
  const { data: usageResult, error: usageError } = await supabaseServiceClient
    .rpc('increment_user_usage', {
      p_user_id: user.id,
      p_action_type: 'agent',
      p_source_repo: sourceRepo,
      p_target_repo: targetRepo,
      p_branch_name: branchName,
    })

  if (usageError) {
    console.error('Failed to check/increment user usage:', usageError)
    return new Response(
      JSON.stringify({ error: 'Failed to validate user access' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Check if rate limited
  if (!usageResult.success) {
    console.log(`User rate limited: ${user.id}`)
    return new Response(
      JSON.stringify({
        error: 'rate_limit_exceeded',
        message: usageResult.error || 'You have reached your migration limit. Email adam@notifai.info for more access.',
        next_allowed_at: usageResult.next_allowed_at,
        time_remaining_seconds: usageResult.time_remaining_seconds,
        usage_count: usageResult.usage_count,
        max_calls: usageResult.max_calls,
      }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const usageId = usageResult.usage_id

  // Get GitHub installation token - REQUIRED for agent to function
  const githubToken = await getInstallationToken(supabaseClient, user.id)
  if (!githubToken) {
    // Mark usage as failed since we couldn't proceed
    await supabaseServiceClient.rpc('complete_user_usage', {
      p_usage_id: usageId,
      p_success: false,
      p_error_message: 'GitHub app not installed or token unavailable',
    })
    return new Response(
      JSON.stringify({ 
        error: 'GitHub app not installed or token unavailable',
        details: 'Please install the Splicer GitHub App to continue'
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Get or generate thread_id
  const threadId = body.config?.configurable?.thread_id || crypto.randomUUID()

  // Update usage record with thread ID
  await supabaseServiceClient.rpc('complete_user_usage', {
    p_usage_id: usageId,
    p_success: true,
    p_thread_id: threadId,
  })

  // Generate the stream token
  let token: string
  try {
    token = await generateStreamToken(user.id, githubToken, threadId)
  } catch (error) {
    console.error('Failed to generate stream token:', error)
    return new Response(
      JSON.stringify({ error: 'Failed to generate stream token' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Get Cloud Run URL
  const cloudRunUrl = Deno.env.get('AGENT_GOOGLE_CLOUD_RUN')
  if (!cloudRunUrl) {
    console.error('AGENT_GOOGLE_CLOUD_RUN not configured')
    return new Response(
      JSON.stringify({ error: 'Server misconfigured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Build stream URL (no trailing slash)
  const streamUrl = `${cloudRunUrl.replace(/\/$/, '')}/runs/stream`

  // Return token and URL
  const response: StreamTokenResponse = {
    stream_url: streamUrl,
    token: token,
  }

  console.log(`Issued stream token for user ${user.id}, thread ${threadId}, usage ${usageId}`)

  return new Response(
    JSON.stringify(response),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

/**
 * Handle the /check-rate-limit endpoint for GUEST users.
 * 
 * This endpoint ONLY checks rate limit without incrementing usage.
 * Used for pre-flight checks before navigating to the migration page.
 */
async function handleGuestCheckRateLimit(
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Create service role client for DB operations (bypasses RLS)
  const supabaseServiceClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // Get and hash client IP
  const clientIP = getClientIP(req)
  let ipHash: string
  try {
    ipHash = await hashClientIP(clientIP)
  } catch (error) {
    console.error('Failed to hash client IP:', error)
    return new Response(
      JSON.stringify({ error: 'Server configuration error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Call check_guest_rate_limit to check without incrementing
  const { data: rateLimitResult, error: rateLimitError } = await supabaseServiceClient
    .rpc('check_guest_rate_limit', {
      p_ip_hash: ipHash,
      p_action_type: 'agent',
    })

  if (rateLimitError) {
    console.error('Failed to check guest rate limit:', rateLimitError)
    return new Response(
      JSON.stringify({ error: 'Failed to check rate limit' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Return rate limit status
  if (!rateLimitResult.allowed) {
    console.log(`Guest rate limited (check only): ${ipHash.substring(0, 8)}...`)
    return new Response(
      JSON.stringify({
        allowed: false,
        error: 'rate_limit_exceeded',
        message: rateLimitResult.message,
        next_allowed_at: rateLimitResult.next_allowed_at,
        time_remaining_seconds: rateLimitResult.time_remaining_seconds,
      }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  return new Response(
    JSON.stringify({ allowed: true }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

/**
 * Handle the /stream-token endpoint for GUEST users.
 * 
 * - Validates rate limit by hashed IP
 * - Uses GUEST_GITHUB_TOKEN for repo access
 * - Creates a guest thread (user_id = null)
 * - Validates only allowed repos are requested
 */
async function handleGuestStreamToken(
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Create service role client for DB operations (bypasses RLS)
  const supabaseServiceClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // Parse request body
  let body: StreamTokenRequest
  try {
    body = await req.json()
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Validate required fields
  if (!body.input) {
    return new Response(
      JSON.stringify({ error: 'Missing required field: input' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Extract and validate repos from input
  const sourceRepo = body.input.source_repo as string
  const targetRepo = body.input.target_repo as string
  
  if (!sourceRepo || !targetRepo) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: source_repo and target_repo' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Validate repos are allowed for guest mode
  const repoValidation = validateGuestRepos(sourceRepo, targetRepo)
  if (!repoValidation.valid) {
    return new Response(
      JSON.stringify({ error: repoValidation.error }),
      { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Get and hash client IP
  const clientIP = getClientIP(req)
  let ipHash: string
  try {
    ipHash = await hashClientIP(clientIP)
  } catch (error) {
    console.error('Failed to hash client IP:', error)
    return new Response(
      JSON.stringify({ error: 'Server configuration error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Generate guest branch name: splice-guest-{ISO timestamp without special chars}
  // Format: splice-guest-20260204143025
  const now = new Date()
  const timestamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '')
    .replace(/\.\d{3}Z$/, '')
  const guestBranch = `splice-guest-${timestamp}`

  // Check rate limit and increment usage atomically (BEFORE starting migration)
  const { data: usageResult, error: usageError } = await supabaseServiceClient
    .rpc('increment_guest_usage', {
      p_ip_hash: ipHash,
      p_action_type: 'agent',
      p_source_repo: sourceRepo,
      p_target_repo: targetRepo,
      p_branch_name: guestBranch,
    })

  if (usageError) {
    console.error('Failed to check/increment guest usage:', usageError)
    return new Response(
      JSON.stringify({ error: 'Failed to validate guest access' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Check if rate limited
  if (!usageResult.success) {
    console.log(`Guest rate limited: ${ipHash.substring(0, 8)}...`)
    return new Response(
      JSON.stringify({
        error: 'rate_limit_exceeded',
        message: usageResult.error,
        next_allowed_at: usageResult.next_allowed_at,
        time_remaining_seconds: usageResult.time_remaining_seconds,
      }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const usageId = usageResult.usage_id

  // Create a guest thread (user_id = null)
  const { data: thread, error: threadError } = await supabaseServiceClient
    .from('threads')
    .insert({
      user_id: null,  // Guest threads have no user
      source_repo: sourceRepo,
      target_repo: targetRepo,
      title: `Guest Migration: ${sourceRepo} → ${targetRepo}`,
    })
    .select()
    .single()

  if (threadError) {
    console.error('Failed to create guest thread:', threadError)
    // Mark usage as failed
    await supabaseServiceClient.rpc('complete_guest_usage', {
      p_usage_id: usageId,
      p_success: false,
      p_error_message: 'Failed to create thread',
    })
    return new Response(
      JSON.stringify({ error: 'Failed to create migration thread' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const threadId = thread.id

  // Update usage record with thread ID
  await supabaseServiceClient.rpc('complete_guest_usage', {
    p_usage_id: usageId,
    p_success: true,
    p_thread_id: threadId,
  })

  // Get GUEST_GITHUB_TOKEN
  const guestGithubToken = Deno.env.get('GUEST_GITHUB_TOKEN')
  if (!guestGithubToken) {
    console.error('GUEST_GITHUB_TOKEN not configured')
    return new Response(
      JSON.stringify({ error: 'Guest mode not available' }),
      { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Generate the stream token with guest identifier
  let token: string
  try {
    // Use a special guest user ID for the token
    token = await generateStreamToken('guest', guestGithubToken, threadId)
  } catch (error) {
    console.error('Failed to generate guest stream token:', error)
    return new Response(
      JSON.stringify({ error: 'Failed to generate stream token' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Get Cloud Run URL
  const cloudRunUrl = Deno.env.get('AGENT_GOOGLE_CLOUD_RUN')
  if (!cloudRunUrl) {
    console.error('AGENT_GOOGLE_CLOUD_RUN not configured')
    return new Response(
      JSON.stringify({ error: 'Server misconfigured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Build stream URL
  const streamUrl = `${cloudRunUrl.replace(/\/$/, '')}/runs/stream`

  // Return token, URL, and guest-specific info
  const response: GuestStreamTokenResponse = {
    stream_url: streamUrl,
    token: token,
    thread_id: threadId,
    usage_id: usageId,
  }

  console.log(`Issued GUEST stream token, thread ${threadId}, branch ${guestBranch}`)

  return new Response(
    JSON.stringify(response),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

// ============ CORS Configuration ============
// Only allow requests from spliceronline.com and its subdomains (HTTPS only)
const ALLOWED_ORIGIN_SUFFIX = '.spliceronline.com'
const ALLOWED_EXACT_ORIGINS = ['https://spliceronline.com']

/**
 * Check if the request origin is allowed.
 * Allows: spliceronline.com and any *.spliceronline.com subdomain (HTTPS only)
 */
function isAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null
  
  // Check exact match (apex domain)
  if (ALLOWED_EXACT_ORIGINS.includes(origin)) {
    return origin
  }
  
  // Check subdomain pattern (*.spliceronline.com)
  try {
    const url = new URL(origin)
    if (url.protocol === 'https:' && url.hostname.endsWith(ALLOWED_ORIGIN_SUFFIX)) {
      return origin
    }
  } catch {
    return null
  }
  
  return null
}

/**
 * Get CORS headers for a request. Returns appropriate headers based on origin.
 */
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  const allowedOrigin = isAllowedOrigin(origin)
  
  // Base headers (always included)
  // NOTE: x-guest-mode header is required for guest mode requests
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-thread-id, x-guest-mode',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Vary': 'Origin', // Important for caching - response varies by Origin
  }
  
  // Only add Allow-Origin if origin is allowed
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin
  }
  
  return headers
}

/**
 * Check if request is in guest mode.
 * Guest mode is indicated by the x-guest-mode: true header.
 */
function isGuestMode(req: Request): boolean {
  return req.headers.get('x-guest-mode') === 'true'
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Parse the request URL to get the path after /agent
  const url = new URL(req.url)
  const pathParts = url.pathname.split('/agent')
  const remainingPath = pathParts.length > 1 ? pathParts[1] : ''

  try {
    // ============ GUEST MODE HANDLING ============
    // Guest requests use x-guest-mode: true header and don't require Authorization
    if (isGuestMode(req)) {
      // Rate limit check endpoint (check only, no increment)
      if (req.method === 'GET' && remainingPath === '/check-rate-limit') {
        return await handleGuestCheckRateLimit(req, corsHeaders)
      }
      
      // Stream token endpoint (checks and increments rate limit)
      if (req.method === 'POST' && remainingPath === '/stream-token') {
        return await handleGuestStreamToken(req, corsHeaders)
      }
      
      // Guests cannot access other endpoints (cancel, etc.)
      return new Response(
        JSON.stringify({ error: 'Endpoint not available in guest mode' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ============ AUTHENTICATED MODE ============
    // Create Supabase client with user's auth token
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    )

    // Validate JWT - CRITICAL security check
    const {
      data: { user },
      error: authError,
    } = await supabaseClient.auth.getUser()

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ============ Route: /check-rate-limit (Authenticated) ============
    // Check if user is rate limited without incrementing usage
    if (req.method === 'GET' && remainingPath === '/check-rate-limit') {
      return await handleUserCheckRateLimit(req, user, corsHeaders)
    }

    // ============ Route: /stream-token ============
    // Issue a short-lived JWT for direct Cloud Run streaming
    if (req.method === 'POST' && remainingPath === '/stream-token') {
      return await handleStreamToken(req, supabaseClient, user, corsHeaders)
    }

    // ============ Route: /runs/stream (DEPRECATED) ============
    // Direct streaming through the Edge Function is no longer supported.
    // Clients must use /stream-token to get a JWT, then stream directly to Cloud Run.
    if (remainingPath === '/runs/stream') {
      return new Response(
        JSON.stringify({ 
          error: 'Direct streaming through Edge Function is deprecated',
          details: 'Use POST /agent/stream-token to get a token, then stream directly to Cloud Run',
          migration: {
            step1: 'POST /agent/stream-token with your request body',
            step2: 'Use the returned stream_url and token to stream directly',
          }
        }),
        { 
          status: 410, // Gone
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // ============ Proxy: Cancel and other endpoints ============
    // Cancel requests and other non-streaming endpoints still go through the proxy
    // to maintain user authentication via Supabase session.
    
    // Get Cloud Run URL from secure environment
    const cloudRunUrl = Deno.env.get('AGENT_GOOGLE_CLOUD_RUN')
    if (!cloudRunUrl) {
      throw new Error('Missing AGENT_GOOGLE_CLOUD_RUN secret')
    }
    
    // Build the target URL
    const targetUrl = `${cloudRunUrl}${remainingPath}${url.search}`

    // Get request body for POST/PUT requests
    let body: string | undefined
    if (req.method === 'POST' || req.method === 'PUT') {
      body = await req.text()
    }

    // Forward the request to Cloud Run
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // Pass thread_id if provided
        ...(req.headers.get('x-thread-id') && { 'x-thread-id': req.headers.get('x-thread-id')! }),
      },
      body,
    })

    // Handle the response
    const responseText = await response.text()
    
    // Some endpoints (like cancel) return empty responses
    if (!responseText) {
      return new Response(null, {
        status: response.status,
        headers: corsHeaders,
      })
    }
    
    // Try to parse as JSON, otherwise return as-is
    try {
      const data = JSON.parse(responseText)
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    } catch {
      return new Response(responseText, {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      })
    }

  } catch (error) {
    console.error('Agent proxy error:', error)
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})
