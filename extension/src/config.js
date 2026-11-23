// Build-time configuration. Agents never enter these — they only paste their personal token.
// The Supabase URL is public (not a secret); access is controlled by each agent's token.
export const SUPABASE_URL = 'https://yzcjawjncjvqgutpyejm.supabase.co';
export const INGEST_URL = `${SUPABASE_URL}/functions/v1/ingest`;
export const DASHBOARD_URL = 'https://coco-voice-dashboard.vercel.app';
export const TOKEN_RE = /^coco_[0-9a-f]{48}$/;
