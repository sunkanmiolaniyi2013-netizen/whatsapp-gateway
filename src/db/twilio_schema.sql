-- Run this in Supabase SQL Editor
-- Supports MULTIPLE Twilio numbers per GHL location (for load balancing / redundancy)

CREATE TABLE IF NOT EXISTS twilio_tenants (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    business_name TEXT NOT NULL,
    ghl_location_id TEXT NOT NULL,              -- NOT unique: multiple numbers can serve one location
    phone_number TEXT NOT NULL UNIQUE,          -- Each Twilio number can only exist once globally
    ghl_access_token TEXT,
    ghl_refresh_token TEXT,
    ghl_token_expires_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast routing lookups
CREATE INDEX IF NOT EXISTS idx_twilio_tenants_location ON twilio_tenants(ghl_location_id);
CREATE INDEX IF NOT EXISTS idx_twilio_tenants_phone    ON twilio_tenants(phone_number);

-- NOTE: Sticky routes for Twilio reuse the existing 'sticky_routes' table.
-- No extra table needed — gateway_phone simply stores the Twilio number.
-- The sticky_routes table was already created during the Android setup.
