/**
 * GitHub Repos Edge Function
 * 
 * Fetches all repositories accessible via the user's GitHub App installation.
 * Returns both public and private repos.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SignJWT, importPKCS8 } from 'https://deno.land/x/jose@v5.2.0/index.ts'

declare const Deno: {
  env: {
    get(key: string): string | undefined
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
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  }
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin
  }
  return headers
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  const jsonResponse = createJsonResponse(corsHeaders)
  
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Authenticate user
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return jsonResponse({ error: 'Unauthorized' }, 401)
    }

    // Get user's installation
    const { data: installation, error: installError } = await supabase
      .from('github_app_installations')
      .select('installation_id')
      .eq('user_id', user.id)
      .single()

    if (installError || !installation) {
      return jsonResponse({ 
        error: 'No GitHub App installation found',
        has_installation: false 
      }, 404)
    }

    // Get GitHub App credentials
    const appId = Deno.env.get('GITHUB_APP_ID')
    const privateKey = Deno.env.get('GITHUB_APP_PRIVATE_KEY')

    if (!appId || !privateKey) {
      throw new Error('Missing GitHub App credentials')
    }

    // Get installation token and fetch repos
    const jwt = await generateAppJWT(appId, privateKey)
    const token = await getInstallationToken(installation.installation_id.toString(), jwt)
    const repos = await fetchInstallationRepos(token)
    
    // Transform and sort repos
    const transformedRepos = repos
      .map((repo: any) => ({
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        description: repo.description,
        html_url: repo.html_url,
        private: repo.private,
        stargazers_count: repo.stargazers_count,
        updated_at: repo.updated_at,
      }))
      .sort((a: any, b: any) => 
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      )

    return jsonResponse({
      repos: transformedRepos,
      has_installation: true,
    })

  } catch (error) {
    console.error('Repos fetch error:', error)
    return jsonResponse({ error: 'Failed to fetch repositories' }, 500)
  }
})

// ============ Shared GitHub App JWT Utilities ============

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
  
  while (page <= 10) {
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

function createJsonResponse(corsHeaders: Record<string, string>) {
  return (data: any, status = 200): Response => {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
}
