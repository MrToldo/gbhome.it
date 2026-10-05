// ═══════════════════════════════════════════════════════════════
// GB Suite · Edge Function "ai-proxy" (chat IA del journal)
// NUOVO · accesso solo con sessione di login + 2FA (aal2) e solo per utenti
//         senza pagine limitate (Giulio). Modello e token limitati.
// ═══════════════════════════════════════════════════════════════
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const NOTION_TOKEN  = Deno.env.get("NOTION_TOKEN") ?? "";
const NOTION_PAGE_ID = Deno.env.get("NOTION_PAGE_ID") ?? "";

// NUOVO · limiti
const MODELLI_AMMESSI = ["claude-sonnet-4-6"];
const MAX_TOKENS = 4000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const err = (msg: string, status: number) =>
  new Response(JSON.stringify({ error: { message: msg } }), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function jwtClaims(token: string): Record<string, any> {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4)));
  } catch { return {}; }
}

async function fetchNotionPage(pageId: string): Promise<string> {
  try {
    const resp = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
    });
    const data = await resp.json();
    if (!data.results) return "";
    const lines: string[] = [];
    for (const block of data.results) {
      const text = extractText(block);
      if (text) lines.push(text);
    }
    return lines.join("\n");
  } catch (e) {
    console.error("Notion fetch error:", e);
    return "";
  }
}

function extractText(block: any): string {
  const type = block.type;
  const content = block[type];
  if (!content) return "";
  const richText = content.rich_text ?? [];
  const text = richText.map((t: any) => t.plain_text ?? "").join("");
  if (type === "heading_1") return `\n# ${text}`;
  if (type === "heading_2") return `\n## ${text}`;
  if (type === "heading_3") return `\n### ${text}`;
  if (type === "bulleted_list_item") return `• ${text}`;
  if (type === "numbered_list_item") return `- ${text}`;
  if (type === "to_do") return `[${content.checked ? "x" : " "}] ${text}`;
  if (type === "quote") return `> ${text}`;
  if (type === "code") return `\`${text}\``;
  if (type === "paragraph") return text;
  return text;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    // NUOVO · controllo accesso
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await sb.auth.getUser(token);
    if (!user) return err("Accesso richiesto: rifai il login", 401);
    const claims = jwtClaims(token);
    if (claims.aal !== "aal2") return err("Serve il 2FA: rifai il login", 403);
    if (claims.app_metadata?.pages) return err("Non autorizzato", 403);

    const body = await req.json();

    // NUOVO · solo i campi necessari, modello e lunghezza limitati
    const model = MODELLI_AMMESSI.includes(body.model) ? body.model : MODELLI_AMMESSI[0];
    const max_tokens = Math.min(Math.max(parseInt(body.max_tokens, 10) || 1000, 1), MAX_TOKENS);
    const messages = Array.isArray(body.messages) ? body.messages : [];

    let notionContent = "";
    if (NOTION_TOKEN && NOTION_PAGE_ID) {
      notionContent = await fetchNotionPage(NOTION_PAGE_ID);
    }
    let system = typeof body.system === "string" ? body.system : "";
    if (notionContent) {
      system += `\n\n=== STRATEGIE E REGOLE DEL TRADER (da Notion) ===\n${notionContent}\n=== FINE STRATEGIE ===`;
    }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens, system, messages }),
    });

    const data = await resp.json();
    return new Response(JSON.stringify(data), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return err((e as Error).message, 500);
  }
});
