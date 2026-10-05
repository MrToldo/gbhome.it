// ═══════════════════════════════════════════════════════════════
// GB Suite · Edge Function "news"
// action "aggiorna": legge i feed RSS delle fonti attive, passa i nuovi
//                    articoli a Gemini che unisce i doppioni (anche tra
//                    italiano e inglese), traduce titolo + sommario in
//                    italiano e assegna categoria / paese / importanza.
// action "articolo": scarica l'articolo originale, ne estrae il testo e,
//                    se è in inglese, lo fa tradurre a Gemini (cache 7 gg).
// - accesso solo con login + 2FA (aal2) e solo per utenti senza pagine
//   limitate (Giulio)
// Secret richiesto: GEMINI_API_KEY
// ═══════════════════════════════════════════════════════════════
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseHTML } from "npm:linkedom@0.18.5";
import { Readability } from "npm:@mozilla/readability@0.5.0";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_PREFERITI = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"]; // usati se l'elenco modelli non risponde
const FINESTRA_ORE = 36;          // articoli più vecchi vengono ignorati
const MAX_NUOVI = 120;            // articoli nuovi elaborati per giro
const LOTTO = 60;                 // articoli per singola chiamata a Gemini
const BUDGET_MS = 110_000;        // tempo massimo di un aggiornamento
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const CATEGORIE = ["Mercati", "Economia", "Politica", "Esteri", "Conflitti", "Tecnologia", "Energia", "Società", "Scienza", "Cultura", "Sport"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function jwtClaims(token: string): Record<string, any> {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4)));
  } catch { return {}; }
}

/* ══ Gemini ══ */
/* NUOVO · i modelli Flash vengono presi dall'elenco che Google dà per questa chiave
           (i nomi cambiano spesso); riprova se sovraccarico (429/500/503) e poi passa al successivo */
const attendi = (ms: number) => new Promise((r) => setTimeout(r, ms));
let modelliCache: string[] | null = null;

