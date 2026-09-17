-- Amazon Flex Route Optimizer — Supabase schema
-- Run this in the Supabase SQL editor, or via `supabase db push`.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -----------------------------------------------------------------------------
-- 1. DRIVERS TABLE
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drivers (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(100),
    preferred_map_app VARCHAR(20) DEFAULT 'google',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- CREATE TABLE IF NOT EXISTS is a no-op once the table exists, so any
-- column added to a table's definition in a LATER revision of this file
-- than the one that first created it never actually reaches an existing
-- database — it only exists here in the file. That's exactly what
-- produced "column vehicle_zone does not exist": route_stops was created
-- by an earlier version of this schema, before vehicle_zone was added to
-- its definition, and nothing ever went back and added it to the real
-- table. ADD COLUMN IF NOT EXISTS below converges any existing table
-- (however old) to match the current full definition — a no-op for
-- columns that already exist, and the fix for any that don't. Only
-- nullable columns are listed here; the handful of NOT NULL columns with
-- no DEFAULT (email, total_stops, formatted_address, latitude, longitude,
-- sequence_order) were part of every version of this schema from the
-- start, so they're safe to assume already present — adding a NOT NULL
-- column with no default to a table that may already have rows would
-- itself fail, so those are deliberately left alone here.
ALTER TABLE drivers
    ADD COLUMN IF NOT EXISTS full_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS preferred_map_app VARCHAR(20) DEFAULT 'google',
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- -----------------------------------------------------------------------------
-- 2. ROUTES / BLOCKS TABLE
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE,
    import_method VARCHAR(20) DEFAULT 'ocr',
    total_stops INT NOT NULL,
    total_packages INT DEFAULT 0,
    strategy_used VARCHAR(30) DEFAULT 'fastest',
    -- What this block pays, in cents (avoids float rounding on money).
    -- Manual entry only — Amazon Flex's block-offer screen (where pay is
    -- shown) is a different screen than the itinerary/stop-list screenshot
    -- this app OCRs, so there's no source for this in the parsed image.
    block_pay_cents INT,
    est_duration_seconds INT,
    est_distance_miles NUMERIC(5, 2),
    actual_duration_seconds INT,
    actual_distance_miles NUMERIC(5, 2),
    efficiency_score INT,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE routes
    ADD COLUMN IF NOT EXISTS driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS import_method VARCHAR(20) DEFAULT 'ocr',
    ADD COLUMN IF NOT EXISTS total_packages INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS strategy_used VARCHAR(30) DEFAULT 'fastest',
    ADD COLUMN IF NOT EXISTS block_pay_cents INT,
    ADD COLUMN IF NOT EXISTS est_duration_seconds INT,
    ADD COLUMN IF NOT EXISTS est_distance_miles NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS actual_duration_seconds INT,
    ADD COLUMN IF NOT EXISTS actual_distance_miles NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS efficiency_score INT,
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- -----------------------------------------------------------------------------
-- 3. LOCATIONS (shared address intelligence across all drivers)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    formatted_address TEXT UNIQUE NOT NULL,
    latitude NUMERIC(10, 8) NOT NULL,
    longitude NUMERIC(11, 8) NOT NULL,
    location_type VARCHAR(30) DEFAULT 'house',
    total_deliveries_count INT DEFAULT 0,
    avg_total_stop_seconds INT DEFAULT 0,
    avg_parking_seconds INT DEFAULT 0,
    is_known_slow_stop BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE locations
    ADD COLUMN IF NOT EXISTS location_type VARCHAR(30) DEFAULT 'house',
    ADD COLUMN IF NOT EXISTS total_deliveries_count INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS avg_total_stop_seconds INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS avg_parking_seconds INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_known_slow_stop BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_locations_coords ON locations(latitude, longitude);

