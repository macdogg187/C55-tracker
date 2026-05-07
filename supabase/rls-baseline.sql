-- Baseline RLS script for publicly readable data with a publishable key.
-- Run this in Supabase SQL Editor after replacing "public.instruments"
-- with each table your frontend needs to read.

alter table public.instruments enable row level security;

drop policy if exists "public can read instruments" on public.instruments;
create policy "public can read instruments"
on public.instruments
for select
to anon
using (true);
