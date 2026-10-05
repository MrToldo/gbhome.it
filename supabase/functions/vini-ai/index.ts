// ═══════════════════════════════════════════════════════════════
// GB Suite · Edge Function "vini-ai"
// Chiede a Claude (con ricerca web) dove si trova la cantina di un vino
// e qualche dato di base. Risposta solo JSON.
// NUOVO · action "etichetta": legge l'etichetta da una foto e compila la scheda
// NUOVO · action "stasera":   consiglia 2-3 vini della lista ricevuta per un menu
// - accesso solo a utenti collegati con 2FA superato (aal2) e pagina "vini" consentita
// - prompt fisso e corto, modello e token fissati qui (nessun parametro libero dal browser)
// Secret usato: ANTHROPIC_API_KEY (già presente nel progetto)
// ═══════════════════════════════════════════════════════════════
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-sonnet-4-6";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function jwtClaims(token: string): Record<string, any> {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4)));
  } catch {
    return {};
  }
}

const SYSTEM = `Sei un sommelier esperto. Ricevi i dati di un vino e devi indicare dove si trova la CANTINA che lo produce.
Usa la ricerca web per verificare. Rispondi SOLO con un oggetto JSON, senza testo prima o dopo, con questi campi:
{"localita": comune o paese della sede della cantina (o null),
 "regione": regione o area vinicola (in italiano se italiana, es. "Veneto"; per l'estero la regione amministrativa o vinicola, es. "Champagne"),
 "paese": nazione in italiano (es. "Italia", "Francia"),
 "vitigno": vitigno/i principali (o null),
 "certezza": "alta" | "media" | "bassa",
 "fonte": breve nota sulla fonte (max 12 parole)}
Se non sei ragionevolmente sicuro di un campo mettilo a null. Non inventare.`;

function parseJson(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/* ═══ NUOVO · chiamata generica (senza ricerca web) ═══ */
async function callClaude(system: string, content: unknown, max_tokens: number) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages: [{ role: "user", content }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Anthropic ${r.status}`);
  return (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

const SYSTEM_ETICHETTA = `Sei un sommelier. Ricevi la foto di un'etichetta o di una bottiglia di vino.
Leggi l'etichetta e rispondi SOLO con un oggetto JSON:
{"nome": nome del vino (denominazione e/o nome di fantasia, es. "Barolo Cannubi"),
 "cantina": produttore,
 "annata": anno a 4 cifre o null,
 "tipo": uno tra "rosso","bianco","rosato","bollicine","orange","dolce" o null,
 "metodo": per le bollicine "Metodo classico" o "Metodo charmat" se deducibile, altrimenti null,
 "vitigno": vitigno/i se scritti o certi per la denominazione, altrimenti null,
 "regione": regione (in italiano per l'Italia), "paese": nazione in italiano,
 "localita": comune della cantina se scritto in etichetta, altrimenti null}
Metti null quando non sei sicuro. Non inventare.`;

const SYSTEM_STASERA = `Sei il sommelier di casa di una coppia. Ricevi il menu della serata e l'elenco dei LORO vini (JSON).
Scegli da 1 a 3 vini SOLO tra quelli dell'elenco, i più adatti al menu: considera tipo, corpo, sentori, abbinamenti già segnati da loro e i loro voti (più alti = preferiti).
Preferisci i vini con bottiglie in cantina (bottiglie > 0) e quelli da bere presto (bere_entro vicino).
Rispondi SOLO con JSON: {"scelte":[{"id":"...","perche":"motivo breve in italiano, max 20 parole"}],"nota":"consiglio di servizio breve o null"}`;
/* ═══ FINE NUOVO ═══ */

async function askClaude(user: string, withSearch: boolean) {
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 700,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  };
  if (withSearch) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Anthropic ${r.status}`);
  const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  return parseJson(text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await sb.auth.getUser(token);
    if (!user) return json({ error: "Non autorizzato" }, 401);
    const claims = jwtClaims(token);
    if (claims.aal !== "aal2") return json({ error: "Serve il 2FA" }, 403);
    const pages = claims.app_metadata?.pages;
    if (Array.isArray(pages) && !pages.includes("vini")) return json({ error: "Non autorizzato" }, 403);

    const b = await req.json();
    const clip = (x: unknown, n: number) => String(x ?? "").trim().slice(0, n);

    /* NUOVO · lettura etichetta */
    if (b.action === "etichetta") {
      const data = String(b.image ?? "");
      const mt = String(b.media_type ?? "image/jpeg");
      if (!data || data.length > 2_800_000 || !["image/jpeg", "image/png", "image/webp"].includes(mt)) return json({ error: "Immagine non valida" }, 400);
      const text = await callClaude(SYSTEM_ETICHETTA, [
        { type: "image", source: { type: "base64", media_type: mt, data } },
        { type: "text", text: "Leggi questa etichetta." },
      ], 500);
      const out = parseJson(text);
      return out ? json(out) : json({ error: "Etichetta non leggibile" }, 422);
    }

    /* NUOVO · cosa apriamo stasera */
    if (b.action === "stasera") {
      const menu = clip(b.menu, 400);
      const lista = Array.isArray(b.vini) ? b.vini.slice(0, 150) : [];
      if (!menu || !lista.length) return json({ error: "Serve il menu e almeno un vino" }, 400);
      const text = await callClaude(SYSTEM_STASERA, `Menu: ${menu}\n\nI nostri vini:\n${JSON.stringify(lista).slice(0, 40000)}`, 700);
      const out = parseJson(text);
      return out ? json(out) : json({ error: "Risposta non valida" }, 502);
    }

    const nome = clip(b.nome, 120), cantina = clip(b.cantina, 120), annata = clip(b.annata, 4);
    const regione = clip(b.regione, 60), paese = clip(b.paese, 60);
    if (!nome && !cantina) return json({ error: "Serve almeno nome o cantina" }, 400);

    const user_msg = [
      `Vino: ${nome || "(non indicato)"}`,
      `Cantina/produttore: ${cantina || "(non indicata)"}`,
      annata ? `Annata: ${annata}` : "",
      regione ? `Regione indicata dall'utente: ${regione}` : "",
      paese ? `Paese indicato dall'utente: ${paese}` : "",
    ].filter(Boolean).join("\n");

    let out;
    try {
      out = await askClaude(user_msg, true);
    } catch (e) {
      // ricerca web non abilitata sull'account → si riprova senza
      if (/web_search|tool/i.test(String((e as Error).message))) out = await askClaude(user_msg, false);
      else throw e;
    }
    if (!out) return json({ error: "Risposta non valida" }, 502);
    return json(out);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
