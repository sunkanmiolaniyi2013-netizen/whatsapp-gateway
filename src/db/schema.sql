-- Run this in your Supabase SQL Editor

-- 1. Create the tenants table
CREATE TABLE public.tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name TEXT NOT NULL,
    ghl_location_id TEXT NOT NULL UNIQUE,
    ghl_api_key TEXT NOT NULL,
    phone_number TEXT NOT NULL UNIQUE,
    gateway_device_id TEXT NOT NULL,
    gateway_api_key TEXT NOT NULL,
    gateway_base_url TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- 2. Create messages table for logging history
CREATE TYPE direction_enum AS ENUM ('outbound', 'inbound');

CREATE TABLE public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES public.tenants(id),
    direction direction_enum NOT NULL,
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    body TEXT NOT NULL,
    ghl_contact_id TEXT,
    ghl_conversation_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- 3. Create logs table for debugging
CREATE TABLE public.logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES public.tenants(id),
    event TEXT NOT NULL,
    payload JSONB,
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- Security Policies (allow all for service role, block public access)
-- Supabase automatically protects tables if RLS is enabled.
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logs ENABLE ROW LEVEL SECURITY;
