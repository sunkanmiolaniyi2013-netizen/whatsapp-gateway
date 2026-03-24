-- Run this in your Supabase SQL Editor to upgrade to Phase 3
-- This supports Number Pooling & Sticky Routing

CREATE TABLE public.sticky_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ghl_location_id TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    gateway_phone TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    UNIQUE(ghl_location_id, contact_phone)
);

ALTER TABLE public.sticky_routes ENABLE ROW LEVEL SECURITY;
