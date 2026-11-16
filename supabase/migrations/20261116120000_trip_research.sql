-- Shared grounded research for one "generate" click.
--
-- A batch fans out one itinerary per theme, and every variant used to read the
-- request, resolve the destination and run the same searches. Only the
-- activities query varies by theme, so research-trip now does the rest once,
-- stores it here, and each generate-itinerary call loads it by id.
--
-- The row is written in stages so a variant can start its own activities
-- query as soon as the destination is known:
--   pending  claimed, nothing done yet
--   reading  request read and destination resolved (`reading` is set)
--   ready    every batch-wide search is back (`research` is set)
--   error    research-trip failed; variants research for themselves
--
-- Kept server-side rather than passed back through the browser: the payload
-- stays off the wire, and a client cannot hand the model text the system
-- prompt treats as factual ground truth. The client only carries the id.

create table if not exists public.trip_research (
  id uuid primary key,
  batch_id uuid,
  status text not null default 'pending'
    check (status in ('pending', 'reading', 'ready', 'error')),
  destinations text[] not null default '{}',
  destination_was_resolved boolean not null default false,
  reading jsonb,
  research jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists trip_research_batch_id_idx
  on public.trip_research (batch_id) where batch_id is not null;

create index if not exists trip_research_created_at_idx
  on public.trip_research (created_at);

alter table public.trip_research enable row level security;

-- No policies: only the edge functions read or write this table, through the
-- service role, which bypasses RLS. anon and authenticated get nothing.
