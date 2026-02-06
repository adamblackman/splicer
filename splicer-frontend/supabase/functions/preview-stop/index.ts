// Guest mode support v1.0
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

declare const Deno: any;

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
    'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
    'Vary': 'Origin',
  }
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin
  }
  return headers
}

// Check if request is in guest mode
function isGuestMode(req: Request): boolean {
  return req.headers.get('x-guest-mode') === 'true';
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Guest mode bypasses auth - session ID is sufficient for stop
    // (stopping a session you have the ID for is not a security risk)
    const guestMode = isGuestMode(req);
    
    if (!guestMode) {
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
    }

    const { session_id } = await req.json()
    if (!session_id) {
        throw new Error('Missing session_id in body');
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

    const response = await fetch(`${cloudRunUrl}/api/sessions/${session_id}`, {
      method: 'DELETE',
      headers: {
        'X-API-Key': apiKey,
      },
    })

    return new Response(
      JSON.stringify({ ok: response.ok }),
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