-- ═══════════════════════════════════════════════════════════════
-- GB Suite · pagina News (news.html + Edge Function "news")
-- Da eseguire in Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- ── 1) Tabelle ──
create table if not exists public.news_fonti (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  url_feed text not null unique,
  lingua text not null default 'it' check (lingua in ('it','en')),
  attiva boolean not null default true,
  ultimo_esito text,
  creata timestamptz not null default now()
);

create table if not exists public.news_temi (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  parole text[] not null default '{}',
  ordine int not null default 0,
  creato timestamptz not null default now()
);

-- Una riga = una notizia (anche se data da più giornali: le fonti stanno in "fonti")
create table if not exists public.news_storie (
  id uuid primary key default gen_random_uuid(),
  titolo_it text not null,
  sommario_it text,
  categoria text,
  paese text,
  importanza int not null default 3,
  immagine text,
  fonti jsonb not null default '[]'::jsonb,   -- [{nome,url,titolo,lingua,data}]
  n_fonti int not null default 1,
  pubblicata timestamptz not null default now(),
  aggiornata timestamptz not null default now()
);
create index if not exists news_storie_pubblicata_idx on public.news_storie (pubblicata desc);

-- Link già letti dai feed (per non rielaborarli)
create table if not exists public.news_visti (
  url text primary key,
  storia_id uuid references public.news_storie(id) on delete cascade,
  visto_il timestamptz not null default now()
);

-- Articoli completi già estratti/tradotti (cache 7 giorni)
create table if not exists public.news_letture (
  url text primary key,
  titolo_it text,
  paragrafi jsonb,
  tradotto boolean not null default false,
  creata timestamptz not null default now()
);

create table if not exists public.news_stato (
  id int primary key default 1 check (id = 1),
  ultimo_aggiornamento timestamptz,
  in_corso_da timestamptz,
  esito text
);
insert into public.news_stato (id) values (1) on conflict do nothing;


-- ── 2) Accesso: solo utenti collegati con 2FA e senza pagine limitate (Giulio) ──
do $$
declare t text;
begin
  foreach t in array array['news_fonti','news_temi','news_storie','news_visti','news_letture','news_stato'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "giulio_tutto" on public.%I', t);
    execute format(
      'create policy "giulio_tutto" on public.%I for all to authenticated
         using ((select auth.jwt() ->> ''aal'') = ''aal2'' and (select auth.jwt() -> ''app_metadata'' -> ''pages'') is null)
         with check ((select auth.jwt() ->> ''aal'') = ''aal2'' and (select auth.jwt() -> ''app_metadata'' -> ''pages'') is null)', t);
  end loop;
end $$;


-- ── 3) Fonti iniziali (si modificano poi dalla pagina) ──
insert into public.news_fonti (nome, url_feed, lingua) values
 ('ANSA',                   'https://www.ansa.it/sito/ansait_rss.xml', 'it'),
 ('ANSA Mondo',             'https://www.ansa.it/sito/notizie/mondo/mondo_rss.xml', 'it'),
 ('ANSA Economia',          'https://www.ansa.it/sito/notizie/economia/economia_rss.xml', 'it'),
 ('Il Sole 24 Ore',         'https://www.ilsole24ore.com/rss/mondo.xml', 'it'),
 ('Il Sole 24 Ore Finanza', 'https://www.ilsole24ore.com/rss/finanza.xml', 'it'),
 ('Il Post',                'https://www.ilpost.it/feed/', 'it'),
 ('Corriere della Sera',    'https://xml2.corriereobjects.it/rss/homepage.xml', 'it'),
 ('la Repubblica',          'https://www.repubblica.it/rss/homepage/rss2.0.xml', 'it'),
 ('BBC World',              'https://feeds.bbci.co.uk/news/world/rss.xml', 'en'),
 ('BBC Business',           'https://feeds.bbci.co.uk/news/business/rss.xml', 'en'),
 ('The Guardian',           'https://www.theguardian.com/world/rss', 'en'),
 ('CNBC',                   'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', 'en'),
 ('MarketWatch',            'https://feeds.content.dowjones.io/public/rss/mw_topstories', 'en'),
 ('Al Jazeera',             'https://www.aljazeera.com/xml/rss/all.xml', 'en'),
 ('New York Times',         'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 'en'),
 ('Politico Europe',        'https://www.politico.eu/feed/', 'en')
on conflict (url_feed) do nothing;


-- ── 4) Temi iniziali (parole chiave modificabili dalla pagina) ──
insert into public.news_temi (nome, parole, ordine)
select * from (values
 ('Mercati USA', array['Fed','Powell','Wall Street','S&P 500','Nasdaq','Treasury','tassi','inflazione'], 1),
 ('Italia',      array['Italia','Meloni','governo','Mattarella','BTP','spread'], 2),
 ('Energia',     array['petrolio','OPEC','gas','Brent','energia'], 3),
 ('Tecnologia',  array['Nvidia','Apple','intelligenza artificiale','chip','Microsoft','OpenAI'], 4)
) v(nome, parole, ordine)
where not exists (select 1 from public.news_temi);


-- ═══════════════════════════════════════════════════════════════
-- Pulizia manuale (facoltativa): notizie più vecchie di 7 giorni
-- delete from public.news_storie where pubblicata < now() - interval '7 days';
-- delete from public.news_letture where creata < now() - interval '7 days';
-- ═══════════════════════════════════════════════════════════════
