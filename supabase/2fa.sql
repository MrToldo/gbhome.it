-- ═══════════════════════════════════════════════════════════════
-- GB Suite · 2FA (MFA nativo Supabase)
-- Da eseguire in Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════════


-- ── 1) Il database risponde solo a sessioni con 2FA superato (aal2) ──
-- Policy RESTRICTIVE: si somma alle policy già esistenti senza toccarle.
-- Vale per tutte le tabelle di "public" che hanno già RLS attivo.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and rowsecurity loop
    execute format('drop policy if exists "solo_2fa" on public.%I', t.tablename);
    execute format(
      'create policy "solo_2fa" on public.%I as restrictive for all to authenticated
         using ((select auth.jwt() ->> ''aal'') = ''aal2'')
         with check ((select auth.jwt() ->> ''aal'') = ''aal2'')',
      t.tablename);
  end loop;
end $$;


-- ── 2) Controllo: tabelle SENZA RLS (leggibili da chiunque abbia la chiave anon) ──
-- Se questa query restituisce righe, quelle tabelle vanno sistemate a parte.
select tablename as tabelle_senza_rls
from pg_tables
where schemaname = 'public' and not rowsecurity;


-- ── 3) Pulizia del vecchio 2FA fatto in casa ──
-- Il segreto era salvato in chiaro e leggibile dal browser: lo si cancella.
update public.profiles set totp_secret = null, totp_enabled = false;


-- ═══════════════════════════════════════════════════════════════
-- RESET 2FA (telefono/app persi)
-- Sostituire l'email e eseguire. Al login successivo la pagina
-- mostrerà di nuovo il QR per riconfigurare l'authenticator.
-- ═══════════════════════════════════════════════════════════════
-- delete from auth.mfa_factors
-- where user_id = (select id from auth.users where email = 'email@esempio.it');
