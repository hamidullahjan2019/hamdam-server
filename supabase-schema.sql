-- Hamdam — Supabase Postgres schema
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- The server (hamdam-server/server.js) reads/writes these tables through
-- PostgREST using the SERVICE ROLE key, so it bypasses Row Level Security.
-- RLS is enabled on every table with NO policies: the anon/authenticated
-- roles get nothing, only the service_role key (server-side only) can read
-- or write. NEVER put the service_role key in the front-end or a public repo.
--
-- Mapping to the app's data model (kept identical to the original JSON file):
--   profiles  -> users.me        (jsonb: name, age, city, job, about, ...)
--   likes     -> users.reacts    (jsonb: { otherUserId: "like"|"pass"|"super" })
--   messages  -> matches.msgs    (jsonb array)
--   wali      -> users.wali_code
--   gold      -> users.gold
--   OTP codes -> Supabase Auth (NOT stored here; Auth sends + verifies them)

create table if not exists users (
  id          bigint primary key,
  contact     text not null unique,
  me          jsonb,
  ver         integer not null default 0,
  gold        boolean not null default false,
  wali_code   text not null default '',
  blocked     jsonb not null default '{}'::jsonb,
  reacts      jsonb not null default '{}'::jsonb,
  hist        jsonb not null default '[]'::jsonb,
  unlocked    jsonb not null default '{}'::jsonb,
  media       jsonb not null default '[]'::jsonb,
  selfie      text,
  seen        bigint not null default 0,
  created_at  bigint not null default 0
);

create table if not exists sessions (
  token       text primary key,
  user_id     bigint not null,
  created_at  bigint not null default 0
);

create table if not exists matches (
  match_key   text primary key,          -- "lowerId-higherId", e.g. '3-7'
  t           bigint not null default 0,
  msgs        jsonb not null default '[]'::jsonb
);

create table if not exists reports (
  id          bigint primary key,
  t           bigint not null default 0,
  by_user     bigint not null,
  about       bigint not null,
  reason      text not null default '',
  context     jsonb not null default '[]'::jsonb,
  status      text not null default 'open'
);

create table if not exists events (
  user_id     bigint primary key,
  events      jsonb not null default '[]'::jsonb
);

-- tiny key/value table for server metadata (currently only the next user id)
create table if not exists kv (
  key         text primary key,
  value       jsonb not null
);

create index if not exists idx_users_contact   on users (contact);
create index if not exists idx_users_wali_code on users (wali_code);
create index if not exists idx_sessions_user   on sessions (user_id);
create index if not exists idx_reports_status  on reports (status);

alter table users    enable row level security;
alter table sessions enable row level security;
alter table matches  enable row level security;
alter table reports  enable row level security;
alter table events   enable row level security;
alter table kv       enable row level security;
-- No policies are created on purpose: only the service_role key (used by the
-- server) bypasses RLS. If the app later needs direct browser access to a
-- table, add a narrow policy for it then — not before.
