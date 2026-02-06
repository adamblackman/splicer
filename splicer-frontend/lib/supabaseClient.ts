import { createClient } from '@supabase/supabase-js';

// Safely access import.meta.env, preventing crash if env is undefined
const env = (import.meta as any).env || {};

const SUPABASE_URL = env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing Supabase environment variables. ' +
    'Please set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in your .env.local file. ' +
    'See .env.example for reference.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
