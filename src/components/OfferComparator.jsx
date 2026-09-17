import React, { useState, useMemo, useEffect } from 'react';
import { computeRatePerHour, getRateColorClass, formatRate } from '../utils/payRate';
import { getPreferredStations, addPreferredStation, removePreferredStation } from '../lib/preferredStations';
import { getStandingDeadline, setStandingDeadline } from '../lib/driverDeadline';
import { parseDeadlineToday, assessDeadlineStatus } from '../utils/deadlineProjection';

// Seeded once, only if the driver has never set any preferred stations —
// never overwrites a list they've already customized.
const DEFAULT_STATIONS = ['Windsor', 'Windsor SSD', 'South Windsor', 'Whole Foods Avon'];

const DEADLINE_STATUS_STYLES = {
  comfortable: 'bg-emerald-950/60 text-emerald-300',
  tight: 'bg-amber-950/60 text-amber-300',
  late: 'bg-red-950/60 text-red-300'
};
const DEADLINE_STATUS_LABELS = {
  comfortable: (t) => `✅ done ${t}`,
  tight: (t) => `⚠️ tight — done ${t}`,
  late: (t) => `❌ finishes ${t}, after deadline`
};

/**
 * Lets a driver quickly compare multiple Flex offers by $/hr instead of
 * eyeballing "$121 for 3.5hr" vs "$57.50 for 2.5hr" under time pressure.
 * This is pure arithmetic on numbers Amazon's own Offers screen already
 * displays — pay, duration, and the offer's start time are all shown right
 * there before you accept. Nothing here reads from, polls, or interacts
 * with Amazon's systems in any way; it's a calculator, not automation.
 */

function emptyOffer(id) {
  return { id, label: '', pay: '', durationHours: '', durationMinutes: '', startTime: '' };
}

let nextId = 1;

