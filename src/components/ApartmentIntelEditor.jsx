import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

const PARKING_OPTIONS = ['easy', 'moderate', 'difficult'];

/**
 * Lets a driver record or edit building-level intel (gate codes, package
 * room location, elevator access) for a stop's location. Saves to
 * apartment_profiles, upserting on location_id so re-editing the same
 * building updates rather than duplicates.
 */
export default function ApartmentIntelEditor({ locationId, onClose, onSaved }) {
  const [form, setForm] = useState({
    complex_name: '',
    gate_code: '',
    package_room_location: '',
    has_elevator: false,
    parking_difficulty: 'moderate',
    avg_walking_seconds: '',
    driver_notes: ''
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [existingId, setExistingId] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadExisting() {
      if (!supabase || !locationId) {
        setLoading(false);
        return;
      }
      try {
        const { data, error: fetchError } = await supabase
          .from('apartment_profiles')
          .select('*')
          .eq('location_id', locationId)
          .maybeSingle();

        if (cancelled) return;

        if (fetchError) {
          console.error('Failed to load apartment profile:', fetchError);
          setError('Could not load existing building info.');
        } else if (data) {
          setExistingId(data.id);
          setForm({
            complex_name: data.complex_name || '',
            gate_code: data.gate_code || '',
            package_room_location: data.package_room_location || '',
            has_elevator: !!data.has_elevator,
            parking_difficulty: data.parking_difficulty || 'moderate',
            avg_walking_seconds: data.avg_walking_seconds ?? '',
            driver_notes: data.driver_notes || ''
          });
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Unexpected error loading apartment profile:', err);
          setError('Could not load existing building info.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadExisting();
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  const updateField = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    if (!supabase) {
      setError('Database is not configured.');
      return;
    }
    if (!locationId) {
      setError('Missing location reference — cannot save.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const payload = {
        location_id: locationId,
        complex_name: form.complex_name.trim() || null,
        gate_code: form.gate_code.trim() || null,
        package_room_location: form.package_room_location.trim() || null,
        has_elevator: !!form.has_elevator,
        parking_difficulty: PARKING_OPTIONS.includes(form.parking_difficulty)
          ? form.parking_difficulty
          : 'moderate',
        avg_walking_seconds:
          form.avg_walking_seconds === '' ? null : Math.max(0, Math.floor(Number(form.avg_walking_seconds) || 0)),
        driver_notes: form.driver_notes.trim() || null,
        updated_at: new Date().toISOString()
      };
      if (existingId) payload.id = existingId;

      const { data, error: saveError } = await supabase
        .from('apartment_profiles')
        .upsert(payload, { onConflict: existingId ? 'id' : 'location_id' })
        .select()
        .single();

      if (saveError) throw saveError;

      onSaved?.(data);
      onClose?.();
    } catch (err) {
      console.error('Failed to save apartment profile:', err);
      setError(err.message || 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold text-gray-900">🏢 Building Intel</h2>
          <button
            onClick={onClose}
            className="text-gray-400 text-2xl leading-none px-2 min-h-[48px] min-w-[48px]"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 text-center py-8">Loading…</p>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-gray-600 block mb-1">Complex name</label>
              <input
                type="text"
                value={form.complex_name}
                onChange={(e) => updateField('complex_name', e.target.value)}
                className="w-full h-12 px-3 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. Riverside Commons"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-600 block mb-1">Gate code</label>
              <input
                type="text"
                value={form.gate_code}
                onChange={(e) => updateField('gate_code', e.target.value)}
                className="w-full h-12 px-3 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. #4821"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-600 block mb-1">Package room location</label>
              <input
                type="text"
                value={form.package_room_location}
                onChange={(e) => updateField('package_room_location', e.target.value)}
                className="w-full h-12 px-3 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. Behind leasing office, bldg C"
              />
            </div>

            <div className="flex items-center justify-between py-1">
              <label className="text-xs font-semibold text-gray-600">Has elevator</label>
              <button
                type="button"
                onClick={() => updateField('has_elevator', !form.has_elevator)}
                className={`w-14 h-8 rounded-full transition-colors relative ${
                  form.has_elevator ? 'bg-emerald-500' : 'bg-gray-300'
                }`}
                aria-pressed={form.has_elevator}
              >
                <span
                  className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                    form.has_elevator ? 'translate-x-7' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-600 block mb-1">Parking difficulty</label>
              <div className="grid grid-cols-3 gap-2">
                {PARKING_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => updateField('parking_difficulty', opt)}
                    className={`py-2.5 rounded-xl text-xs font-semibold capitalize border min-h-[48px] ${
                      form.parking_difficulty === opt
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-300'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-600 block mb-1">Avg walking time (seconds)</label>
              <input
                type="number"
                min="0"
                value={form.avg_walking_seconds}
                onChange={(e) => updateField('avg_walking_seconds', e.target.value)}
                className="w-full h-12 px-3 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. 90"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-600 block mb-1">Driver notes</label>
              <textarea
                value={form.driver_notes}
                onChange={(e) => updateField('driver_notes', e.target.value)}
                rows={3}
                className="w-full px-3 py-2 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. Dog on premises, use side entrance after 6pm"
              />
            </div>

            {error && (
              <p role="alert" className="text-xs text-red-500 font-semibold text-center">{error}</p>
            )}

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-bold text-sm active:scale-98 transition-all mt-2"
            >
              {saving ? 'Saving…' : 'Save Building Intel'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
