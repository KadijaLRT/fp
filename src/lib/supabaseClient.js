import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let client = null;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    'Supabase env vars missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local and Vercel dashboard.'
  );
} else {
  client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
}

// Exported as a getter-style function rather than a bare export so callers
// are forced to handle the "not configured" case instead of crashing on
// a null import somewhere deep in a component tree.
export function getSupabase() {
  if (!client) {
    throw new Error('Supabase client is not configured. Check environment variables.');
  }
  return client;
}

export const supabase = client;
