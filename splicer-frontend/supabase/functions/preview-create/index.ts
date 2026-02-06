// Guest mode support v1.0
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SignJWT, importPKCS8 } from 'https://deno.land/x/jose@v5.2.0/index.ts'

declare const Deno: any;

// Token cache duration - refresh tokens 5 minutes before expiry
// GitHub installation tokens last ~1 hour, so we cache for 55 minutes
const TOKEN_CACHE_DURATION_MS = 55 * 60 * 1000 // 55 minutes

// ============ Guest Mode Configuration ============
// Allowed repos for guest mode (the only repos GUEST_GITHUB_TOKEN has access to)
const GUEST_ALLOWED_REPOS = [
  'adamblackman/0pera1te-demo-1',
  'adamblackman/0pera1te-demo-2',
]

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
 */
function getClientIP(req: Request): string {
  const cfConnectingIP = req.headers.get('cf-connecting-ip')
  if (cfConnectingIP) return cfConnectingIP
  
  const xForwardedFor = req.headers.get('x-forwarded-for')
  if (xForwardedFor) {
    return xForwardedFor.split(',')[0].trim()
  }
  
  const xRealIP = req.headers.get('x-real-ip')
  if (xRealIP) return xRealIP
  
  return 'unknown-ip'
}

/**
 * Check if request is in guest mode.
 */
function isGuestMode(req: Request): boolean {
  return req.headers.get('x-guest-mode') === 'true'
}

/**
 * Validate that the requested repo is allowed for guest mode.
 */
