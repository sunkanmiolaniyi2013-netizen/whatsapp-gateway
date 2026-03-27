-- Run this in your Supabase SQL Editor to upgrade to Phase 5 (Dual-SIM)

-- 1. Add the new SIM Number tracking column
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS sim_number INTEGER DEFAULT 1;

-- 2. CRUCIAL FIX FOR NUMBER POOLING (PHASE 3):
-- Originally, `ghl_location_id` was unique. We MUST drop this constraint 
-- so you can add multiple phones to the SAME Location ID!
ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_ghl_location_id_key;
