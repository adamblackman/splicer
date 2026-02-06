/**
 * GitHub App Callback Edge Function
 * 
 * Handles the redirect from GitHub after a user installs the GitHub App.
 * Links the installation to the authenticated Supabase user.
 * 
 * Flow:
 * 1. GitHub redirects here with installation_id after app installation
 * 2. If user not authenticated, redirect to frontend to complete auth
 * 3. If authenticated, link installation to user and fetch repos
 * 4. Redirect to app with success/error status
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SignJWT, importPKCS8 } from 'https://deno.land/x/jose@v5.2.0/index.ts'

declare const Deno: {
  env: {
    get(key: string): string | undefined
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const siteUrl = Deno.env.get('SITE_URL') || 'http://localhost:5173'

  try {
    const url = new URL(req.url)
    const installationId = url.searchParams.get('installation_id')
    const setupAction = url.searchParams.get('setup_action')
    
    if (!installationId) {
      return redirectWithError(siteUrl, 'missing_installation_id')
    }

    // Create Supabase client with user's auth
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } }
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      // Not authenticated - redirect to frontend to complete auth flow
      return new Response(null, {
        status: 302,
        headers: {
          'Location': `${siteUrl}/github/callback?installation_id=${installationId}&setup_action=${setupAction || 'install'}`,
        },
      })
    }

    // Get GitHub App credentials
    const appId = Deno.env.get('GITHUB_APP_ID')
    const privateKey = Deno.env.get('GITHUB_APP_PRIVATE_KEY')
    
    if (!appId || !privateKey) {
      console.error('Missing GitHub App credentials')
      return redirectWithError(siteUrl, 'config_error')
    }

    // Fetch installation details from GitHub
    const jwt = await generateAppJWT(appId, privateKey)
    const installation = await fetchInstallation(installationId, jwt)

    // Create admin client to bypass RLS
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Store installation record
    const { error: insertError } = await supabaseAdmin
      .from('github_app_installations')
      .upsert({
        user_id: user.id,
        installation_id: parseInt(installationId),
        github_account_login: installation.account.login,
        github_account_type: installation.account.type,
        github_account_id: installation.account.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'installation_id' })

    if (insertError) {
      console.error('Error storing installation:', insertError)
      return redirectWithError(siteUrl, 'database_error')
    }

    // Fetch and store accessible repos
    const token = await getInstallationToken(installationId, jwt)
    const repos = await fetchInstallationRepos(token)
    
    if (repos.length > 0) {
      const repoRecords = repos.map((repo: any) => ({
        installation_id: parseInt(installationId),
        repo_id: repo.id,
        repo_full_name: repo.full_name,
        repo_private: repo.private,
      }))
      
      await supabaseAdmin
        .from('github_app_installation_repos')
        .upsert(repoRecords, { onConflict: 'installation_id,repo_id' })
    }

    // Success - redirect to landing page
    return new Response(null, {
      status: 302,
      headers: { 'Location': `${siteUrl}/?github_app_installed=true` },
    })

  } catch (error) {
    console.error('Callback error:', error)
    return redirectWithError(siteUrl, 'github_callback_failed')
  }
})

function redirectWithError(siteUrl: string, error: string): Response {
  return new Response(null, {
    status: 302,
    headers: { 'Location': `${siteUrl}/?error=${error}` },
  })
}

/**
 * Normalize PEM key formatting
 * Handles: escaped newlines (\n as text), missing newlines, both PKCS#1 and PKCS#8
 */
