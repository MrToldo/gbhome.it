-- ═══════════════════════════════════════════════════════════════
-- GB Suite · Vini: unione di due vini registrati due volte
-- DA ESEGUIRE A MANO: Supabase → SQL Editor → incolla → Run
-- Dopo, il pulsante "Unisci" sposta anche le recensioni dell'altro utente.
-- ═══════════════════════════════════════════════════════════════
create or replace function public.vini_unisci(src uuid, dst uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Non autorizzato';
  end if;
  if (auth.jwt() -> 'app_metadata' -> 'pages') is not null
     and not ((auth.jwt() -> 'app_metadata' -> 'pages') ? 'vini') then
    raise exception 'Non autorizzato';
  end if;
  if src = dst then raise exception 'È lo stesso vino'; end if;
  if not exists (select 1 from vini where id = src) or not exists (select 1 from vini where id = dst) then
    raise exception 'Vino non trovato';
  end if;

  -- recensioni: si spostano sul vino che resta (se un utente le ha su entrambi, resta quella già presente)
  update vini_recensioni r set vino_id = dst
  where r.vino_id = src
    and not exists (select 1 from vini_recensioni d where d.vino_id = dst and d.user_id = r.user_id);

  -- scheda: i campi vuoti del vino che resta si completano con quelli dell'altro
  update vini d set
    cantina     = coalesce(d.cantina, s.cantina),
    annata      = coalesce(d.annata, s.annata),
    tipo        = coalesce(d.tipo, s.tipo),
    metodo      = coalesce(d.metodo, s.metodo),
    vitigno     = coalesce(d.vitigno, s.vitigno),
    regione     = coalesce(d.regione, s.regione),
    prezzo      = coalesce(d.prezzo, s.prezzo),
    temperatura = coalesce(d.temperatura, s.temperatura),
    localita    = coalesce(d.localita, s.localita),
    paese       = coalesce(d.paese, s.paese),
    lat         = case when d.localita is null then s.lat else d.lat end,
    lng         = case when d.localita is null then s.lng else d.lng end,
    in_cantina  = case when d.in_cantina or s.in_cantina then true else coalesce(d.in_cantina, s.in_cantina) end,
    foto_url    = coalesce(d.foto_url, s.foto_url),
    foto_path   = case when d.foto_url is null then s.foto_path else d.foto_path end,
    foto_auto   = case when d.foto_url is null then s.foto_auto else d.foto_auto end
  from vini s
  where d.id = dst and s.id = src;

  delete from vini where id = src;
end;
$$;

revoke all on function public.vini_unisci(uuid, uuid) from public, anon;
grant execute on function public.vini_unisci(uuid, uuid) to authenticated;
