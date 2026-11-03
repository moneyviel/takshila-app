import { admin, caller, cors, isStaff, json } from "./_shared.ts";

const BASE = "https://webapi.ecourtsindia.com";

async function eci(path: string, init: RequestInit = {}) {
  const key = Deno.env.get("ECOURTS_API_KEY");
  if (!key) throw new Error("eCourts sync is not switched on yet: the ECOURTS_API_KEY secret is missing.");
  const res = await fetch(BASE + path, { ...init, headers: { ...(init.headers ?? {}), Authorization: "Bearer " + key, "Content-Type": "application/json" } });
  const text = await res.text();
  let body: any = null; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`eCourts ${res.status}: ${body?.error?.message ?? body?.message ?? body?.error ?? text.slice(0, 200)}`);
  return body;
}

const day = (s?: string | null) => (s ? String(s).slice(0, 10) : null);

async function syncOne(caseRow: { id: string; cnr: string; title: string }) {
  const cnr = caseRow.cnr.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]{4}\d{12}$/.test(cnr)) throw new Error(`${caseRow.title}: CNR must be 16 characters, 4 letters then 12 digits.`);
  let body;
  try { body = await eci(`/api/partner/case/${cnr}`); }
  catch (e) {
    // Not in their index yet: ask for a live fetch from eCourts, then the lawyer can sync again in a minute
    await eci(`/api/partner/case/${cnr}/refresh`, { method: "POST" }).catch(() => {});
    throw new Error(`${caseRow.title}: ${(e as Error).message}. A live fetch from eCourts has been requested; try Sync again in a minute.`);
  }
  const d = body?.data?.courtCaseData ?? {};
  const info = body?.data?.entityInfo ?? {};
  const next = day(d.nextHearingDate) ?? day(info.nextDateOfHearing);
  const snap = {
    cnr, caseStatus: d.caseStatus ?? null, purpose: d.purpose ?? null, courtName: d.courtName ?? null, courtNo: d.courtNo ?? null,
    judges: d.judges ?? [], caseNumber: d.caseNumber ?? d.registrationNumber ?? null, filingDate: day(d.filingDate), registrationDate: day(d.registrationDate),
    lastHearingDate: day(d.lastHearingDate) ?? day(info.lastDateOfHearing), nextHearingDate: next, decisionDate: day(d.decisionDate),
    disposalType: d.disposalType ?? null, petitioners: d.petitioners ?? [], respondents: d.respondents ?? [],
    petitionerAdvocates: d.petitionerAdvocates ?? [], respondentAdvocates: d.respondentAdvocates ?? [], actsAndSections: d.actsAndSections ?? null,
    orders: [...(d.interimOrders ?? []).map((o: any) => ({ date: day(o.orderDate), type: o.description ?? "Interim order" })),
             ...(d.judgmentOrders ?? []).map((o: any) => ({ date: day(o.orderDate), type: o.orderType ?? "Judgment" }))].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 15),
    dateModified: info.dateModified ?? null,
  };
  const upd: Record<string, unknown> = { cnr, ecourts: snap, ecourts_synced_at: new Date().toISOString() };
  if (next) upd.next_date = next;
  if (d.purpose) upd.stage = d.purpose;
  if (d.courtName) upd.court = d.courtName + (d.courtNo ? `, Court ${d.courtNo}` : "");
  if (String(d.caseStatus ?? "").toUpperCase().includes("DISPOS")) { upd.status = "closed"; upd.closed_on = day(d.decisionDate) ?? new Date().toISOString().slice(0, 10); upd.outcome = d.disposalType ?? "Disposed"; }
  await admin.from("cases").update(upd).eq("id", caseRow.id);
  const rows = (d.historyOfCaseHearings ?? []).filter((h: any) => h.hearingDate || h.businessOnDate).map((h: any) => ({
    case_id: caseRow.id, hearing_date: day(h.hearingDate ?? h.businessOnDate), purpose: h.purposeOfListing ?? "Hearing",
    outcome_note: h.judge ? `Before ${h.judge}` : null, source: "ecourts" }));
  if (next) rows.push({ case_id: caseRow.id, hearing_date: next, purpose: d.purpose ?? "Next hearing", outcome_note: null, source: "ecourts" });
  if (rows.length) await admin.from("hearings").upsert(rows, { onConflict: "case_id,hearing_date,source", ignoreDuplicates: false });
  return { title: caseRow.title, ...snap, hearings: rows.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const me = await caller(req);
    if (!isStaff(me)) throw new Error("Only the chamber can sync with eCourts.");
    const { action, case_id, cnr } = await req.json();
    if (action === "sync") {
      if (cnr) await admin.from("cases").update({ cnr }).eq("id", case_id);
      const { data: c } = await admin.from("cases").select("id, cnr, title").eq("id", case_id).single();
      if (!c?.cnr) throw new Error("Add the case's CNR number first.");
      return json({ ok: true, result: await syncOne(c as any) });
    }
    if (action === "sync_all") {
      const { data: list } = await admin.from("cases").select("id, cnr, title").neq("status", "closed").not("cnr", "is", null);
      const results = [], errors = [];
      for (const c of list ?? []) { try { results.push(await syncOne(c as any)); } catch (e) { errors.push((e as Error).message); } }
      return json({ ok: true, synced: results.length, errors });
    }
    throw new Error("Unknown action.");
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 400);
  }
});