export default function OfferComparator({ onClose }) {
  const [offers, setOffers] = useState([emptyOffer(0), emptyOffer(1)]);
  const [stations, setStations] = useState(() => {
    const existing = getPreferredStations();
    return existing.length > 0 ? existing : DEFAULT_STATIONS;
  });
  const [editingStations, setEditingStations] = useState(false);
  const [newStationInput, setNewStationInput] = useState('');
  const [deadline, setDeadline] = useState(() => getStandingDeadline() || '');

  // Seed storage with the defaults on first-ever use so they persist —
  // getPreferredStations() itself never writes, only reads.
  useEffect(() => {
    if (getPreferredStations().length === 0) {
      DEFAULT_STATIONS.forEach((s) => addPreferredStation(s));
    }
  }, []);

  const handleDeadlineChange = (value) => {
    setDeadline(value);
    setStandingDeadline(value || null);
  };

  const fillNextLabel = (stationName) => {
    setOffers((prev) => {
      const emptyIdx = prev.findIndex((o) => !o.label.trim());
      if (emptyIdx >= 0) {
        return prev.map((o, i) => (i === emptyIdx ? { ...o, label: stationName } : o));
      }
      // No empty slot — add a new offer row pre-filled with this station.
      return [...prev, { ...emptyOffer(nextId++), label: stationName }];
    });
  };

  const handleAddStation = () => {
    const trimmed = newStationInput.trim();
    if (!trimmed) return;
    const updated = addPreferredStation(trimmed);
    setStations(updated);
    setNewStationInput('');
  };

  const handleRemoveStation = (station) => {
    const updated = removePreferredStation(station);
    setStations(updated);
  };

  const updateOffer = (id, field, value) => {
    setOffers((prev) => prev.map((o) => (o.id === id ? { ...o, [field]: value } : o)));
  };

  const addOffer = () => {
    setOffers((prev) => [...prev, emptyOffer(nextId++)]);
  };

  const removeOffer = (id) => {
    setOffers((prev) => (prev.length <= 1 ? prev : prev.filter((o) => o.id !== id)));
  };

  const rated = useMemo(() => {
    const deadlineMs = deadline ? parseDeadlineToday(deadline) : null;

    const withRates = offers.map((o) => {
      const pay = Number(o.pay);
      const hours = Number(o.durationHours) || 0;
      const minutes = Number(o.durationMinutes) || 0;
      const totalMinutes = hours * 60 + minutes;
      const rate = Number.isFinite(pay) && pay > 0 && totalMinutes > 0 ? computeRatePerHour(pay, totalMinutes) : null;

      let deadlineStatus = null;
      let finishTimeLabel = null;
      if (deadlineMs !== null && totalMinutes > 0 && o.startTime) {
        const startMs = parseDeadlineToday(o.startTime);
        if (startMs !== null) {
          const finishMs = startMs + totalMinutes * 60 * 1000;
          deadlineStatus = assessDeadlineStatus(finishMs, deadlineMs);
          finishTimeLabel = new Date(finishMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        }
      }

      return { ...o, rate, deadlineStatus, finishTimeLabel };
    });
    const bestRate = Math.max(...withRates.filter((o) => o.rate !== null).map((o) => o.rate), -Infinity);
    return withRates.map((o) => ({ ...o, isBest: o.rate !== null && o.rate === bestRate && bestRate > -Infinity }));
  }, [offers, deadline]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50">
      <div className="bg-slate-800 w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-1">
          <h2 className="text-lg font-bold text-slate-50">📊 Compare Offers</h2>
          <button onClick={onClose} className="text-slate-400 text-2xl leading-none px-2 min-h-[48px] min-w-[48px]" aria-label="Close">
            ×
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-4">
          Enter the pay and duration shown on each offer to see the real $/hr.
        </p>

        <div className="mb-4">
          <p className="text-[11px] font-semibold text-slate-500 uppercase mb-1.5">Need to be done by</p>
          <input
            type="time"
            value={deadline}
            onChange={(e) => handleDeadlineChange(e.target.value)}
            className="w-full h-11 px-3 rounded-lg bg-slate-900 border border-slate-600 text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Add a start time to each offer below to check if it'd get you done in time.
          </p>
        </div>

        <div className="mb-4">
          <div className="flex justify-between items-center mb-1.5">
            <p className="text-[11px] font-semibold text-slate-500 uppercase">Your stations</p>
            <button
              onClick={() => setEditingStations((prev) => !prev)}
              className="text-[11px] text-slate-400 underline"
            >
              {editingStations ? 'Done' : 'Edit'}
            </button>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {stations.map((station) => (
              <button
                key={station}
                onClick={() => (editingStations ? handleRemoveStation(station) : fillNextLabel(station))}
                className={`text-xs font-semibold px-2.5 py-1.5 rounded-md min-h-[32px] ${
                  editingStations ? 'bg-red-950/60 text-red-300' : 'bg-slate-700 text-slate-300'
                }`}
              >
                {editingStations ? `✕ ${station}` : station}
              </button>
            ))}
          </div>
          {editingStations && (
            <div className="flex gap-1.5 mt-2">
              <input
                type="text"
                value={newStationInput}
                onChange={(e) => setNewStationInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddStation()}
                placeholder="Add a station"
                className="flex-1 h-9 px-2.5 rounded-lg bg-slate-900 border border-slate-600 text-slate-100 text-xs focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <button
                onClick={handleAddStation}
                className="px-3 rounded-lg bg-amber-500 text-slate-900 text-xs font-bold"
              >
                Add
              </button>
            </div>
          )}
        </div>

        <div className="space-y-3">
          {rated.map((offer, idx) => (
            <div
              key={offer.id}
              className={`rounded-xl border p-3 ${
                offer.isBest ? 'border-emerald-500 bg-emerald-950/30' : 'border-slate-700 bg-slate-900'
              }`}
            >
              <div className="flex justify-between items-center mb-2">
                <input
                  type="text"
                  value={offer.label}
                  onChange={(e) => updateOffer(offer.id, 'label', e.target.value)}
                  placeholder={`Offer ${idx + 1} (e.g. station name)`}
                  className="flex-1 bg-transparent text-slate-200 text-sm font-semibold focus:outline-none"
                />
                {offers.length > 1 && (
                  <button
                    onClick={() => removeOffer(offer.id)}
                    className="text-xs text-red-400 font-semibold px-2 py-1 min-h-[36px]"
                    aria-label={`Remove offer ${idx + 1}`}
                  >
                    Remove
                  </button>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2 mb-1">
                <div className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={offer.pay}
                    onChange={(e) => updateOffer(offer.id, 'pay', e.target.value)}
                    placeholder="Pay"
                    className="w-full h-11 pl-6 pr-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                  />
                </div>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  value={offer.durationHours}
                  onChange={(e) => updateOffer(offer.id, 'durationHours', e.target.value)}
                  placeholder="hr"
                  className="h-11 px-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="59"
                  value={offer.durationMinutes}
                  onChange={(e) => updateOffer(offer.id, 'durationMinutes', e.target.value)}
                  placeholder="min"
                  className="h-11 px-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
              </div>

              <div className="flex items-center gap-2 mb-1">
                <label className="text-[11px] text-slate-500 whitespace-nowrap">Starts</label>
                <input
                  type="time"
                  value={offer.startTime}
                  onChange={(e) => updateOffer(offer.id, 'startTime', e.target.value)}
                  className="flex-1 h-9 px-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-100 text-xs focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
              </div>

              <div className="text-right">
                <span className={`text-base font-bold ${getRateColorClass(offer.rate)}`}>
                  {offer.rate !== null ? formatRate(offer.rate) : '—'}
                </span>
                {offer.isBest && <span className="text-xs text-emerald-400 font-semibold ml-2">★ Best</span>}
              </div>

              {offer.deadlineStatus && (
                <div className={`mt-2 text-xs font-semibold px-2 py-1 rounded-md inline-block ${DEADLINE_STATUS_STYLES[offer.deadlineStatus]}`}>
                  {DEADLINE_STATUS_LABELS[offer.deadlineStatus](offer.finishTimeLabel)}
                </div>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={addOffer}
          className="w-full mt-3 py-3 rounded-xl border-2 border-dashed border-slate-600 text-slate-400 text-sm font-semibold min-h-[48px]"
        >
          + Add another offer
        </button>
      </div>
    </div>
  );
}
