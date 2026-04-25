// api/_lib/supabase-admin.js
// Server-side Supabase client using the service role key.
// NEVER expose this to the browser — service role bypasses RLS.
//
// Use this for:
//   - Creating/updating user profiles after Stripe webhooks
//   - Reading subscription state during API authorization
//   - Server-side queries that need to bypass RLS (subscription_events log, etc.)
//
// For user-context queries (fetching their own bet history, etc.), use the
// per-request anon client built from their JWT instead.

import { createClient } from '@supabase/supabase-js';

let _adminClient = null;

export function getSupabaseAdmin() {
  if (_adminClient) return _adminClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars must be set. ' +
      'Get them from Supabase Dashboard → Settings → API.'
    );
  }

  _adminClient = createClient(url, serviceRoleKey, {
    auth: {
      // Don't persist sessions on the server side
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _adminClient;
}

/**
 * Build an anon client that runs as the user identified by the given JWT.
 * Used when an endpoint needs RLS-aware queries (e.g. fetching the user's own bets).
 */
export function getSupabaseAnonForUser(jwt) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY required for user-context client');
  }
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
