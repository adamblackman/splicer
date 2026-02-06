/**
 * Generate Title Edge Function
 * 
 * Takes user input and generates a concise 3-5 word title using Gemini 2.0 Flash Lite.
 * Updates the thread's title in Supabase.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin
  }
  return headers
}

interface GenerateTitleRequest {
  thread_id: string
  user_input: string
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
      }>
    }
  }>
  error?: {
    message: string
  }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  const jsonResponse = createJsonResponse(corsHeaders)
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Only allow POST
    if (req.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405)
    }

    // Create Supabase client with user's auth token
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    )

    // Validate JWT
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return jsonResponse({ error: 'Unauthorized' }, 401)
    }

    // Parse request body
    const body: GenerateTitleRequest = await req.json()
    const { thread_id, user_input } = body

    if (!thread_id || !user_input) {
      return jsonResponse({ error: 'Missing thread_id or user_input' }, 400)
    }

    // Verify thread belongs to user
    const { data: thread, error: threadError } = await supabase
      .from('threads')
      .select('id, user_id')
      .eq('id', thread_id)
      .single()

    if (threadError || !thread) {
      return jsonResponse({ error: 'Thread not found' }, 404)
    }

    if (thread.user_id !== user.id) {
      return jsonResponse({ error: 'Unauthorized' }, 403)
    }

    // Get Google API key
    const googleApiKey = Deno.env.get('GOOGLE_API_KEY')
    if (!googleApiKey) {
      throw new Error('Missing GOOGLE_API_KEY secret')
    }

    // Generate title using Gemini 2.0 Flash Lite
    const title = await generateTitle(googleApiKey, user_input)

    // Update thread with generated title
    const { error: updateError } = await supabase
      .from('threads')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', thread_id)

    if (updateError) {
      console.error('Failed to update thread title:', updateError)
      return jsonResponse({ error: 'Failed to update thread title' }, 500)
    }

    return jsonResponse({ title, thread_id })

  } catch (error) {
    console.error('Generate title error:', error)
    return jsonResponse({ 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }, 500)
  }
})

/**
 * Sleep helper for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Generate a concise 3-5 word title using Gemini 2.0 Flash Lite
 * Includes retry logic with exponential backoff for rate limiting
 */
async function generateTitle(apiKey: string, userInput: string): Promise<string> {
  const maxRetries = 3
  const baseDelay = 1000 // 1 second
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Generate a concise 3-5 word title summarizing this user request. Return ONLY the title, no quotes, no punctuation at the end, no explanation.

User request: "${userInput}"

Title:`
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 20,
            topP: 0.8,
          }
        })
      }
    )

    // Handle rate limiting with retry
    if (response.status === 429) {
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) // Exponential backoff: 1s, 2s, 4s
        console.log(`Rate limited (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`)
        await sleep(delay)
        continue
      }
      // All retries exhausted - return fallback title instead of failing
      console.error('Rate limit persists after retries, using fallback title')
      return generateFallbackTitle(userInput)
    }

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Gemini API error:', errorText)
      throw new Error('Failed to generate title')
    }

    const data: GeminiResponse = await response.json()
    
    if (data.error) {
      throw new Error(data.error.message)
    }

    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    
    if (!generatedText) {
      throw new Error('No title generated')
    }

    // Clean up the title - remove quotes and trailing punctuation
    return generatedText
      .replace(/^["']|["']$/g, '')
      .replace(/[.!?]$/, '')
      .trim()
  }
  
  // Should not reach here, but fallback just in case
  return generateFallbackTitle(userInput)
}

/**
 * Generate a simple fallback title from the user input
 * Used when API rate limits persist
 */
function generateFallbackTitle(userInput: string): string {
  // Take first few words of input, capitalize, truncate
  const words = userInput.trim().split(/\s+/).slice(0, 4)
  if (words.length === 0) {
    return 'New Thread'
  }
  const title = words.join(' ')
  // Capitalize first letter
  return title.charAt(0).toUpperCase() + title.slice(1)
}

function createJsonResponse(corsHeaders: Record<string, string>) {
  return (data: unknown, status = 200): Response => {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
}
