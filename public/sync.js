// Cross-device sync over Supabase's REST API. No client library: it is one
// table, two verbs, and plain fetch keeps the app dependency-free.
//
// localStorage stays the source of truth on each device. Sync is an overlay, so
// the app keeps working unchanged when the project is paused or you are offline.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const CODE_KEY = 'bt.sync.code';
const SEEN_KEY = 'bt.sync.seen';
const TABLE = 'bet_sync';
const PULL_MS = 10000;

const randomCode = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
};

export function createSync({ onRemote }) {
  const enabled = !!(SUPABASE_URL && SUPABASE_KEY);
  let code = localStorage.getItem(CODE_KEY) || '';
  let lastSeen = Number(localStorage.getItem(SEEN_KEY) || 0);
  let status = enabled ? 'idle' : 'not configured';
  let pushTimer = null;
  let pullTimer = null;

  if (enabled && !code) { code = randomCode(); localStorage.setItem(CODE_KEY, code); }

  const headers = () => ({
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  });

  const url = (suffix = '') => `${SUPABASE_URL}/rest/v1/${TABLE}${suffix}`;

  async function pull() {
    if (!enabled || !code) return;
    try {
      const res = await fetch(`${url()}?id=eq.${encodeURIComponent(code)}&select=payload,updated_at`, { headers: headers() });
      if (!res.ok) throw new Error(`pull ${res.status}`);
      const rows = await res.json();
      status = 'connected';
      if (!rows.length) return;
      const stamp = new Date(rows[0].updated_at).getTime();
      if (stamp > lastSeen && Array.isArray(rows[0].payload?.bets)) {
        lastSeen = stamp;
        localStorage.setItem(SEEN_KEY, String(stamp));
        onRemote(rows[0].payload.bets);
      }
    } catch (err) {
      status = `offline (${err.message})`;
    }
  }

  async function pushNow(bets) {
    if (!enabled || !code) return;
    try {
      const res = await fetch(`${url()}?on_conflict=id`, {
        method: 'POST',
        headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ id: code, payload: { bets }, updated_at: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(`push ${res.status}`);
      const rows = await res.json();
      // Remember our own write so the next pull does not echo it back.
      if (rows[0]?.updated_at) {
        lastSeen = new Date(rows[0].updated_at).getTime();
        localStorage.setItem(SEEN_KEY, String(lastSeen));
      }
      status = 'connected';
    } catch (err) {
      status = `offline (${err.message})`;
    }
  }

  return {
    start() {
      if (!enabled) return;
      pull();
      clearInterval(pullTimer);
      pullTimer = setInterval(() => { if (!document.hidden) pull(); }, PULL_MS);
    },
    // Debounced so a burst of edits is one write.
    push(bets) {
      if (!enabled) return;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => pushNow(bets), 600);
    },
    setCode(next) {
      code = next;
      lastSeen = 0;
      localStorage.setItem(CODE_KEY, next);
      localStorage.setItem(SEEN_KEY, '0');
      pull();
    },
    info() { return { configured: enabled, code, status }; },
  };
}
