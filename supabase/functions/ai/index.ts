import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { admin, caller, cors, isStaff, json } from "./_shared.ts";

const PREFERRED = (Deno.env.get("GEMINI_MODEL") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const FALLBACK = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-flash-lite-latest", "gemini-3.5-flash-lite"];
const MAX_INLINE = 18 * 1024 * 1024; // keep request under Gemini's inline limit
let lastModel = "";

async function listModels(key: string) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15000) });
  const b = await r.json();
  return ((b.models ?? []) as { name: string; supportedGenerationMethods?: string[] }[])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent") && /flash/i.test(m.name) && !/image|tts|live|audio|embed/i.test(m.name))
    .map((m) => m.name.replace("models/", ""));
}

async function gemini(parts: unknown[], schemaHint: string) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("AI is not switched on yet: the GEMINI_API_KEY secret is missing.");
  let available: string[] = [];
  try { available = await listModels(key); } catch { /* fall back to the fixed list */ }
  const order = [...new Set([...PREFERRED, ...FALLBACK.filter((m) => !available.length || available.includes(m)), ...available])].slice(0, 6);
  let lastErr = "no model available";
  const start = Date.now();
  for (const model of order) {
    const left = 125000 - (Date.now() - start);
    if (left < 8000) break;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", signal: AbortSignal.timeout(Math.min(45000, left)),
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
          systemInstruction: { parts: [{ text: "You are a senior Indian litigation associate with 20 years of experience. Be precise and factual. Never invent facts, dates, section numbers or judgments; if something is uncertain, say 'verify'. Answer only with JSON in this shape: " + schemaHint }] },
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        lastErr = body?.error?.message ?? String(res.status);
        if ([429, 500, 503, 504, 404].includes(res.status) || /demand|overload|unavailable|not found/i.test(lastErr)) continue;
        throw new Error("AI error: " + lastErr);
      }
      const text = body?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
      lastModel = model;
      try { return JSON.parse(text); } catch { return JSON.parse(text.replace(/^```json|```$/g, "").trim()); }
    } catch (e) {
      if ((e as Error).message.startsWith("AI error")) throw e;
      lastErr = (e as Error).name === "TimeoutError" ? model + " took too long" : (e as Error).message;
    }
  }
  throw new Error("AI is busy right now (" + lastErr + "). Please try again in a minute.");
}

async function fileParts(docs: { storage_path: string | null; name: string; kind: string }[]) {
  const parts: unknown[] = []; let total = 0; const skipped: string[] = [];
  for (const d of docs) {
    if (!d.storage_path) continue;
    const { data, error } = await admin.storage.from("case-files").download(d.storage_path);
    if (error || !data) { skipped.push(d.name); continue; }
    const buf = new Uint8Array(await data.arrayBuffer());
    if (total + buf.length > MAX_INLINE) { skipped.push(d.name); continue; }
    total += buf.length;
    const mime = data.type || (d.kind === "audio" ? "audio/mpeg" : d.kind === "photo" ? "image/jpeg" : "application/pdf");
    parts.push({ text: `File: ${d.name}` }, { inline_data: { mime_type: mime, data: encodeBase64(buf) } });
  }
  return { parts, skipped };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const me = await caller(req);
    const { action, case_id, document_id } = await req.json();

    if (action === "check") {
      const t0 = Date.now();
      const out = await gemini([{ text: "Reply with ok." }], '{"reply": "ok"}');
      return json({ ok: true, model: lastModel, ms: Date.now() - t0, out, available: await listModels(Deno.env.get("GEMINI_API_KEY") ?? "").catch(() => []) });
    }

    if (action === "transcribe") {
      const { data: doc } = await admin.from("documents").select("*").eq("id", document_id).single();
      if (!doc) throw new Error("Document not found.");
      if (!isStaff(me) && doc.client_id !== me.client_id) throw new Error("Not allowed.");
      if (doc.kind !== "audio") throw new Error("This file is not audio.");
      const { parts } = await fileParts([doc]);
      if (!parts.length) throw new Error("Audio file could not be read (too large or missing).");
      const out = await gemini([{ text: "Transcribe this audio word for word in its original language. If it is not English, also give a faithful English translation." }, ...parts],
        '{"language": "name of the language spoken", "transcript": "verbatim transcript in original language", "english": "English translation, or the same text if already English"}');
      await admin.from("documents").update({ transcript: out.transcript, transcript_en: out.english, language: out.language, status: "Transcribed" }).eq("id", doc.id);
      return json({ ok: true, ...out });
    }

    if (action === "summarize") {
      if (!isStaff(me)) throw new Error("Only the chamber can run case summaries.");
      const { data: c } = await admin.from("cases").select("*, clients(full_name)").eq("id", case_id).single();
      if (!c) throw new Error("Case not found.");
      const { data: docs } = await admin.from("documents").select("*").eq("case_id", case_id).order("created_at");
      const { parts, skipped } = await fileParts((docs ?? []).filter((d) => !d.transcript || d.kind !== "audio"));
      const transcripts = (docs ?? []).filter((d) => d.transcript).map((d) => `Transcript of ${d.name}: ${d.transcript_en || d.transcript}`).join("\n");
      const court = c.ecourts ? `Court record (eCourts): status ${c.ecourts.caseStatus ?? ""}, purpose ${c.ecourts.purpose ?? ""}, next hearing ${c.ecourts.nextHearingDate ?? ""}, acts ${c.ecourts.actsAndSections ?? ""}` : "";
      const prompt = `Read every document thoroughly and prepare a case brief for the lawyer.
Case: ${c.title} (${c.area}, ${c.matter_type ?? ""}) for client ${c.clients?.full_name ?? ""}. Court: ${c.court ?? "not yet decided"}.
Facts given by the client: ${c.facts ?? ""}
${transcripts}
${court}
Point out contradictions between documents, limitation or deadline risks, and what is missing to file.`;
      const out = await gemini([{ text: prompt }, ...parts],
        '{"summary": "one paragraph, plain English", "timeline": [{"date": "YYYY-MM-DD or text", "event": "..."}], "issues": ["legal issues"], "likely_provisions": ["Act and section, each marked verify if unsure"], "red_flags": ["contradictions or risks, with the document they come from"], "missing_docs": ["documents still needed"], "deadlines": ["limitation or hearing deadlines"], "next_steps": ["what the lawyer should do next"], "draft_suggestions": ["templates to prepare"]}');
      await admin.from("cases").update({ ai: { ...out, skipped }, ai_at: new Date().toISOString(), summary: out.summary,
        red_flags: out.red_flags ?? c.red_flags, missing_docs: out.missing_docs ?? c.missing_docs }).eq("id", case_id);
      return json({ ok: true, ...out, skipped });
    }
    throw new Error("Unknown action.");
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 400);
  }
});
