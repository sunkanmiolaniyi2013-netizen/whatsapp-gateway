-- Run this in Supabase SQL Editor
-- Completely separate table from 'tenants' — zero impact on Android gateway

CREATE TABLE IF NOT EXISTS twilio_tenants (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    business_name TEXT NOT NULL,
    ghl_location_id TEXT NOT NULL UNIQUE,
    phone_number TEXT NOT NULL UNIQUE,       -- The Twilio number e.g. +12025551234
    ghl_access_token TEXT,
    ghl_refresh_token TEXT,
    ghl_token_expires_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups during inbound webhook routing
CREATE INDEX IF NOT EXISTS idx_twilio_tenants_location ON twilio_tenants(ghl_location_id);
CREATE INDEX IF NOT EXISTS idx_twilio_tenants_phone    ON twilio_tenants(phone_number);
