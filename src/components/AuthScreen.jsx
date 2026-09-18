import React, { useState } from 'react';
import { signInWithEmail, signUpWithEmail } from '../lib/auth';

export default function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    try {
      const result =
        mode === 'signup'
          ? await signUpWithEmail(email, password, fullName)
          : await signInWithEmail(email, password);

      if (result.error) {
        setError(result.error.message || 'Authentication failed. Please try again.');
        return;
      }

      if (mode === 'signup' && !result.data?.session) {
        setError('Account created. Check your email to confirm before signing in.');
        return;
      }

      onAuthenticated?.(result.data?.session ?? null);
    } catch (err) {
      console.error('Auth submit failed:', err);
      setError('Something went wrong. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-neutral-900 rounded-2xl shadow-lg border border-neutral-800 p-6">
        <h1 className="text-xl font-extrabold text-amber-400 text-center mb-1">
          ⚡ FLEX ROUTE OPTIMIZER
        </h1>
        <p className="text-xs text-neutral-500 text-center mb-6">
          {mode === 'signin' ? 'Sign in to your driver account' : 'Create your driver account'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === 'signup' && (
            <input
              type="text"
              placeholder="Full name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full h-12 px-4 rounded-xl bg-neutral-950 border border-neutral-800 text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              autoComplete="name"
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full h-12 px-4 rounded-xl bg-neutral-950 border border-neutral-800 text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
            autoComplete="email"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full h-12 px-4 rounded-xl bg-neutral-950 border border-neutral-800 text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            required
          />

          {error && (
            <p className="text-xs text-red-400 font-semibold text-center">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-12 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:bg-neutral-700 text-neutral-950 font-bold text-sm active:scale-98 transition-all"
          >
            {loading ? 'Please wait…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <button
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setError(null);
          }}
          className="w-full text-xs text-neutral-500 mt-4 text-center underline"
        >
          {mode === 'signin' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}
