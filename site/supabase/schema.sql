-- Asleepius Tech card book
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It is safe to run again: tables are kept, functions are replaced.
--
-- What this stores
--   accounts        the business on a card. The shop creates it. The customer does not sign up.
--   cards           one physical card. public_code is the id in the link.
--   work_orders     the work already loaded on that card.
--   service_options the choices on the customer page, with prices in cents.
--   requests        a total the customer built, plus the name and contact they entered.
--   request_lines   the options on that request. Prices are copied from service_options.
--   messages        the thread on the card. direction is customer or shop.
--   payment_methods reserved for the payment step. Do not store a full card number here.
--
-- Who can touch it
--   The customer page uses the anon key and only these functions: open_card, send_message, save_request.
--   The shop signs in (Authentication → Users) and can read and write the tables.
--   The service_role key stays off the website.

create extension if not exists pgcrypto;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  business_name text not null check (char_length(business_name) between 1 and 160),
  contact_name text not null default '',
  phone text not null default '',
  email text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  public_code text not null unique check (public_code ~ '^[A-Z0-9-]{4,32}$'),
  ref_no text not null unique check (ref_no ~ '^[A-Z0-9-]{2,32}$'),
  account_id uuid references public.accounts(id),
  client_name text not null default '',
  prepared_for text not null default '',
  card_date text not null default '',
  phone_display text not null default '',
  custom_link text not null default '',
  status text not null default 'new' check (status in ('new', 'printed', 'in_progress', 'loaded')),
  shop_name text not null default 'ASLEEPIUS TECH',
  slogan text not null default 'WE HEAL TECH',
  emergency_label text not null default 'SYSTEM DOWN?',
  emergency_instruction text not null default 'CALL OR TEXT, ANY HOUR:',
  followup_line text not null default 'SCHEDULED CHECK-INS MONTHLY · EMERGENCIES: CALL OR TEXT ANYTIME',
  loaded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.work_orders (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete cascade,
  kind text not null check (kind in ('standard', 'custom')),
  problem text not null check (char_length(problem) between 1 and 240),
  fix text not null default '',
  price_cents integer not null default 0 check (price_cents >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.service_options (
  key text primary key check (key ~ '^[a-z0-9-]{1,40}$'),
  label text not null check (char_length(label) between 1 and 240),
  detail text not null default '',
  price_cents integer not null default 0 check (price_cents >= 0),
  active boolean not null default true,
  sort_order integer not null default 0
);

create table if not exists public.requests (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete cascade,
  account_id uuid references public.accounts(id),
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'paid', 'closed')),
  total_cents integer not null default 0 check (total_cents >= 0),
  contact_name text not null default '',
  contact_phone text not null default '',
  contact_email text not null default '',
  note text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.request_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  option_key text,
  label text not null,
  price_cents integer not null check (price_cents >= 0),
  sort_order integer not null default 0
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete cascade,
  account_id uuid references public.accounts(id),
  direction text not null check (direction in ('customer', 'shop')),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts(id),
  card_id uuid references public.cards(id),
  label text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_cards_account on public.cards(account_id);
create index if not exists idx_orders_card on public.work_orders(card_id);
create index if not exists idx_requests_card on public.requests(card_id, created_at desc);
create index if not exists idx_messages_card on public.messages(card_id, created_at);

create sequence if not exists public.card_ref_seq;

comment on table public.accounts is 'Business on a card. The shop creates the row. The pay step fills contact name, phone, and email.';
comment on column public.service_options.price_cents is 'Dollar amount times 100. 15000 is $150.00. The customer page cannot send its own price.';
comment on table public.payment_methods is 'Reserved for the later payment step. Store a label only. Never a full card number.';

alter table public.accounts enable row level security;
alter table public.cards enable row level security;
alter table public.work_orders enable row level security;
alter table public.service_options enable row level security;
alter table public.requests enable row level security;
alter table public.request_lines enable row level security;
alter table public.messages enable row level security;
alter table public.payment_methods enable row level security;

drop policy if exists shop_all on public.accounts;
drop policy if exists shop_all on public.cards;
drop policy if exists shop_all on public.work_orders;
drop policy if exists shop_all on public.service_options;
drop policy if exists shop_all on public.requests;
drop policy if exists shop_all on public.request_lines;
drop policy if exists shop_all on public.messages;
drop policy if exists shop_all on public.payment_methods;

create policy shop_all on public.accounts for all to authenticated using (true) with check (true);
create policy shop_all on public.cards for all to authenticated using (true) with check (true);
create policy shop_all on public.work_orders for all to authenticated using (true) with check (true);
create policy shop_all on public.service_options for all to authenticated using (true) with check (true);
create policy shop_all on public.requests for all to authenticated using (true) with check (true);
create policy shop_all on public.request_lines for all to authenticated using (true) with check (true);
create policy shop_all on public.messages for all to authenticated using (true) with check (true);
create policy shop_all on public.payment_methods for all to authenticated using (true) with check (true);

revoke all on table public.accounts from public, anon;
revoke all on table public.cards from public, anon;
revoke all on table public.work_orders from public, anon;
revoke all on table public.service_options from public, anon;
revoke all on table public.requests from public, anon;
revoke all on table public.request_lines from public, anon;
revoke all on table public.messages from public, anon;
revoke all on table public.payment_methods from public, anon;

grant select, insert, update, delete on table public.accounts to authenticated;
grant select, insert, update, delete on table public.cards to authenticated;
grant select, insert, update, delete on table public.work_orders to authenticated;
grant select, insert, update, delete on table public.service_options to authenticated;
grant select, insert, update, delete on table public.requests to authenticated;
grant select, insert, update, delete on table public.request_lines to authenticated;
grant select, insert, update, delete on table public.messages to authenticated;
grant select, insert, update, delete on table public.payment_methods to authenticated;

revoke all on sequence public.card_ref_seq from public, anon, authenticated;

insert into public.service_options (key, label, detail, price_cents, sort_order) values
  ('register', 'Register frozen mid-rush', 'Handled the same day', 0, 1),
  ('wifi', 'Dead Wi-Fi zones, dropped orders', 'Full-coverage install', 0, 2),
  ('menus', 'Menu and price changes by hand', 'Digital menus, minutes not printers', 0, 3),
  ('backups', 'No backups, one bad day from gone', 'Automatic, tested monthly', 0, 4)
on conflict (key) do nothing;

create or replace function public.next_ref()
returns text
language sql
security definer
set search_path = public
as $$
  select 'AT-' || lpad(nextval('public.card_ref_seq')::text, 6, '0');
$$;

create or replace function public.open_card(code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized text := upper(trim(coalesce(code, '')));
  card public.cards%rowtype;
  acct public.accounts%rowtype;
begin
  if normalized !~ '^[A-Z0-9-]{4,32}$' then
    return jsonb_build_object('found', false);
  end if;

  select * into card from public.cards where public_code = normalized;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  if card.account_id is not null then
    select * into acct from public.accounts where id = card.account_id;
  end if;

  return jsonb_build_object(
    'found', true,
    'public_code', card.public_code,
    'ref_no', card.ref_no,
    'shop_name', card.shop_name,
    'slogan', card.slogan,
    'client_name', card.client_name,
    'prepared_for', card.prepared_for,
    'phone_display', card.phone_display,
    'emergency_label', card.emergency_label,
    'emergency_instruction', card.emergency_instruction,
    'followup_line', card.followup_line,
    'status', card.status,
    'contact', jsonb_build_object(
      'name', coalesce(acct.contact_name, ''),
      'phone', coalesce(acct.phone, ''),
      'email', coalesce(acct.email, '')
    ),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', w.kind,
        'problem', w.problem,
        'fix', w.fix,
        'price_cents', w.price_cents
      ) order by w.sort_order, w.created_at)
      from public.work_orders w
      where w.card_id = card.id
    ), '[]'::jsonb),
    'options', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', o.key,
        'label', o.label,
        'detail', o.detail,
        'price_cents', o.price_cents
      ) order by o.sort_order, o.key)
      from public.service_options o
      where o.active
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'status', r.status,
        'total_cents', r.total_cents,
        'contact_name', r.contact_name,
        'contact_phone', r.contact_phone,
        'contact_email', r.contact_email,
        'note', r.note,
        'created_at', r.created_at,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'label', l.label,
            'price_cents', l.price_cents
          ) order by l.sort_order, l.label)
          from public.request_lines l
          where l.request_id = r.id
        ), '[]'::jsonb)
      ) order by r.created_at desc)
      from (
        select *
        from public.requests
        where card_id = card.id
        order by created_at desc
        limit 8
      ) r
    ), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'direction', m.direction,
        'body', m.body,
        'created_at', m.created_at
      ) order by m.created_at)
      from (
        select *
        from public.messages
        where card_id = card.id
        order by created_at desc
        limit 50
      ) m
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.send_message(code text, body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized text := upper(trim(coalesce(code, '')));
  clean text := left(trim(coalesce(body, '')), 2000);
  card public.cards%rowtype;
  recent integer;
begin
  if normalized !~ '^[A-Z0-9-]{4,32}$' then
    raise exception 'Card not found';
  end if;
  if clean = '' then
    raise exception 'Write a message';
  end if;

  select * into card from public.cards where public_code = normalized;
  if not found then
    raise exception 'Card not found';
  end if;

  select count(*) into recent
  from public.messages
  where card_id = card.id
    and direction = 'customer'
    and created_at > now() - interval '10 minutes';
  if recent >= 12 then
    raise exception 'Slow down a moment, then send again.';
  end if;

  insert into public.messages (card_id, account_id, direction, body)
  values (card.id, card.account_id, 'customer', clean);

  return public.open_card(card.public_code);
end;
$$;

create or replace function public.save_request(
  code text,
  option_keys text[],
  note text,
  contact_name text,
  contact_phone text,
  contact_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized text := upper(trim(coalesce(code, '')));
  clean_name text := left(trim(coalesce(contact_name, '')), 120);
  clean_phone text := left(trim(coalesce(contact_phone, '')), 40);
  clean_email text := left(lower(trim(coalesce(contact_email, ''))), 160);
  clean_note text := left(trim(coalesce(note, '')), 1000);
  card public.cards%rowtype;
  acct_id uuid;
  req_id uuid;
  total integer := 0;
  line_count integer := 0;
  recent integer;
  opt record;
begin
  if normalized !~ '^[A-Z0-9-]{4,32}$' then
    raise exception 'Card not found';
  end if;
  if clean_name = '' then
    raise exception 'Enter a name';
  end if;
  if clean_phone = '' and clean_email = '' then
    raise exception 'Enter a phone or email';
  end if;
  if clean_phone <> '' and length(regexp_replace(clean_phone, '\D', '', 'g')) < 7 then
    raise exception 'Enter a phone number';
  end if;
  if clean_email <> '' and clean_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter an email';
  end if;
  if option_keys is null or cardinality(option_keys) = 0 then
    raise exception 'Choose at least one option';
  end if;
  if cardinality(option_keys) > 12 then
    raise exception 'Too many options';
  end if;

  select * into card from public.cards where public_code = normalized;
  if not found then
    raise exception 'Card not found';
  end if;

  select count(*) into recent
  from public.requests
  where card_id = card.id
    and created_at > now() - interval '1 hour';
  if recent >= 8 then
    raise exception 'Too many requests on this card. Try again later.';
  end if;

  acct_id := card.account_id;
  if acct_id is null then
    insert into public.accounts (business_name, contact_name, phone, email)
    values (coalesce(nullif(card.client_name, ''), clean_name), clean_name, clean_phone, clean_email)
    returning id into acct_id;
    update public.cards
      set account_id = acct_id, updated_at = now()
      where id = card.id;
  else
    update public.accounts
      set contact_name = clean_name,
          phone = case when clean_phone <> '' then clean_phone else phone end,
          email = case when clean_email <> '' then clean_email else email end,
          business_name = case
            when business_name = '' then coalesce(nullif(card.client_name, ''), clean_name)
            else business_name
          end,
          updated_at = now()
      where id = acct_id;
  end if;

  insert into public.requests (
    card_id, account_id, status, total_cents,
    contact_name, contact_phone, contact_email, note
  )
  values (
    card.id, acct_id, 'awaiting_payment', 0,
    clean_name, clean_phone, clean_email, clean_note
  )
  returning id into req_id;

  for opt in
    select *
    from public.service_options
    where active
      and key = any(option_keys)
    order by sort_order, key
  loop
    insert into public.request_lines (request_id, option_key, label, price_cents, sort_order)
    values (req_id, opt.key, opt.label, opt.price_cents, opt.sort_order);
    total := total + opt.price_cents;
    line_count := line_count + 1;
  end loop;

  if line_count = 0 then
    raise exception 'Choose an option that is still offered';
  end if;

  update public.requests set total_cents = total where id = req_id;
  update public.cards set updated_at = now() where id = card.id;

  return public.open_card(card.public_code);
end;
$$;

revoke all on function public.next_ref() from public, anon;
grant execute on function public.next_ref() to authenticated;

revoke all on function public.open_card(text) from public;
grant execute on function public.open_card(text) to anon, authenticated;

revoke all on function public.send_message(text, text) from public;
grant execute on function public.send_message(text, text) to anon, authenticated;

revoke all on function public.save_request(text, text[], text, text, text, text) from public;
grant execute on function public.save_request(text, text[], text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
