-- ═══════════════════════════════════════════════════════════════
-- GB Suite · Vini: cantina condivisa + recensioni personali
-- GIÀ APPLICATO al progetto Supabase il 2026-10-05 (qui solo come riferimento)
-- ═══════════════════════════════════════════════════════════════

-- Recensioni personali (una per utente per vino)
create table public.vini_recensioni (
  id          uuid primary key default gen_random_uuid(),
  vino_id     uuid not null references public.vini(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  autore      text,
  data        date,
  luogo       text,
  formato     text,
  voto        smallint check (voto between 1 and 10),
  corpo       text,
  tag         text[] not null default '{}',
  ricomprerei boolean,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (vino_id, user_id)
);
create index vini_recensioni_user_idx on public.vini_recensioni(user_id);
alter table public.vini_recensioni enable row level security;
create policy "recensioni_leggi_tutte"   on public.vini_recensioni for select to authenticated using (true);
create policy "recensioni_inserisci_mie" on public.vini_recensioni for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "recensioni_modifica_mie"  on public.vini_recensioni for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "recensioni_elimina_mie"   on public.vini_recensioni for delete to authenticated using ((select auth.uid()) = user_id);

-- Recensioni esistenti copiate dalla tabella vini (le colonne originali restano)
insert into public.vini_recensioni (vino_id, user_id, autore, data, luogo, formato, voto, corpo, tag, ricomprerei, note, created_at)
select id, user_id, 'Giulio', data, luogo, formato, voto, corpo, coalesce(tag, '{}'), ricomprerei, note, created_at
from public.vini
where voto is not null or corpo is not null or coalesce(array_length(tag,1),0) > 0 or ricomprerei is not null or note is not null;

-- Cantina condivisa (si aggiungono alle policy esistenti)
create policy "vini_condivisi_select" on public.vini for select to authenticated using (true);
create policy "vini_condivisi_update" on public.vini for update to authenticated using (true) with check (true);
create policy "vini_condivisi_delete" on public.vini for delete to authenticated using (true);
create policy "vini_photos_condivise_delete" on storage.objects for delete to authenticated using (bucket_id = 'vini-photos');
create policy "vini_photos_condivise_update" on storage.objects for update to authenticated using (bucket_id = 'vini-photos');

-- Nome visualizzato nelle recensioni
-- update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data,'{}'::jsonb) || '{"nome":"Giulio"}'::jsonb where email = '...';