async function modelliDisponibili(): Promise<string[]> {
  if (modelliCache) return modelliCache;
  const trovati: { id: string; ver: number; lite: boolean; alias: boolean }[] = [];
  try {
    let pagina = "";
    for (let k = 0; k < 5; k++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${pagina ? `&pageToken=${pagina}` : ""}`,
        { headers: { "x-goog-api-key": GEMINI_KEY }, signal: AbortSignal.timeout(10_000) });
      if (r.status === 401 || r.status === 403) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error?.message || "Chiave Gemini non valida");
      }
      if (!r.ok) break;
      const d = await r.json();
      for (const m of d.models ?? []) {
        const id = String(m.name ?? "").replace(/^models\//, "");
        if (!(m.supportedGenerationMethods ?? []).includes("generateContent")) continue;
        // solo Flash / Flash-Lite stabili (niente preview, sperimentali, immagini, audio, tts)
        const x = id.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/);
        if (x) trovati.push({ id, ver: parseFloat(x[1]), lite: !!x[2], alias: false });
        else if (id === "gemini-flash-latest" || id === "gemini-flash-lite-latest") trovati.push({ id, ver: 0, lite: id.includes("lite"), alias: true });
      }
      pagina = d.nextPageToken ?? "";
      if (!pagina) break;
    }
  } catch (e) {
    if (/chiave|key|api/i.test((e as Error).message)) throw e;
  }
  // ordine: Flash più recente → alias Flash → Flash-Lite più recente → alias Lite
  trovati.sort((a, b) => (+a.lite - +b.lite) || (+a.alias - +b.alias) || (b.ver - a.ver));
  const elenco = trovati.map((t) => t.id).slice(0, 5);
  modelliCache = elenco.length ? elenco : GEMINI_PREFERITI;
  return modelliCache;
}

async function gemini(prompt: string, maxTokens = 8192): Promise<any> {
  if (!GEMINI_KEY) throw new Error("Manca il secret GEMINI_API_KEY in Supabase");
  let ultimoErrore = "";
  for (const modello of await modelliDisponibili()) {
    // ragionamento al minimo: per i 2.5 si usa thinkingBudget, per i più recenti thinkingLevel
    let pensiero: Record<string, unknown> | null = modello.startsWith("gemini-2.") ? { thinkingBudget: 0 } : { thinkingLevel: "low" };
    for (let tentativo = 0; tentativo < 3; tentativo++) {
      const generationConfig: Record<string, unknown> = {
        responseMimeType: "application/json",
        temperature: 0.2,
        maxOutputTokens: maxTokens,
      };
      if (pensiero) generationConfig.thinkingConfig = pensiero;
      let r: Response;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modello}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig }),
          signal: AbortSignal.timeout(70_000),
        });
      } catch (e) {
        ultimoErrore = `Gemini non risponde (${(e as Error).message})`;
        await attendi(1500 * (tentativo + 1));
        continue;
      }
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        const testo = (data?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("");
        const m = testo.match(/[\[{][\s\S]*[\]}]/);
        if (!m) { ultimoErrore = `Risposta di ${modello} non valida`; break; } // prova il modello successivo
        try { return JSON.parse(m[0]); } catch { ultimoErrore = `Risposta di ${modello} incompleta`; break; }
      }
      ultimoErrore = `${modello}: ${data?.error?.message || r.status}`;
      if (r.status === 401 || r.status === 403) throw new Error(ultimoErrore);         // chiave sbagliata
      if (r.status === 400 && pensiero && /think/i.test(ultimoErrore)) { pensiero = null; continue; } // parametro non accettato → senza
      if (r.status === 400 || r.status === 404) break;                                // modello non disponibile → successivo
      await attendi(2000 * (tentativo + 1));                                          // 429/500/503 → riprova
    }
  }
  throw new Error(ultimoErrore || "Gemini non disponibile");
}
/* ══ FINE NUOVO ══ */

/* ══ RSS / Atom ══ */
type Voce = { fonte: string; lingua: string; url: string; titolo: string; testo: string; data: number; immagine: string | null };

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", egrave: "è", eacute: "é", agrave: "à", ograve: "ò", ugrave: "ù", igrave: "ì", ndash: "–", mdash: "—" };
function decodifica(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
const senzaTag = (s: string) => decodifica(decodifica(s)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
function campo(blocco: string, ...nomi: string[]): string {
  for (const n of nomi) {
    const m = blocco.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i"));
    if (m && m[1].trim()) return m[1];
  }
  return "";
}
function attr(blocco: string, tag: string, nome: string): string {
  const m = blocco.match(new RegExp(`<${tag}\\b[^>]*\\b${nome}=["']([^"']+)["']`, "i"));
  return m ? decodifica(m[1]) : "";
}
function urlPulito(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    [...x.searchParams.keys()].forEach((k) => { if (/^(utm_|ref|refresh_ce|cmpid|ito|at_)/i.test(k)) x.searchParams.delete(k); });
    return x.toString();
  } catch { return u.trim(); }
}

function leggiFeed(xml: string, fonte: string, lingua: string): Voce[] {
  const blocchi = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: Voce[] = [];
  for (const b of blocchi) {
    const titolo = senzaTag(campo(b, "title"));
    let link = senzaTag(campo(b, "link"));
    if (!/^https?:/i.test(link)) link = attr(b, "link", "href");
    if (!/^https?:/i.test(link)) link = senzaTag(campo(b, "guid"));
    if (!titolo || !/^https?:/i.test(link)) continue;
    const grezzo = campo(b, "description", "summary", "content:encoded", "content");
    const dataTxt = senzaTag(campo(b, "pubDate", "published", "updated", "dc:date"));
    const data = Date.parse(dataTxt);
    const immagine = attr(b, "media:content", "url") || attr(b, "media:thumbnail", "url") ||
      (/image/i.test(attr(b, "enclosure", "type")) ? attr(b, "enclosure", "url") : "") ||
      (decodifica(grezzo).match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? "");
    out.push({
      fonte, lingua, url: urlPulito(link), titolo,
      testo: senzaTag(grezzo).slice(0, 300),
      data: isNaN(data) ? Date.now() : data,
      immagine: /^https:/i.test(immagine) ? immagine : null,
    });
  }
  return out;
}

const normTitolo = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/* ══ Aggiornamento ══ */
async function aggiorna(db: any) {
  const inizio = Date.now();

  // blocco: un solo aggiornamento alla volta (scade dopo 3 minuti)
  const { data: lock } = await db.from("news_stato")
    .update({ in_corso_da: new Date().toISOString() })
    .eq("id", 1)
    .or(`in_corso_da.is.null,in_corso_da.lt."${new Date(Date.now() - 180_000).toISOString()}"`)
    .select();
  if (!lock?.length) return { in_corso: true };

  try {
    const { data: fonti } = await db.from("news_fonti").select("*").eq("attiva", true);
    const limite = Date.now() - FINESTRA_ORE * 3600_000;

    // 1) feed in parallelo
    const risultati = await Promise.all((fonti ?? []).map(async (f: any) => {
      try {
        const r = await fetch(f.url_feed, { headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*" }, signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const voci = leggiFeed(await r.text(), f.nome, f.lingua).filter((v) => v.data >= limite);
        await db.from("news_fonti").update({ ultimo_esito: `ok · ${voci.length} articoli` }).eq("id", f.id);
        return voci;
      } catch (e) {
        await db.from("news_fonti").update({ ultimo_esito: `errore · ${String((e as Error).message).slice(0, 80)}` }).eq("id", f.id);
        return [] as Voce[];
      }
    }));

    // 2) togli doppioni banali (stesso link o stesso titolo) e articoli già visti
    const perUrl = new Map<string, Voce>();
    const titoliVisti = new Set<string>();
    for (const v of risultati.flat().sort((a, b) => b.data - a.data)) {
      const t = normTitolo(v.titolo);
      if (perUrl.has(v.url) || titoliVisti.has(t)) continue;
      perUrl.set(v.url, v); titoliVisti.add(t);
    }
    const urls = [...perUrl.keys()];
    const giaVisti = new Set<string>();
    for (let i = 0; i < urls.length; i += 200) {
      const { data } = await db.from("news_visti").select("url").in("url", urls.slice(i, i + 200));
      (data ?? []).forEach((r: any) => giaVisti.add(r.url));
    }
    const nuovi = urls.filter((u) => !giaVisti.has(u)).map((u) => perUrl.get(u)!).slice(0, MAX_NUOVI);

    let create = 0, unite = 0, scartate = 0;

    // 3) Gemini a lotti: unisce, traduce, classifica
    for (let i = 0; i < nuovi.length; i += LOTTO) {
      if (Date.now() - inizio > BUDGET_MS) break;
      const lotto = nuovi.slice(i, i + LOTTO);

      const { data: recenti } = await db.from("news_storie").select("id,titolo_it,fonti,n_fonti,immagine")
        .gte("pubblicata", new Date(limite).toISOString()).order("pubblicata", { ascending: false }).limit(250);
      const mappaRecenti = new Map<string, any>((recenti ?? []).map((s: any) => [s.id, s]));

      const prompt = `Sei il caporedattore di una rassegna stampa italiana per un trader. Ricevi NOTIZIE GIÀ PUBBLICATE e NUOVI ARTICOLI presi da giornali italiani e inglesi.
Per ogni nuovo articolo decidi:
- se racconta lo STESSO FATTO specifico di una notizia già pubblicata → "storia": il suo id;
- altrimenti se racconta lo stesso fatto di altri nuovi articoli → dai a tutti lo stesso "gruppo" (es. "G1");
- altrimenti un "gruppo" tutto suo.
Stesso fatto = stesso evento concreto (anche se scritto in lingue diverse o con dettagli diversi), NON solo stesso argomento.
Scarta ("scarta": true) ciò che non è una notizia utile: oroscopi, ricette, gossip, quiz, offerte e pubblicità, programmi TV, necrologi, sport minore, dirette generiche.
Per ogni gruppo NUOVO scrivi in ITALIANO:
- "titolo": giornalistico e chiaro, max 14 parole, senza clickbait;
- "sommario": 2 frasi neutre basate solo sui testi ricevuti;
- "categoria": una tra ${CATEGORIE.join(", ")};
- "paese": paese principale coinvolto in italiano (es. "Stati Uniti", "Italia", "Cina") oppure "Mondo";
- "importanza": 1-5 (5 = evento di portata mondiale o che muove i mercati; 1 = curiosità locale).
Rispondi SOLO con JSON:
{"articoli":[{"i":0,"storia":null,"gruppo":"G1","scarta":false}],"gruppi":[{"gruppo":"G1","titolo":"...","sommario":"...","categoria":"...","paese":"...","importanza":3}]}

NOTIZIE GIÀ PUBBLICATE:
${(recenti ?? []).map((s: any) => `${s.id} | ${s.titolo_it}`).join("\n") || "(nessuna)"}

NUOVI ARTICOLI:
${lotto.map((v, k) => `[${k}] (${v.fonte}, ${v.lingua}) ${v.titolo} — ${v.testo.slice(0, 220)}`).join("\n")}`;

      let esito: any;
      try { esito = await gemini(prompt, 16000); }
      catch (e) {
        if (i === 0) throw new Error("Gemini: " + (e as Error).message);
        break; // NUOVO · i lotti già fatti restano salvati, il resto al prossimo giro
      }

      const gruppi = new Map<string, any>((esito?.gruppi ?? []).map((g: any) => [String(g.gruppo), g]));
      const membri = new Map<string, Voce[]>();
      const visti: { url: string; storia_id: string | null }[] = [];
      const daUnire = new Map<string, Voce[]>();

      for (const a of esito?.articoli ?? []) {
        const v = lotto[Number(a.i)];
        if (!v) continue;
        if (a.scarta) { visti.push({ url: v.url, storia_id: null }); scartate++; continue; }
        if (a.storia && mappaRecenti.has(String(a.storia))) {
          const k = String(a.storia);
          daUnire.set(k, [...(daUnire.get(k) ?? []), v]);
          continue;
        }
        const g = String(a.gruppo ?? `solo-${a.i}`);
        membri.set(g, [...(membri.get(g) ?? []), v]);
      }

      const fonteDi = (v: Voce) => ({ nome: v.fonte, url: v.url, titolo: v.titolo, lingua: v.lingua, data: new Date(v.data).toISOString() });
      const contaFonti = (f: any[]) => new Set(f.map((x) => String(x.nome).split(" ")[0].toLowerCase())).size;

      // notizie nuove
      for (const [g, vs] of membri) {
        const info = gruppi.get(g);
        const base = vs[0];
        const fonti = vs.map(fonteDi);
        const { data: s } = await db.from("news_storie").insert({
          titolo_it: String(info?.titolo || base.titolo).slice(0, 220),
          sommario_it: info?.sommario ? String(info.sommario).slice(0, 700) : (base.lingua === "it" ? base.testo : null),
          categoria: CATEGORIE.includes(info?.categoria) ? info.categoria : null,
          paese: info?.paese ? String(info.paese).slice(0, 40) : null,
          importanza: Math.min(5, Math.max(1, parseInt(info?.importanza, 10) || 3)),
          immagine: vs.find((x) => x.immagine)?.immagine ?? null,
          fonti, n_fonti: contaFonti(fonti),
          pubblicata: new Date(Math.min(...vs.map((x) => x.data))).toISOString(),
        }).select("id").single();
        vs.forEach((v) => visti.push({ url: v.url, storia_id: s?.id ?? null }));
        create++;
      }

      // fonti aggiunte a notizie già esistenti
      for (const [id, vs] of daUnire) {
        const s = mappaRecenti.get(id);
        const presenti = new Set((s.fonti ?? []).map((f: any) => f.url));
        const fonti = [...(s.fonti ?? []), ...vs.filter((v) => !presenti.has(v.url)).map(fonteDi)];
        await db.from("news_storie").update({
          fonti, n_fonti: contaFonti(fonti),
          immagine: s.immagine ?? vs.find((x) => x.immagine)?.immagine ?? null,
          aggiornata: new Date().toISOString(),
        }).eq("id", id);
        vs.forEach((v) => visti.push({ url: v.url, storia_id: id }));
        unite += vs.length;
      }

      if (visti.length) await db.from("news_visti").upsert(visti, { onConflict: "url" });
    }

    // pulizia: oltre 7 giorni
    const settimana = new Date(Date.now() - 7 * 86400_000).toISOString();
    await db.from("news_storie").delete().lt("pubblicata", settimana);
    await db.from("news_visti").delete().lt("visto_il", settimana);
    await db.from("news_letture").delete().lt("creata", settimana);

    const rimasti = Math.max(0, urls.filter((u) => !giaVisti.has(u)).length - MAX_NUOVI);
    const esitoTxt = `${create} nuove, ${unite} unite, ${scartate} scartate${rimasti ? `, ${rimasti} in coda` : ""}`;
    await db.from("news_stato").update({ ultimo_aggiornamento: new Date().toISOString(), in_corso_da: null, esito: esitoTxt }).eq("id", 1);
    return { ok: true, nuove: create, unite, scartate, in_coda: rimasti };
  } catch (e) {
    await db.from("news_stato").update({ in_corso_da: null, esito: "errore · " + String((e as Error).message).slice(0, 200) }).eq("id", 1);
    throw e;
  }
}

/* ══ Articolo completo ══ */
function paragrafiDa(html: string): string[] {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`) as any;
  const out: string[] = [];
  document.querySelectorAll("h2, h3, p, li, blockquote").forEach((el: any) => {
    if (el.tagName === "P" && el.closest("li, blockquote")) return;
    const t = String(el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (t.length < 25 && !/^H[23]$/.test(el.tagName)) return;
    if (!t) return;
    out.push(/^H[23]$/.test(el.tagName) ? "## " + t : t);
  });
  return out;
}

async function articolo(db: any, url: string, lingua: string) {
  // si aprono solo link arrivati dai feed
  const { data: noto } = await db.from("news_visti").select("url").eq("url", url).maybeSingle();
  if (!noto) return { errore: "Link non riconosciuto" };

  const { data: cache } = await db.from("news_letture").select("*").eq("url", url).maybeSingle();
  if (cache?.paragrafi?.length) return { titolo: cache.titolo_it, paragrafi: cache.paragrafi, tradotto: cache.tradotto };

  let html = "";
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "it-IT,it;q=0.9,en;q=0.8" }, signal: AbortSignal.timeout(12_000), redirect: "follow" });
    if (!r.ok) return { bloccato: true, motivo: `Il sito ha risposto ${r.status}` };
    html = await r.text();
  } catch { return { bloccato: true, motivo: "Il sito non risponde" }; }

  const { document } = parseHTML(html) as any;
  const art = new Readability(document as any).parse();
  if (!art?.content) return { bloccato: true, motivo: "Testo non leggibile" };
  let paragrafi = paragrafiDa(art.content).slice(0, 80);
  let titolo = String(art.title ?? "").trim();
  const lunghezza = paragrafi.join(" ").length;
  if (paragrafi.length < 3 || lunghezza < 600) return { bloccato: true, motivo: "Articolo riservato agli abbonati o non estraibile" };

  let tradotto = false;
  if (lingua === "en") {
    // taglio a ~24.000 caratteri per stare nei limiti
    let somma = 0;
    paragrafi = paragrafi.filter((p) => (somma += p.length) < 24_000);
    const out = await gemini(
      `Traduci in italiano giornalistico, naturale e fedele, questo articolo. Mantieni lo stesso numero di paragrafi e l'ordine; le righe che iniziano con "## " sono sottotitoli: mantieni il prefisso. Nomi propri, sigle e cifre restano invariati.
Rispondi SOLO con JSON: {"titolo":"...","paragrafi":["...", "..."]}

${JSON.stringify({ titolo, paragrafi })}`, 32000);
    if (Array.isArray(out?.paragrafi) && out.paragrafi.length) {
      paragrafi = out.paragrafi.map((p: any) => String(p));
      titolo = String(out.titolo || titolo);
      tradotto = true;
    }
  }

  await db.from("news_letture").upsert({ url, titolo_it: titolo, paragrafi, tradotto });
  return { titolo, paragrafi, tradotto };
}

/* ══ Server ══ */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const pub = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await pub.auth.getUser(token);
    if (!user) return json({ error: "Accesso richiesto: rifai il login" }, 401);
    const claims = jwtClaims(token);
    if (claims.aal !== "aal2") return json({ error: "Serve il 2FA: rifai il login" }, 403);
    if (claims.app_metadata?.pages) return json({ error: "Non autorizzato" }, 403);

    // scritture con la chiave di servizio (solo dopo i controlli sopra)
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const b = await req.json().catch(() => ({}));

    if (b.action === "aggiorna") return json(await aggiorna(db));
    if (b.action === "articolo") {
      const url = String(b.url ?? "").slice(0, 1000);
      if (!/^https?:\/\//i.test(url)) return json({ error: "Link non valido" }, 400);
      return json(await articolo(db, url, b.lingua === "en" ? "en" : "it"));
    }
    return json({ error: "Azione sconosciuta" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
