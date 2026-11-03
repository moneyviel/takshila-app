# Takshila

Law chamber portal: lawyer workspace and client portal.

- `index.html`: the whole web app (hosted on GitHub Pages).
- `supabase/functions/ai`: AI case briefs and audio transcription (Gemini).
- `supabase/functions/ecourts`: case status sync from eCourts by CNR.

Data, logins and files live in the Supabase project `takshila` (Mumbai). Secrets (GEMINI_API_KEY, ECOURTS_API_KEY) are stored in Supabase, never in this repo.
