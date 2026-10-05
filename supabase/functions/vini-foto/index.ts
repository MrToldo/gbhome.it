// ═══════════════════════════════════════════════════════════════
// GB Suite · Edge Function "vini-foto"
// action "search" → cerca immagini della bottiglia (Brave o Serper)
// action "pick"   → NUOVO · cerca e fa scegliere all'IA la foto con bottiglia
//                   intera su sfondo bianco (niente PNG)
// action "save"   → scarica l'immagine lato server e la salva nel
//                   bucket vini-photos nella cartella dell'utente
// Secret: BRAVE_API_KEY oppure SERPER_API_KEY; ANTHROPIC_API_KEY per "pick"
// ═══════════════════════════════════════════════════════════════
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const BUCKET = "vini-photos";
const MAX_BYTES = 8 * 1024 * 1024;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Img = { thumb: string; url: string; title?: string; w?: number; h?: number };

async function search(q: string): Promise<Img[]> {
  const brave = Deno.env.get("BRAVE_API_KEY");
  const serper = Deno.env.get("SERPER_API_KEY");

  if (brave) {
    const u = new URL("https://api.search.brave.com/res/v1/images/search");
    u.searchParams.set("q", q);
    u.searchParams.set("count", "20");
    u.searchParams.set("safesearch", "strict");
    const r = await fetch(u, { headers: { Accept: "application/json", "X-Subscription-Token": brave } });
    if (!r.ok) throw new Error(`Brave ${r.status}`);
    const j = await r.json();
    return (j.results ?? [])
      .map((x: any) => ({
        thumb: x.thumbnail?.src,
        url: x.properties?.url || x.thumbnail?.src,
        title: x.title,
        w: x.properties?.width,
        h: x.properties?.height,
      }))
      .filter((x: Img) => x.thumb && x.url);
  }

  if (serper) {
    const r = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": serper, "Content-Type": "application/json" },
      body: JSON.stringify({ q, gl: "it", hl: "it", num: 20 }),
    });
    if (!r.ok) throw new Error(`Serper ${r.status}`);
    const j = await r.json();
    return (j.images ?? [])
      .map((x: any) => ({
        thumb: x.thumbnailUrl || x.imageUrl,
        url: x.imageUrl,
        title: x.title,
        w: x.imageWidth,
        h: x.imageHeight,
      }))
      .filter((x: Img) => x.thumb && x.url);
  }

  throw new Error("Nessuna chiave API configurata (BRAVE_API_KEY o SERPER_API_KEY)");
}

async function fetchImage(url: string) {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        Accept: "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!ct.startsWith("image/") || ct.includes("svg")) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength < 3000 || buf.byteLength > MAX_BYTES) return null;
    return { buf, ct };
  } catch {
    return null;
  }
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
  "image/webp": "webp", "image/avif": "avif", "image/gif": "gif",
};

/* ═══ NUOVO · scelta della foto con l'IA ═══ */
const isPng = (x: Img) => /\.png(\?|#|$)/i.test(x.url);
const vertical = (x: Img) => !x.w || !x.h || x.h / x.w >= 1.25;
const VISION_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

async function askVision(model: string, content: unknown[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 60, messages: [{ role: "user", content }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Anthropic ${r.status}`);
  const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const m = text.match(/-?\d+/);
  return m ? parseInt(m[0], 10) : -1;
}

async function pick(q: string, vino: string): Promise<Img | null> {
  const all = await search(q);
  // niente PNG, prima le foto verticali
  const cand = all.filter((x) => !isPng(x)).sort((a, b) => Number(vertical(b)) - Number(vertical(a))).slice(0, 8);
  if (!cand.length) return null;

  const imgs = await Promise.all(cand.map(async (c) => {
    const im = await fetchImage(c.thumb);
    return im && VISION_TYPES.includes(im.ct) && im.buf.byteLength < 1_500_000 ? { c, im } : null;
  }));
  const ok = imgs.filter(Boolean) as { c: Img; im: { buf: Uint8Array; ct: string } }[];
  if (!ok.length) return cand.find(vertical) ?? cand[0];

  const content: unknown[] = [];
  ok.forEach((x, i) => {
    content.push({ type: "text", text: `Immagine ${i + 1}:` });
    content.push({ type: "image", source: { type: "base64", media_type: x.im.ct, data: encodeBase64(x.im.buf) } });
  });
  content.push({
    type: "text",
    text: `Vino cercato: ${vino}.
Scegli l'immagine migliore per un catalogo: UNA sola bottiglia di vino, intera (tappo/capsula e fondo visibili), dritta, su sfondo BIANCO o quasi bianco, foto da e-commerce. Scarta foto con persone, mani, tavoli, scaffali, più bottiglie, sfondi colorati o scuri, bottiglie tagliate.
Se le etichette si leggono, preferisci quella del vino cercato.
Rispondi SOLO con il numero dell'immagine scelta, oppure 0 se nessuna va bene.`,
  });

  let n = -1;
  try { n = await askVision("claude-haiku-4-5-20251001", content); }
  catch { n = await askVision("claude-sonnet-4-6", content); }
  if (n >= 1 && n <= ok.length) return ok[n - 1].c;
  return null;
}
/* ═══ FINE NUOVO ═══ */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await sb.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
    if (!user) return json({ error: "Non autorizzato" }, 401);

    const body = await req.json();

    if (body.action === "search") {
      const q = String(body.q ?? "").trim().slice(0, 200);
      if (!q) return json({ results: [] });
      // NUOVO · niente PNG in cima, prima le verticali
      const res = (await search(q)).sort((a, b) => (Number(isPng(a)) - Number(isPng(b))) || (Number(vertical(b)) - Number(vertical(a))));
      return json({ results: res });
    }

    if (body.action === "pick") {   // NUOVO
      const q = String(body.q ?? "").trim().slice(0, 200);
      const vino = String(body.vino ?? q).trim().slice(0, 200);
      if (!q) return json({ result: null });
      return json({ result: await pick(q, vino) });
    }

    if (body.action === "save") {
      const img = (await fetchImage(String(body.url ?? ""))) ?? (await fetchImage(String(body.thumb ?? "")));
      if (!img) return json({ error: "Immagine non scaricabile" }, 422);
      const path = `${user.id}/web_${Date.now()}_${crypto.randomUUID().slice(0, 6)}.${EXT[img.ct] ?? "jpg"}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, img.buf, { contentType: img.ct, upsert: false });
      if (error) throw error;
      const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
      return json({ url: data.publicUrl, path });
    }

    return json({ error: "Azione sconosciuta" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
