/**
 * GitHub App Webhook Edge Function
 * 
 * Receives webhook events from GitHub when:
 * - App is installed/uninstalled
 * - Repository access is modified
 * 
 * Note: This runs BEFORE the callback completes, so installation records
 * may not exist yet. We only handle deletions and repo updates for
 * existing installations.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

declare const Deno: {
  env: {
    get(key: string): string | undefined
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'x-hub-signature-256, x-github-event, x-github-delivery, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  try {
    const webhookSecret = Deno.env.get('GITHUB_APP_WEBHOOK_SECRET')
    if (!webhookSecret) {
      throw new Error('Missing GITHUB_APP_WEBHOOK_SECRET')
    }

    const signature = req.headers.get('x-hub-signature-256')
    const event = req.headers.get('x-github-event')

    if (!signature || !event) {
      return jsonResponse({ error: 'Missing required headers' }, 400)
    }

    const payload = await req.text()
    
    // Verify webhook signature
    if (!await verifySignature(payload, signature, webhookSecret)) {
      console.error('Invalid webhook signature')
      return jsonResponse({ error: 'Invalid signature' }, 401)
    }

    const body = JSON.parse(payload)
    
    // Create admin Supabase client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Handle installation events
    if (event === 'installation') {
      await handleInstallationEvent(body, supabase)
    }

    // Handle repository selection changes
    if (event === 'installation_repositories') {
      await handleRepoChangesEvent(body, supabase)
    }

    return jsonResponse({ received: true })

  } catch (error) {
    console.error('Webhook error:', error)
    return jsonResponse({ error: 'Internal error' }, 500)
  }
})

async function verifySignature(payload: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  const expectedSignature = 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  
  // Constant-time comparison
  if (signature.length !== expectedSignature.length) return false
  let result = 0
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i)
  }
  return result === 0
}

async function handleInstallationEvent(body: any, supabase: any): Promise<void> {
  const { action, installation } = body

  switch (action) {
    case 'created':
      // New installation - callback will handle linking to user
      // Don't create records here as user_id is required
      console.log(`Installation ${installation.id} created for ${installation.account.login}`)
      break
      
    case 'deleted':
      // Remove installation and cascade delete repos
      console.log(`Installation ${installation.id} deleted`)
      const { error } = await supabase
        .from('github_app_installations')
        .delete()
        .eq('installation_id', installation.id)
      
      if (error) console.error('Error deleting installation:', error)
      break
      
    case 'suspend':
      console.log(`Installation ${installation.id} suspended`)
      break
      
    case 'unsuspend':
      console.log(`Installation ${installation.id} unsuspended`)
      break
  }
}

async function handleRepoChangesEvent(body: any, supabase: any): Promise<void> {
  const { installation, repositories_added, repositories_removed } = body

  // Check if installation exists (it may not if callback hasn't completed yet)
  const { data: existingInstall } = await supabase
    .from('github_app_installations')
    .select('installation_id')
    .eq('installation_id', installation.id)
    .single()

  if (!existingInstall) {
    console.log(`Installation ${installation.id} not yet linked, skipping repo update`)
    return
  }

  // Add new repos
  if (repositories_added?.length > 0) {
    const repoRecords = repositories_added.map((repo: any) => ({
      installation_id: installation.id,
      repo_id: repo.id,
      repo_full_name: repo.full_name,
      repo_private: repo.private,
    }))
    
    const { error } = await supabase
      .from('github_app_installation_repos')
      .upsert(repoRecords, { onConflict: 'installation_id,repo_id' })
    
    if (error) console.error('Error adding repos:', error)
  }

  // Remove repos
  if (repositories_removed?.length > 0) {
    const repoIds = repositories_removed.map((repo: any) => repo.id)
    
    const { error } = await supabase
      .from('github_app_installation_repos')
      .delete()
      .eq('installation_id', installation.id)
      .in('repo_id', repoIds)
    
    if (error) console.error('Error removing repos:', error)
  }
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
