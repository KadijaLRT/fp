import React from 'react';

/**
 * Small dismissible popup for one-off route messages (e.g. "Amazon's
 * route is already the best"). Bottom sheet on phones, centered on wider
 * screens, with safe-area padding so the button clears the home bar.
 */
export default function RouteNoticeModal({ title, message, onClose }) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="route-notice-title"
      onClick={onClose}
    >
      <div
        className="bg-neutral-900 border border-neutral-800 w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="route-notice-title" className="text-lg font-bold text-neutral-50 mb-2">
          ✅ {title}
        </h2>
        <p className="text-sm text-neutral-300 mb-5 leading-relaxed">{message}</p>
        <button
          type="button"
          onClick={onClose}
          className="w-full h-12 rounded-xl bg-amber-500 text-neutral-950 font-bold"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