function validateGuestRepo(owner: string, repo: string): { valid: boolean; error?: string } {
  const fullName = `${owner}/${repo}`
  const isAllowed = GUEST_ALLOWED_REPOS.includes(fullName)
  
  if (!isAllowed) {
    return { 
      valid: false, 
      error: `Guest mode only supports demo repositories: ${GUEST_ALLOWED_REPOS.join(', ')}` 
    }
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
 * Get cached installation token from database.
 * Returns null if no valid cached token exists.
 */
async function getCachedToken(
  supabaseClient: ReturnType<typeof createClient>,
  installationId: number
): Promise<string | null> {
  try {
    const { data, error } = await supabaseClient
      .from('github_app_installations')
      .select('cached_token, token_expires_at')
      .eq('installation_id', installationId)
      .single()

    if (error || !data?.cached_token || !data?.token_expires_at) {
      return null
    }

    // Check if token is still valid (with 5 min buffer)
    const expiresAt = new Date(data.token_expires_at)
    const now = new Date()
    const bufferMs = 5 * 60 * 1000 // 5 minutes

    if (expiresAt.getTime() - now.getTime() < bufferMs) {
      console.log('Cached token is expired or expiring soon')
      return null
    }

    console.log('Using cached GitHub installation token')
    return data.cached_token
  } catch (error) {
    console.error('Error retrieving cached token:', error)
    return null
  }
}

/**
 * Cache installation token in database.
 */
async function cacheToken(
  supabaseClient: ReturnType<typeof createClient>,
  installationId: number,
  token: string,
  expiresAt: string
): Promise<void> {
  try {
    await supabaseClient
      .from('github_app_installations')
      .update({
        cached_token: token,
        token_expires_at: expiresAt,
      })
      .eq('installation_id', installationId)
    
    console.log('Cached GitHub installation token')
  } catch (error) {
    // Non-fatal - token will still work, just won't be cached
    console.warn('Failed to cache token:', error)
  }
}

/**
 * Generate an installation access token for GitHub API operations.
 * Uses caching to reduce GitHub API calls - tokens are valid for ~1 hour.
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
      .select('installation_id, cached_token, token_expires_at')
      .eq('user_id', userId)
      .single()

    if (installError || !installation) {
      console.log('No GitHub App installation found for user:', userId)
      return null
    }

    // Check for valid cached token first
    const cachedToken = await getCachedToken(supabaseClient, installation.installation_id)
    if (cachedToken) {
      return cachedToken
    }

    // Get GitHub App credentials
    const appId = Deno.env.get('GITHUB_APP_ID')
    const privateKey = Deno.env.get('GITHUB_APP_PRIVATE_KEY')

    if (!appId || !privateKey) {
      console.warn('Missing GitHub App credentials')
      return null
    }

    // Generate JWT and request installation access token
    console.log('Fetching new GitHub installation token')
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
    
    // Cache the token for future requests
    if (tokenData.token && tokenData.expires_at) {
      await cacheToken(
        supabaseClient,
        installation.installation_id,
        tokenData.token,
        tokenData.expires_at
      )
    }

    return tokenData.token
  } catch (error) {
    console.error('Failed to generate installation token:', error)
    return null
  }
}

// ============ CORS Configuration ============
// Only allow requests from spliceronline.com and its subdomains (HTTPS only)
const ALLOWED_ORIGIN_SUFFIX = '.spliceronline.com'
const ALLOWED_EXACT_ORIGINS = ['https://spliceronline.com']

function isAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null
  if (ALLOWED_EXACT_ORIGINS.includes(origin)) return origin
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

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  const allowedOrigin = isAllowedOrigin(origin)
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-guest-mode',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin
  }
  return headers
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Parse request body for repo config
    let body: { owner?: string; repo?: string; branch?: string; force_new?: boolean } = {}
    try {
      body = await req.json()
    } catch {
      // No body or invalid JSON, use defaults
    }

    const cloudRunUrl = Deno.env.get('WEBCONTAINER_GOOGLE_CLOUD_RUN')
    if (!cloudRunUrl) {
      throw new Error('Missing WEBCONTAINER_GOOGLE_CLOUD_RUN secret')
    }

    // Get API key for webcontainer authentication
    const apiKey = Deno.env.get('CLOUD_RUN_WEBCONTAINER_SECRET')
    if (!apiKey) {
      throw new Error('Missing CLOUD_RUN_WEBCONTAINER_SECRET secret')
    }

    let githubToken: string | null = null

    // ============ GUEST MODE HANDLING ============
    if (isGuestMode(req)) {
      // Validate repo is allowed for guest mode
      const owner = body.owner || ''
      const repo = body.repo || ''
      
      if (!owner || !repo) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields: owner and repo' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const repoValidation = validateGuestRepo(owner, repo)
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

      // Create service role client for rate limit check
      const supabaseServiceClient = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      )

      // Check rate limit and increment usage atomically
      const { data: usageResult, error: usageError } = await supabaseServiceClient
        .rpc('increment_guest_usage', {
          p_ip_hash: ipHash,
          p_action_type: 'preview',
          p_source_repo: `${owner}/${repo}`,
          p_target_repo: null,
          p_branch_name: body.branch || 'main',
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
        console.log(`Guest preview rate limited: ${ipHash.substring(0, 8)}...`)
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

      // Use GUEST_GITHUB_TOKEN
      githubToken = Deno.env.get('GUEST_GITHUB_TOKEN') || null
      if (!githubToken) {
        console.error('GUEST_GITHUB_TOKEN not configured')
        return new Response(
          JSON.stringify({ error: 'Guest mode not available' }),
          { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      console.log(`Guest preview session for ${owner}/${repo}@${body.branch || 'main'}`)
    } else {
      // ============ AUTHENTICATED MODE ============
      const supabaseClient = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
      )

      const {
        data: { user },
      } = await supabaseClient.auth.getUser()

      if (!user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // ============ RATE LIMIT CHECK FOR AUTHENTICATED USERS ============
      // Create service role client for rate limit operations
      const supabaseServiceClient = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      )

      // Check rate limit and increment usage atomically (BEFORE starting preview)
      // This prevents users from starting multiple previews in parallel
      const { data: usageResult, error: usageError } = await supabaseServiceClient
        .rpc('increment_user_usage', {
          p_user_id: user.id,
          p_action_type: 'preview',
          p_source_repo: `${body.owner || 'unknown'}/${body.repo || 'unknown'}`,
          p_target_repo: null,
          p_branch_name: body.branch || 'main',
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
        console.log(`User preview rate limited: ${user.id}`)
        return new Response(
          JSON.stringify({
            error: 'rate_limit_exceeded',
            message: usageResult.error || 'You have reached your preview limit. Email adam@notifai.info for more access.',
            next_allowed_at: usageResult.next_allowed_at,
            time_remaining_seconds: usageResult.time_remaining_seconds,
            usage_count: usageResult.usage_count,
            max_calls: usageResult.max_calls,
          }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      console.log(`User preview usage recorded: ${user.id}, usage_id: ${usageResult.usage_id}`)

      // Try to get installation token (graceful degradation - continue without if not available)
      // Token caching is handled internally to reduce GitHub API calls
      githubToken = await getInstallationToken(supabaseClient, user.id)
      
      console.log(`Creating session for user ${user.id}`)
    }

    // Build payload for webcontainer
    const payload: Record<string, string | boolean> = {
      repo_owner: body.owner || 'adamblackman',
      repo_name: body.repo || '0pera1te-demo-1',
      repo_ref: body.branch || 'splice',
      // Pass force_new flag - defaults to false (enables session reuse)
      force_new: body.force_new || false,
    }

    // Add github_token if available (allows private repo access)
    if (githubToken) {
      payload.github_token = githubToken
    }

    console.log(`Creating session for ${payload.repo_owner}/${payload.repo_name}@${payload.repo_ref} (force_new: ${payload.force_new})`)

    const response = await fetch(`${cloudRunUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(payload),
    })

    const data = await response.json()
    
    // Transform response to match frontend expectations if necessary
    // README says response is { session: { ... }, message: "..." }
    // Frontend expects { session_id, status, preview_url, error_message }
    
    const sessionData = data.session || {}
    
    return new Response(
      JSON.stringify({
        session_id: sessionData.id,
        status: sessionData.status,
        preview_url: sessionData.preview_url,
        error_message: sessionData.error_message
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: response.status,
      }
    )

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})