function normalizePemKey(key: string): string {
  // Handle escaped newlines
  let normalized = key.replace(/\\n/g, '\n')
  
  // Check if key needs reformatting (no newlines or newlines in wrong places)
  const needsReformat = !normalized.includes('\n') || 
    (normalized.includes('-----BEGIN') && !normalized.match(/-----BEGIN[^-]+-----\n/))
  
  if (needsReformat) {
    // Detect key type
    const isPKCS8 = normalized.includes('BEGIN PRIVATE KEY')
    const isPKCS1 = normalized.includes('BEGIN RSA PRIVATE KEY')
    
    if (isPKCS8 || isPKCS1) {
      const header = isPKCS1 ? '-----BEGIN RSA PRIVATE KEY-----' : '-----BEGIN PRIVATE KEY-----'
      const footer = isPKCS1 ? '-----END RSA PRIVATE KEY-----' : '-----END PRIVATE KEY-----'
      
      // Extract base64 content
      const regex = isPKCS1 
        ? /-----BEGIN RSA PRIVATE KEY-----([\s\S]*?)-----END RSA PRIVATE KEY-----/
        : /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/
      
      const match = normalized.match(regex)
      if (match) {
        const base64Content = match[1].replace(/\s/g, '')
        
        // Format with 64-char lines (PEM standard)
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

/**
 * Generate JWT for GitHub App authentication
 * Uses jose library for reliable JWT creation
 */
async function generateAppJWT(appId: string, privateKey: string): Promise<string> {
  const normalizedKey = normalizePemKey(privateKey)
  
  // Determine key format and import accordingly
  const isPKCS1 = normalizedKey.includes('BEGIN RSA PRIVATE KEY')
  
  let key
  if (isPKCS1) {
    // Convert PKCS#1 to PKCS#8 format for jose
    key = await importPKCS1Key(normalizedKey)
  } else {
    key = await importPKCS8(normalizedKey, 'RS256')
  }
  
  const now = Math.floor(Date.now() / 1000)
  
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 10 * 60)
    .setIssuer(appId)
    .sign(key)
}

/**
 * Import PKCS#1 (RSA PRIVATE KEY) format key
 * Converts to format usable by Web Crypto API
 */
async function importPKCS1Key(pem: string): Promise<CryptoKey> {
  // Extract base64 content
  const pemContent = pem
    .replace('-----BEGIN RSA PRIVATE KEY-----', '')
    .replace('-----END RSA PRIVATE KEY-----', '')
    .replace(/\s/g, '')
  
  const binaryDer = Uint8Array.from(atob(pemContent), c => c.charCodeAt(0))
  
  // Wrap PKCS#1 in PKCS#8 structure
  const pkcs8Der = wrapPKCS1InPKCS8(binaryDer)
  
  return await crypto.subtle.importKey(
    'pkcs8',
    pkcs8Der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['sign']
  )
}

/**
 * Wrap PKCS#1 RSAPrivateKey in PKCS#8 PrivateKeyInfo structure
 */
function wrapPKCS1InPKCS8(pkcs1: Uint8Array): Uint8Array {
  // PKCS#8 header for RSA: SEQUENCE { version, algorithmIdentifier, privateKey }
  // AlgorithmIdentifier for RSA: SEQUENCE { OID rsaEncryption, NULL }
  const rsaOID = new Uint8Array([
    0x30, 0x0d,                                     // SEQUENCE (13 bytes)
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, // OID 1.2.840.113549.1.1.1 (rsaEncryption)
    0x01, 0x01, 0x01,
    0x05, 0x00                                      // NULL
  ])
  
  // Version INTEGER 0
  const version = new Uint8Array([0x02, 0x01, 0x00])
  
  // Wrap PKCS#1 key in OCTET STRING
  const keyOctetString = wrapInDER(0x04, pkcs1)
  
  // Combine: version + algorithmIdentifier + privateKey
  const innerSequence = new Uint8Array(version.length + rsaOID.length + keyOctetString.length)
  innerSequence.set(version, 0)
  innerSequence.set(rsaOID, version.length)
  innerSequence.set(keyOctetString, version.length + rsaOID.length)
  
  // Wrap in outer SEQUENCE
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

async function fetchInstallation(installationId: string, jwt: string): Promise<any> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  )

  if (!response.ok) {
    const error = await response.text()
    console.error('GitHub API error:', error)
    throw new Error('Failed to fetch installation')
  }

  return response.json()
}

async function getInstallationToken(installationId: string, jwt: string): Promise<string> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
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
    throw new Error('Failed to get installation token')
  }
  
  const data = await response.json()
  return data.token
}

async function fetchInstallationRepos(token: string): Promise<any[]> {
  const repos: any[] = []
  let page = 1
  
  while (page <= 10) { // Safety limit
    const response = await fetch(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    )
    
    if (!response.ok) break
    
    const data = await response.json()
    repos.push(...data.repositories)
    
    if (data.repositories.length < 100) break
    page++
  }
  
  return repos
}