-- -----------------------------------------------------------------------------
-- 4. APARTMENT INTELLIGENCE
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS apartment_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    location_id UUID UNIQUE REFERENCES locations(id) ON DELETE CASCADE,
    complex_name VARCHAR(150),
    gate_code VARCHAR(50),
    package_room_location TEXT,
    has_elevator BOOLEAN DEFAULT FALSE,
    parking_difficulty VARCHAR(20) DEFAULT 'moderate',
    avg_walking_seconds INT DEFAULT 0,
    driver_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE apartment_profiles
    ADD COLUMN IF NOT EXISTS location_id UUID UNIQUE REFERENCES locations(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS complex_name VARCHAR(150),
    ADD COLUMN IF NOT EXISTS gate_code VARCHAR(50),
    ADD COLUMN IF NOT EXISTS package_room_location TEXT,
    ADD COLUMN IF NOT EXISTS has_elevator BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS parking_difficulty VARCHAR(20) DEFAULT 'moderate',
    ADD COLUMN IF NOT EXISTS avg_walking_seconds INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS driver_notes TEXT,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- -----------------------------------------------------------------------------
-- 5. ROUTE STOPS (TELEMETRY LOGS)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS route_stops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    route_id UUID REFERENCES routes(id) ON DELETE CASCADE,
    location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
    sequence_order INT NOT NULL,
    package_count INT DEFAULT 1,
    -- Where in the vehicle this stop's package(s) were loaded. Flex
    -- itinerary screenshots have no source for this (it's not something
    -- OCR can extract), so it's set manually by the driver at pack-time —
    -- see ActiveStopCard's zone chips / src/lib/routes.js updateVehicleZone.
    vehicle_zone VARCHAR(30),
    delivery_window_start TIMESTAMP WITH TIME ZONE,
    delivery_window_end TIMESTAMP WITH TIME ZONE,
    approach_time TIMESTAMP WITH TIME ZONE,
    arrival_time TIMESTAMP WITH TIME ZONE,
    delivery_time TIMESTAMP WITH TIME ZONE,
    driving_seconds INT,
    parking_seconds INT,
    walking_seconds INT,
    total_stop_seconds INT,
    status VARCHAR(20) DEFAULT 'pending',
    failure_reason VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE route_stops
    ADD COLUMN IF NOT EXISTS route_id UUID REFERENCES routes(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS package_count INT DEFAULT 1,
    ADD COLUMN IF NOT EXISTS vehicle_zone VARCHAR(30),
    ADD COLUMN IF NOT EXISTS delivery_window_start TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS delivery_window_end TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS approach_time TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS arrival_time TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS delivery_time TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS driving_seconds INT,
    ADD COLUMN IF NOT EXISTS parking_seconds INT,
    ADD COLUMN IF NOT EXISTS walking_seconds INT,
    ADD COLUMN IF NOT EXISTS total_stop_seconds INT,
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS failure_reason VARCHAR(50),
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_route_stops_location ON route_stops(location_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops(route_id);

-- -----------------------------------------------------------------------------
-- AUTO-LEARNING TRIGGER
-- Declared SECURITY DEFINER (see the column-privilege block further down)
-- so it can still write locations' aggregate columns after we revoke direct
-- UPDATE access to those columns from the `authenticated` role.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_location_intelligence()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Guard against double-counting: this trigger fires on every UPDATE to
    -- route_stops, not just the moment a stop first becomes completed. The
    -- original condition only checked NEW.status, so if finalizeRouteStop()
    -- is ever called twice for the same row with status='completed' — a
    -- double-tapped DELIVERED button, or the offline-write-queue replaying
    -- a write that had actually already succeeded — this would fire again
    -- and silently double-count that delivery into the location's learned
    -- average. Comparing against OLD.status ensures the aggregate only
    -- updates on a genuine transition into 'completed', making repeated
    -- updates to an already-completed row a no-op here.
    IF NEW.status = 'completed' AND NEW.total_stop_seconds IS NOT NULL
       AND (OLD.status IS DISTINCT FROM 'completed') THEN
        UPDATE locations
        SET
            avg_total_stop_seconds = (
                (avg_total_stop_seconds * total_deliveries_count) + NEW.total_stop_seconds
            ) / (total_deliveries_count + 1),
            is_known_slow_stop = (
                ((avg_total_stop_seconds * total_deliveries_count) + NEW.total_stop_seconds)
                / (total_deliveries_count + 1)
            ) > 300,
            total_deliveries_count = total_deliveries_count + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.location_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_location_intelligence ON route_stops;
CREATE TRIGGER trigger_update_location_intelligence
AFTER UPDATE ON route_stops
FOR EACH ROW
EXECUTE FUNCTION update_location_intelligence();

-- -----------------------------------------------------------------------------
-- DATA INTEGRITY CHECK CONSTRAINTS
-- The original schema had no validation beyond DEFAULT values, so a bug (or
-- a driver poking the Supabase client directly) could insert
-- parking_difficulty: 'lol' or latitude: 400. Constrain the enum-like text
-- columns and obviously-bounded numerics at the database layer, since RLS
-- controls *who* can write but not *what* they write.
--
-- Postgres has no "ADD CONSTRAINT IF NOT EXISTS" — re-running this file
-- against a database that already has these constraints previously errored
-- with "constraint already exists" (42710) and stopped partway through the
-- script, since the SQL editor runs statements in order and a failure mid-
-- script leaves everything after it un-applied. Each ADD CONSTRAINT is now
-- preceded by a DROP CONSTRAINT IF EXISTS for the same name, making the
-- whole file safe to re-run any number of times — first run or fiftieth.
-- -----------------------------------------------------------------------------

ALTER TABLE locations
    DROP CONSTRAINT IF EXISTS chk_locations_lat_range,
    ADD CONSTRAINT chk_locations_lat_range CHECK (latitude BETWEEN -90 AND 90),
    DROP CONSTRAINT IF EXISTS chk_locations_lng_range,
    ADD CONSTRAINT chk_locations_lng_range CHECK (longitude BETWEEN -180 AND 180),
    DROP CONSTRAINT IF EXISTS chk_locations_type,
    ADD CONSTRAINT chk_locations_type CHECK (location_type IN ('house', 'apartment', 'business', 'locker', 'gated')),
    DROP CONSTRAINT IF EXISTS chk_locations_counts_nonnegative,
    ADD CONSTRAINT chk_locations_counts_nonnegative CHECK (
        total_deliveries_count >= 0 AND avg_total_stop_seconds >= 0 AND avg_parking_seconds >= 0
    );

ALTER TABLE apartment_profiles
    DROP CONSTRAINT IF EXISTS chk_apartment_parking,
    ADD CONSTRAINT chk_apartment_parking CHECK (parking_difficulty IN ('easy', 'moderate', 'difficult')),
    DROP CONSTRAINT IF EXISTS chk_apartment_walking_nonnegative,
    ADD CONSTRAINT chk_apartment_walking_nonnegative CHECK (avg_walking_seconds >= 0);

ALTER TABLE route_stops
    DROP CONSTRAINT IF EXISTS chk_route_stops_status,
    ADD CONSTRAINT chk_route_stops_status CHECK (status IN ('pending', 'completed', 'skipped', 'failed')),
    DROP CONSTRAINT IF EXISTS chk_route_stops_package_count,
    ADD CONSTRAINT chk_route_stops_package_count CHECK (package_count >= 1),
    DROP CONSTRAINT IF EXISTS chk_route_stops_sequence,
    ADD CONSTRAINT chk_route_stops_sequence CHECK (sequence_order >= 0),
    DROP CONSTRAINT IF EXISTS chk_route_stops_vehicle_zone,
    ADD CONSTRAINT chk_route_stops_vehicle_zone CHECK (
        vehicle_zone IS NULL OR vehicle_zone IN (
            'front_seat', 'driver_rear', 'passenger_rear', 'trunk_left', 'trunk_right', 'trunk_center'
        )
    ),
    DROP CONSTRAINT IF EXISTS chk_route_stops_durations_nonnegative,
    ADD CONSTRAINT chk_route_stops_durations_nonnegative CHECK (
        (driving_seconds IS NULL OR driving_seconds >= 0) AND
        (parking_seconds IS NULL OR parking_seconds >= 0) AND
        (walking_seconds IS NULL OR walking_seconds >= 0) AND
        (total_stop_seconds IS NULL OR total_stop_seconds >= 0)
    );

ALTER TABLE routes
    DROP CONSTRAINT IF EXISTS chk_routes_strategy,
    ADD CONSTRAINT chk_routes_strategy CHECK (strategy_used IN ('fastest', 'least_driving', 'simplest')),
    DROP CONSTRAINT IF EXISTS chk_routes_import_method,
    ADD CONSTRAINT chk_routes_import_method CHECK (import_method IN ('ocr', 'manual', 'api')),
    DROP CONSTRAINT IF EXISTS chk_routes_total_stops_positive,
    ADD CONSTRAINT chk_routes_total_stops_positive CHECK (total_stops >= 0),
    DROP CONSTRAINT IF EXISTS chk_routes_efficiency_score_range,
    ADD CONSTRAINT chk_routes_efficiency_score_range CHECK (
        efficiency_score IS NULL OR efficiency_score BETWEEN 0 AND 100
    ),
    DROP CONSTRAINT IF EXISTS chk_routes_block_pay_nonnegative,
    ADD CONSTRAINT chk_routes_block_pay_nonnegative CHECK (block_pay_cents IS NULL OR block_pay_cents >= 0);

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- The original schema had no RLS policies, which means (with RLS enabled by
-- default on new Supabase projects) either every table is fully locked down
-- or, if someone disables RLS to "make it work," every driver can read and
-- edit every other driver's routes and stop telemetry. Both are wrong for a
-- multi-tenant driver app. Policies below scope drivers to their own data;
-- locations/apartment_profiles stay shared (crowd-sourced intel) but are
-- writable only by authenticated drivers.
--
-- Like ADD CONSTRAINT above, CREATE POLICY has no IF NOT EXISTS in Postgres
-- — each is preceded by DROP POLICY IF EXISTS so this file stays safe to
-- re-run. ENABLE ROW LEVEL SECURITY is already idempotent on its own (no
-- error re-enabling it), so those four lines don't need the same treatment.
-- -----------------------------------------------------------------------------

ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE apartment_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Drivers can view own profile" ON drivers;
CREATE POLICY "Drivers can view own profile" ON drivers
    FOR SELECT USING (auth.uid() = id);
DROP POLICY IF EXISTS "Drivers can update own profile" ON drivers;
CREATE POLICY "Drivers can update own profile" ON drivers
    FOR UPDATE USING (auth.uid() = id);
DROP POLICY IF EXISTS "Drivers can insert own profile" ON drivers;
CREATE POLICY "Drivers can insert own profile" ON drivers
    FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Drivers can view own routes" ON routes;
CREATE POLICY "Drivers can view own routes" ON routes
    FOR SELECT USING (auth.uid() = driver_id);
DROP POLICY IF EXISTS "Drivers can insert own routes" ON routes;
CREATE POLICY "Drivers can insert own routes" ON routes
    FOR INSERT WITH CHECK (auth.uid() = driver_id);
DROP POLICY IF EXISTS "Drivers can update own routes" ON routes;
CREATE POLICY "Drivers can update own routes" ON routes
    FOR UPDATE USING (auth.uid() = driver_id);
DROP POLICY IF EXISTS "Drivers can delete own routes" ON routes;
CREATE POLICY "Drivers can delete own routes" ON routes
    FOR DELETE USING (auth.uid() = driver_id);

DROP POLICY IF EXISTS "Drivers can view own route stops" ON route_stops;
CREATE POLICY "Drivers can view own route stops" ON route_stops
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM routes WHERE routes.id = route_stops.route_id AND routes.driver_id = auth.uid())
    );
DROP POLICY IF EXISTS "Drivers can insert own route stops" ON route_stops;
CREATE POLICY "Drivers can insert own route stops" ON route_stops
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM routes WHERE routes.id = route_stops.route_id AND routes.driver_id = auth.uid())
    );
