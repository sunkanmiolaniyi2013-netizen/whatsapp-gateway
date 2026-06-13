-- Run this in your Supabase SQL Editor to add WhatsApp Bridge Support
-- It supports multiple WhatsApp numbers per GHL Location (no UNIQUE constraint on ghl_location_id)

CREATE TABLE public.whatsapp_tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name TEXT NOT NULL,
    ghl_location_id TEXT NOT NULL,
    
    -- standard oauth tokens (can inherit from siblings like Twilio does)
    ghl_api_key TEXT,
    ghl_access_token TEXT,
    ghl_refresh_token TEXT,
    ghl_token_expires_at TIMESTAMP WITH TIME ZONE,
    
    whatsapp_phone_number TEXT NOT NULL UNIQUE,
    whatsapp_instance_id TEXT NOT NULL UNIQUE,
    whatsapp_api_key TEXT NOT NULL,
    whatsapp_base_url TEXT NOT NULL,
    
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.whatsapp_tenants ENABLE ROW LEVEL SECURITY;
