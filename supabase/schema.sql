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
    est_duration_seconds INT,
    est_distance_miles NUMERIC(5, 2),
    actual_duration_seconds INT,
    actual_distance_miles NUMERIC(5, 2),
    efficiency_score INT,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

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

-- -----------------------------------------------------------------------------
-- 5. ROUTE STOPS (TELEMETRY LOGS)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS route_stops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    route_id UUID REFERENCES routes(id) ON DELETE CASCADE,
    location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
    sequence_order INT NOT NULL,
    package_count INT DEFAULT 1,
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
    IF NEW.status = 'completed' AND NEW.total_stop_seconds IS NOT NULL THEN
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
-- -----------------------------------------------------------------------------

ALTER TABLE locations
    ADD CONSTRAINT chk_locations_lat_range CHECK (latitude BETWEEN -90 AND 90),
    ADD CONSTRAINT chk_locations_lng_range CHECK (longitude BETWEEN -180 AND 180),
    ADD CONSTRAINT chk_locations_type CHECK (location_type IN ('house', 'apartment', 'business', 'locker', 'gated')),
    ADD CONSTRAINT chk_locations_counts_nonnegative CHECK (
        total_deliveries_count >= 0 AND avg_total_stop_seconds >= 0 AND avg_parking_seconds >= 0
    );

ALTER TABLE apartment_profiles
    ADD CONSTRAINT chk_apartment_parking CHECK (parking_difficulty IN ('easy', 'moderate', 'difficult')),
    ADD CONSTRAINT chk_apartment_walking_nonnegative CHECK (avg_walking_seconds >= 0);

ALTER TABLE route_stops
    ADD CONSTRAINT chk_route_stops_status CHECK (status IN ('pending', 'completed', 'skipped', 'failed')),
    ADD CONSTRAINT chk_route_stops_package_count CHECK (package_count >= 1),
    ADD CONSTRAINT chk_route_stops_sequence CHECK (sequence_order >= 0),
    ADD CONSTRAINT chk_route_stops_durations_nonnegative CHECK (
        (driving_seconds IS NULL OR driving_seconds >= 0) AND
        (parking_seconds IS NULL OR parking_seconds >= 0) AND
        (walking_seconds IS NULL OR walking_seconds >= 0) AND
        (total_stop_seconds IS NULL OR total_stop_seconds >= 0)
    );

ALTER TABLE routes
    ADD CONSTRAINT chk_routes_strategy CHECK (strategy_used IN ('fastest', 'least_driving', 'simplest')),
    ADD CONSTRAINT chk_routes_import_method CHECK (import_method IN ('ocr', 'manual', 'api')),
    ADD CONSTRAINT chk_routes_total_stops_positive CHECK (total_stops >= 0),
    ADD CONSTRAINT chk_routes_efficiency_score_range CHECK (
        efficiency_score IS NULL OR efficiency_score BETWEEN 0 AND 100
    );

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- The original schema had no RLS policies, which means (with RLS enabled by
-- default on new Supabase projects) either every table is fully locked down
-- or, if someone disables RLS to "make it work," every driver can read and
-- edit every other driver's routes and stop telemetry. Both are wrong for a
-- multi-tenant driver app. Policies below scope drivers to their own data;
-- locations/apartment_profiles stay shared (crowd-sourced intel) but are
-- writable only by authenticated drivers.
-- -----------------------------------------------------------------------------

ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE apartment_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Drivers can view own profile" ON drivers
    FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Drivers can update own profile" ON drivers
    FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Drivers can insert own profile" ON drivers
    FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "Drivers can view own routes" ON routes
    FOR SELECT USING (auth.uid() = driver_id);
CREATE POLICY "Drivers can insert own routes" ON routes
    FOR INSERT WITH CHECK (auth.uid() = driver_id);
CREATE POLICY "Drivers can update own routes" ON routes
    FOR UPDATE USING (auth.uid() = driver_id);
CREATE POLICY "Drivers can delete own routes" ON routes
    FOR DELETE USING (auth.uid() = driver_id);

CREATE POLICY "Drivers can view own route stops" ON route_stops
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM routes WHERE routes.id = route_stops.route_id AND routes.driver_id = auth.uid())
    );
CREATE POLICY "Drivers can insert own route stops" ON route_stops
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM routes WHERE routes.id = route_stops.route_id AND routes.driver_id = auth.uid())
    );
CREATE POLICY "Drivers can update own route stops" ON route_stops
    FOR UPDATE USING (
        EXISTS (SELECT 1 FROM routes WHERE routes.id = route_stops.route_id AND routes.driver_id = auth.uid())
    );

-- Locations & apartment intel are crowd-sourced across all drivers: anyone
-- authenticated can read and contribute, nobody can delete another driver's
-- contribution.
CREATE POLICY "Authenticated drivers can view locations" ON locations
    FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated drivers can insert locations" ON locations
    FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated drivers can update locations" ON locations
    FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated drivers can view apartment profiles" ON apartment_profiles
    FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated drivers can insert apartment profiles" ON apartment_profiles
    FOR INSERT TO authenticated WITH CHECK (true);
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
