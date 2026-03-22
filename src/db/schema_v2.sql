-- Run this in your Supabase SQL Editor to prepare the database for the GHL App (Phase 2)

-- 1. Add GoHighLevel OAuth 2.0 Token fields to the tenants table
ALTER TABLE public.tenants
ADD COLUMN IF NOT EXISTS ghl_access_token TEXT,
ADD COLUMN IF NOT EXISTS ghl_refresh_token TEXT,
ADD COLUMN IF NOT EXISTS ghl_token_expires_at TIMESTAMP;

-- 2. Make the old ghl_api_key optional since OAuth generates temporary tokens dynamically
ALTER TABLE public.tenants
ALTER COLUMN ghl_api_key DROP NOT NULL;

-- 3. In the Marketplace App, GHL gives us an ID for the specific installation. So we can add it:
ALTER TABLE public.tenants
ADD COLUMN IF NOT EXISTS ghl_company_id TEXT;
