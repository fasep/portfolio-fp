/**
 * Cloudflare Worker — Proxy seguro para Anthropic API + Google Sheets
 * Portfolio FP — Felipe Sepúlveda
 *
 * Variables de entorno requeridas:
 *   ANTHROPIC_API_KEY    → sk-ant-api03-...
 *   APP_PASSWORD         → contraseña del dashboard
 *   GOOGLE_CLIENT_EMAIL  → portfolio-fp-reader@portfolio-fp-498320.iam.gserviceaccount.com
 *   GOOGLE_PRIVATE_KEY   → -----BEGIN RSA PRIVATE KEY-----...
 */

const ALLOWED_ORIGIN = '*';
const SPREADSHEET_ID = '1EU3Hr24FOaYQBC3XJAJftZcz6Jmo9iq5cK9IeU_2ulE';

export default {
  async fetch(request, env) {

    // ── CORS preflight ──────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-App-Password, X-Action',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      return respond(405, { error: 'Method not allowed' });
    }

    // ── Verificar contraseña ────────────────────────────────────────
    const password = request.headers.get('X-App-Password');
    if (!password || password !== env.APP_PASSWORD) {
      return respond(401, { error: 'Unauthorized' });
    }

    // ── Routing por acción ──────────────────────────────────────────
    const action = request.headers.get('X-Action') || 'ai';

    if (action === 'ping') {
      return respond(200, { ok: true });
    } else if (action === 'sheets') {
      return handleSheets(request, env);
    } else if (action === 'price') {
      return handlePrice(request, env);
    } else {
      return handleAI(request, env);
    }
  },
};

// ── HANDLER: Google Sheets ──────────────────────────────────────────
async function handleSheets(request, env) {
  try {
    const token = await getGoogleToken(env);

    // Leer Trades
    const tradesRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Trades!A1:S200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const tradesData = await tradesRes.json();

    // Leer Holdings
    const holdingsRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Holdings!A1:J50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const holdingsData = await holdingsRes.json();

    // Leer Dashboard
    const dashRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Dashboard!A1:D30`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const dashData = await dashRes.json();

    // Leer Alertas
    const alertasRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Alertas!A1:J50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const alertasData = await alertasRes.json();

    return new Response(JSON.stringify({
      trades: tradesData.values || [],
      holdings: holdingsData.values || [],
      dashboard: dashData.values || [],
      alertas: alertasData.values || [],
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      },
    });

  } catch (err) {
    return respond(502, { error: 'Sheets error: ' + err.message });
  }
}

// ── HANDLER: Yahoo Finance price ───────────────────────────────────
async function handlePrice(request, env) {
  let body;
  try { body = await request.json(); } catch { return respond(400, { error: 'Invalid JSON' }); }

  const symbol = (body.symbol || '').toUpperCase().trim();
  if (!symbol) return respond(400, { error: 'Missing symbol' });

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return respond(404, { error: 'No data for ' + symbol });

    return new Response(JSON.stringify({
      prev: meta.chartPreviousClose || meta.previousClose,
      curr: meta.regularMarketPrice,
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN }
    });
  } catch (err) {
    return respond(502, { error: 'Price fetch error: ' + err.message });
  }
}

// ── HANDLER: Anthropic AI ───────────────────────────────────────────
async function handleAI(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await anthropicRes.json();

    return new Response(JSON.stringify(data), {
      status: anthropicRes.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      },
    });
  } catch (err) {
    return respond(502, { error: 'Upstream error: ' + err.message });
  }
}

// ── Google JWT Auth ─────────────────────────────────────────────────
async function getGoogleToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payload = `${enc(header)}.${enc(claim)}`;

  // Fix private key newlines
  const privateKey = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(payload)
  );

  const jwt = `${payload}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Token error: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

function pemToBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN.*?-----/g, '').replace(/-----END.*?-----/g, '').replace(/\s/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function respond(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    },
  });
}
