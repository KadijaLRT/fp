import { supabase } from './supabaseClient';

/**
 * Thin wrapper around Supabase auth. Every function returns a consistent
 * { data, error } shape so calling components never have to guess whether
 * they got a thrown exception or a Supabase error object.
 */

function ensureClient() {
  if (!supabase) {
    return { error: new Error('Supabase is not configured. Check your environment variables.') };
  }
  return null;
}

export async function signUpWithEmail(email, password, fullName) {
  const guard = ensureClient();
  if (guard) return { data: null, error: guard.error };

  if (!email || !password) {
    return { data: null, error: new Error('Email and password are required.') };
  }

  try {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        data: { full_name: fullName || null }
      }
    });
    if (error) return { data: null, error };

    // Mirror the driver into our own drivers table. This is the ONLY
    // mechanism that creates that row — there is no server-side trigger
    // backstopping it, and signInWithEmail below does not retry this. If
    // this upsert fails (e.g. a network drop right after signUp succeeds),
    // the auth account exists but the drivers row doesn't, and nothing
    // will create it later — anything scoped by the drivers FK (routes,
    // route_stops) will fail for that account until it's created manually.
    if (data?.user?.id) {
      await supabase.from('drivers').upsert(
        {
          id: data.user.id,
          email: data.user.email,
          full_name: fullName || null
        },
        { onConflict: 'id' }
      );
    }

    return { data, error: null };
  } catch (err) {
    console.error('signUpWithEmail failed:', err);
    return { data: null, error: err };
  }
}

export async function signInWithEmail(email, password) {
  const guard = ensureClient();
  if (guard) return { data: null, error: guard.error };

  if (!email || !password) {
    return { data: null, error: new Error('Email and password are required.') };
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password
    });
    return { data, error: error || null };
  } catch (err) {
    console.error('signInWithEmail failed:', err);
    return { data: null, error: err };
  }
}

export async function signOut() {
  const guard = ensureClient();
  if (guard) return { error: guard.error };

  try {
    const { error } = await supabase.auth.signOut();
    return { error: error || null };
  } catch (err) {
    console.error('signOut failed:', err);
    return { error: err };
  }
}

export async function getCurrentSession() {
  const guard = ensureClient();
  if (guard) return { session: null, error: guard.error };

  try {
    const { data, error } = await supabase.auth.getSession();
    return { session: data?.session || null, error: error || null };
  } catch (err) {
    console.error('getCurrentSession failed:', err);
    return { session: null, error: err };
  }
}

/**
 * Subscribes to auth state changes. Returns an unsubscribe function so
 * callers can clean up in a useEffect return.
 */
export function onAuthStateChange(callback) {
  if (!supabase) {
    console.error('Cannot subscribe to auth changes: Supabase not configured.');
    return () => {};
  }
  const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return () => listener?.subscription?.unsubscribe();
}
