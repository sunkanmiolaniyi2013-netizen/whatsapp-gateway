-- Run this in your Supabase SQL Editor to fix the RLS error on the messages table.
-- Error: "new row violates row-level security policy for table messages" (code 42501)
-- 
-- The service_role key SHOULD bypass RLS automatically, but some Supabase
-- configurations require an explicit policy. This adds one for safety.

-- Option A (Recommended): Just disable RLS on messages since it's a server-only table
ALTER TABLE public.messages DISABLE ROW LEVEL SECURITY;

-- Option B (If you want to keep RLS): Create a permissive policy for service role
-- CREATE POLICY "Allow service role full access" ON public.messages
--   FOR ALL
--   USING (true)
--   WITH CHECK (true);