DROP POLICY IF EXISTS "Drivers can update own route stops" ON route_stops;
CREATE POLICY "Drivers can update own route stops" ON route_stops
    FOR UPDATE USING (
        EXISTS (SELECT 1 FROM routes WHERE routes.id = route_stops.route_id AND routes.driver_id = auth.uid())
    );

-- Locations & apartment intel are crowd-sourced across all drivers: anyone
-- authenticated can read and contribute, nobody can delete another driver's
-- contribution.
DROP POLICY IF EXISTS "Authenticated drivers can view locations" ON locations;
CREATE POLICY "Authenticated drivers can view locations" ON locations
    FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated drivers can insert locations" ON locations;
CREATE POLICY "Authenticated drivers can insert locations" ON locations
    FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "Authenticated drivers can update locations" ON locations;
CREATE POLICY "Authenticated drivers can update locations" ON locations
    FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated drivers can view apartment profiles" ON apartment_profiles;
CREATE POLICY "Authenticated drivers can view apartment profiles" ON apartment_profiles
    FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated drivers can insert apartment profiles" ON apartment_profiles;
CREATE POLICY "Authenticated drivers can insert apartment profiles" ON apartment_profiles
    FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "Authenticated drivers can update apartment profiles" ON apartment_profiles;
CREATE POLICY "Authenticated drivers can update apartment profiles" ON apartment_profiles
    FOR UPDATE TO authenticated USING (true);

-- -----------------------------------------------------------------------------
-- COLUMN-LEVEL PRIVILEGES: protect trigger-owned aggregate columns
-- RLS policies control *which rows* a role can touch, not *which columns*.
-- The "Authenticated drivers can update locations" policy above is needed
-- so drivers can fix a bad address/lat/lng — but as written it also lets
-- any authenticated driver's client directly overwrite
-- avg_total_stop_seconds / total_deliveries_count / is_known_slow_stop,
-- which are supposed to be derived exclusively from completed deliveries
-- via update_location_intelligence(). A single bad `.update()` call from
-- the app (or a malicious client hitting the Supabase REST API directly)
-- could otherwise corrupt every driver's learned data for a location.
--
-- Fix: revoke UPDATE on those specific columns from `authenticated`, then
-- re-grant UPDATE only on the columns a driver should legitimately be able
-- to edit. The trigger function is declared SECURITY DEFINER (owned by the
-- table owner) so it can still write the protected columns despite the
-- revoke — application code cannot.
-- -----------------------------------------------------------------------------

REVOKE UPDATE ON locations FROM authenticated;
GRANT UPDATE (formatted_address, latitude, longitude, location_type, updated_at)
    ON locations TO authenticated;
