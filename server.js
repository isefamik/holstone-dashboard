const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { AsyncLocalStorage } = require('async_hooks');
const { Resend } = require('resend');
require('dotenv').config();
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { MercadoPagoConfig, PreApproval, WebhookSignatureValidator } = require('mercadopago');
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

const MP_PRICES = {
  starter: { mensual: 399,     anual: 3830.40 },
  growth:  { mensual: 899,     anual: 8630.40 },
  scale:   { mensual: 1999,    anual: 19190.40 },
};

const STRIPE_PRICES = {
  starter: { mensual: 'price_1TlILo3hvybH0Z3nEOY03GZb', anual: 'price_1TlILn3hvybH0Z3njFBuybrS' },
  growth:  { mensual: 'price_1TlILr3hvybH0Z3nyeBOILcQ', anual: 'price_1TlILr3hvybH0Z3nQ3fzjAFl' },
  scale:   { mensual: 'price_1TlILq3hvybH0Z3n3xEjZR9q', anual: 'price_1TlILq3hvybH0Z3nKAaEtAG0' },
};

const requestCtx = new AsyncLocalStorage();

// ── Store de sesiones sobre Supabase JS (sin conexión pg directa) ────────────
class SupabaseSessionStore extends session.Store {
  async get(sid, cb) {
    try {
      const { data } = await supabase.from('sessions').select('sess')
        .eq('sid', sid).gt('expire', new Date().toISOString()).maybeSingle();
      cb(null, data?.sess ?? null);
    } catch (e) { cb(e); }
  }
  async set(sid, sess, cb) {
    try {
      const exp = sess.cookie?.expires
        ? new Date(sess.cookie.expires)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await supabase.from('sessions').upsert({ sid, sess, expire: exp.toISOString() });
      cb(null);
    } catch (e) { cb(e); }
  }
  async destroy(sid, cb) {
    try {
      await supabase.from('sessions').delete().eq('sid', sid);
      cb(null);
    } catch (e) { cb(e); }
  }
  async touch(sid, sess, cb) {
    try {
      const exp = sess.cookie?.expires
        ? new Date(sess.cookie.expires)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await supabase.from('sessions').update({ expire: exp.toISOString() }).eq('sid', sid);
      cb(null);
    } catch (e) { cb(e); }
  }
}

const app = express();
app.use(cors());

// POST /api/stripe-webhook — debe ir ANTES de express.json() para recibir raw body
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { tenant_id, tier, billing_cycle } = session.metadata || {};
      if (tenant_id && tier) {
        await supabase.from('subscriptions').upsert({
          tenant_id,
          tier,
          billing_cycle:          billing_cycle || 'mensual',
          precio_mxn:             session.amount_total ? session.amount_total / 100 : null,
          metodo_pago:            'stripe',
          status:                 'activo',
          stripe_customer_id:     session.customer,
          stripe_subscription_id: session.subscription,
          updated_at:             new Date().toISOString(),
        }, { onConflict: 'tenant_id' });
      }
    } else if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const subId   = invoice.subscription;
      if (subId && invoice.lines?.data?.[0]?.period?.end) {
        const proximaFecha = new Date(invoice.lines.data[0].period.end * 1000).toISOString();
        await supabase.from('subscriptions')
          .update({ proxima_fecha_pago: proximaFecha, updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subId);
      }
    } else if (event.type === 'invoice.payment_failed') {
      const subId = event.data.object.subscription;
      if (subId) {
        await supabase.from('subscriptions')
          .update({ status: 'pendiente', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subId);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await supabase.from('subscriptions')
        .update({ status: 'suspendido', updated_at: new Date().toISOString() })
        .eq('stripe_subscription_id', sub.id);
    }
  } catch (err) {
    console.error('Stripe webhook processing error:', err);
  }

  res.json({ received: true });
});

// POST /api/mercadopago-webhook — antes de express.json() global; usa su propio parser
app.post('/api/mercadopago-webhook', express.json(), async (req, res) => {
  if (process.env.MP_WEBHOOK_SECRET) {
    try {
      WebhookSignatureValidator.validate({
        xSignature: req.headers['x-signature'],
        xRequestId: req.headers['x-request-id'],
        dataId:     req.body?.data?.id,
        secret:     process.env.MP_WEBHOOK_SECRET,
      });
    } catch (err) {
      console.warn('[mp-webhook] Firma inválida:', err.message);
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const { action, data } = req.body || {};

  try {
    if (action === 'subscription_preapproval' && data?.id) {
      const preapprovalClient = new PreApproval(mpClient);
      const details = await preapprovalClient.get({ id: data.id });
      const extRef  = details.external_reference ? JSON.parse(details.external_reference) : null;

      if (extRef?.tenant_id) {
        if (details.status === 'authorized') {
          await supabase.from('subscriptions').upsert({
            tenant_id:         extRef.tenant_id,
            tier:              extRef.tier,
            billing_cycle:     extRef.billing_cycle || 'mensual',
            precio_mxn:        details.auto_recurring?.transaction_amount,
            metodo_pago:       'mercadopago',
            status:            'activo',
            mp_preapproval_id: data.id,
            updated_at:        new Date().toISOString(),
          }, { onConflict: 'tenant_id' });
        } else if (details.status === 'cancelled') {
          await supabase.from('subscriptions')
            .update({ status: 'suspendido', updated_at: new Date().toISOString() })
            .eq('mp_preapproval_id', data.id);
        } else if (details.status === 'paused') {
          await supabase.from('subscriptions')
            .update({ status: 'pendiente', updated_at: new Date().toISOString() })
            .eq('mp_preapproval_id', data.id);
        }
      }
    }
  } catch (err) {
    console.error('[mp-webhook] Error:', err.message);
  }

  res.json({ received: true });
});

app.use(express.json());

// Landing en "/" — debe ir antes de express.static para que no lo intercepte el index.html por defecto
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));

app.use(express.static(path.join(__dirname, 'public')));

// ── Sesiones ─────────────────────────────────────────────────────────────────
app.set('trust proxy', 1); // Render/Heroku terminan SSL en el proxy — necesario para cookies secure
app.use(session({
  store: new SupabaseSessionStore(),
  secret: process.env.SESSION_SECRET || 'holstone-dev-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días; rolling: true reinicia el contador con cada request
  },
}));

const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const SELLER_ID = process.env.SELLER_ID;

// ── Multi-tenant helpers ─────────────────────────────────────────────────────

class TokenExpiredError extends Error {
  constructor(tenantId) {
    super('TOKEN_EXPIRED');
    this.name = 'TokenExpiredError';
    this.tenantId = tenantId;
  }
}

const tenantTokenCache = new Map(); // tenantId → { access_token, refresh_token, expires_at }

function getSellerId() {
  return requestCtx.getStore()?.tenant?.seller_id || SELLER_ID;
}

function getAdvertiserId() {
  return requestCtx.getStore()?.tenant?.advertiser_id || ADVERTISER_ID;
}

async function getTenantConfig(tenantId) {
  const { data, error } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle();
  if (error || !data) return null;
  return data;
}

async function refreshTenantToken(tenant) {
  const cached = tenantTokenCache.get(tenant.id) || {};

  const attemptRefresh = async (refreshToken) => {
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', tenant.ml_client_id);
    params.append('client_secret', tenant.ml_client_secret);
    params.append('refresh_token', refreshToken);
    return axios.post('https://api.mercadolibre.com/oauth/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  };

  let response;
  const primaryToken = cached.refresh_token || tenant.ml_refresh_token;
  try {
    response = await attemptRefresh(primaryToken);
  } catch (e) {
    const status = e.response?.status;
    console.error(`[token] Refresh falló para tenant ${tenant.id}:`, e.response?.data || e.message);
    if (status >= 400 && status < 500) {
      // El refresh_token en cache puede estar obsoleto (rotado externamente o por
      // una instancia paralela). Intenta una vez más con el que esté en Supabase.
      const { data: fresh } = await supabase.from('tenant_tokens')
        .select('refresh_token').eq('tenant_id', tenant.id).maybeSingle();
      if (fresh?.refresh_token && fresh.refresh_token !== primaryToken) {
        console.log(`[token] Reintentando con refresh_token de Supabase para tenant ${tenant.id}`);
        try {
          response = await attemptRefresh(fresh.refresh_token);
          // Actualizar cache con el token correcto
          tenantTokenCache.set(tenant.id, { ...cached, refresh_token: fresh.refresh_token });
        } catch (e2) {
          if (e2.response?.status >= 400 && e2.response?.status < 500) throw new TokenExpiredError(tenant.id);
          throw e2;
        }
      } else {
        throw new TokenExpiredError(tenant.id);
      }
    } else {
      throw e; // 5xx o red → error transitorio
    }
  }

  const newToken = {
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token || cached.refresh_token,
    expires_at: Date.now() + ((response.data.expires_in - 300) * 1000),
  };
  tenantTokenCache.set(tenant.id, newToken);

  const { error: upsertErr } = await supabase.from('tenant_tokens').upsert({
    tenant_id: tenant.id,
    access_token: newToken.access_token,
    refresh_token: newToken.refresh_token,
    expires_at: newToken.expires_at,
    updated_at: new Date().toISOString(),
  });
  if (upsertErr) console.error(`[token] Supabase upsert falló para tenant ${tenant.id}:`, upsertErr.message);

  console.log(`[token] Renovado para tenant ${tenant.id}, expira: ${new Date(newToken.expires_at).toLocaleString('es-MX')}`);
  return newToken.access_token;
}

async function getTenantToken(tenant) {
  let cached = tenantTokenCache.get(tenant.id);
  if (!cached) {
    const { data } = await supabase.from('tenant_tokens').select('*').eq('tenant_id', tenant.id).maybeSingle();
    if (data) {
      cached = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Number(data.expires_at) };
      tenantTokenCache.set(tenant.id, cached);
    }
  }
  if (!cached || Date.now() >= cached.expires_at) return refreshTenantToken(tenant);
  return cached.access_token;
}

// ── Token persistence (Supabase) ────────────────────────────────────────────

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TOKEN_ROW_ID = 'ml_token';

const shipmentCache = new Map();              // id → objeto shipment completo; nunca expira (shipments son inmutables)
let costosCache = null;                       // Array de costos_productos
let costosCacheTime = 0;
const COSTOS_TTL = 30 * 60 * 1000;           // 30 minutos
const billingCache = new Map();               // "YYYY-M" → { data, ts }; meses pasados: indefinido, mes actual: 1h
const reasonLabelCache = new Map();           // reason_id → detail label del endpoint ML

async function loadTokenFromSupabase() {
  try {
    const { data, error } = await supabase.from('tokens').select('*').eq('id', TOKEN_ROW_ID).maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('Error leyendo token de Supabase:', e.message);
    return null;
  }
}

async function saveTokenToSupabase(data) {
  try {
    const { error } = await supabase.from('tokens').upsert({
      id: TOKEN_ROW_ID,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      updated_at: new Date().toISOString()
    });
    if (error) throw error;
  } catch (e) {
    console.error('Error guardando token en Supabase:', e.message);
  }
}

// ── Snapshots diarios de stock/publicaciones (para comparativas) ───────────

async function saveStockSnapshot(totalPiezas, totalPublicaciones) {
  try {
    const { error } = await supabase.from('stock_snapshots').upsert({
      date: today(),
      total_piezas: totalPiezas,
      total_publicaciones: totalPublicaciones
    });
    if (error) throw error;
  } catch (e) {
    console.error('Error guardando snapshot de stock:', e.message);
  }
}

async function getStockSnapshot(date) {
  try {
    const { data, error } = await supabase.from('stock_snapshots').select('*').eq('date', date).maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('Error leyendo snapshot de stock:', e.message);
    return null;
  }
}

// Placeholder hasta que initTokens() cargue el valor real desde Supabase
let tokenData = {
  access_token: process.env.ML_TOKEN,
  refresh_token: process.env.ML_REFRESH_TOKEN,
  expires_at: Date.now() + (5 * 60 * 60 * 1000)
};

async function refreshToken() {
  try {
    console.log('Renovando token de ML...');
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    // Always use the most current refresh_token (may have rotated)
    params.append('refresh_token', tokenData.refresh_token || process.env.ML_REFRESH_TOKEN);
    const response = await axios.post('https://api.mercadolibre.com/oauth/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    tokenData.access_token = response.data.access_token;
    tokenData.refresh_token = response.data.refresh_token || tokenData.refresh_token;
    tokenData.expires_at = Date.now() + ((response.data.expires_in - 300) * 1000);
    await saveTokenToSupabase(tokenData);
    console.log('Token renovado y guardado en Supabase, expira:', new Date(tokenData.expires_at).toLocaleString('es-MX'));
    return tokenData.access_token;
  } catch (e) {
    console.error('Error renovando token:', e.response?.data || e.message);
    return tokenData.access_token;
  }
}

async function getToken() {
  if (Date.now() >= tokenData.expires_at) {
    return await refreshToken();
  }
  return tokenData.access_token;
}

async function initTokens() {
  const fromDb = await loadTokenFromSupabase();
  if (fromDb && fromDb.access_token) {
    tokenData = {
      access_token: fromDb.access_token,
      refresh_token: fromDb.refresh_token,
      expires_at: Number(fromDb.expires_at)
    };
    console.log('Token cargado desde Supabase, expira:', new Date(tokenData.expires_at).toLocaleString('es-MX'));
  } else {
    console.log('No hay token en Supabase, usando variables de entorno');
    await saveTokenToSupabase(tokenData);
  }

  if (Date.now() >= tokenData.expires_at - 10 * 60 * 1000) {
    await refreshToken();
  } else {
    console.log('Token vigente, no es necesario renovar al arrancar');
  }

  // Legacy Holstone: refresh cada 5.5h
  setInterval(refreshToken, 5.5 * 60 * 60 * 1000);

  // Tenants multi-tenant: refresh proactivo escalonado
  // Distribución: cada tenant refresca cada TENANT_REFRESH_INTERVAL ms,
  // pero arranca con un delay de (índice * TENANT_STAGGER_MS) para no
  // golpear la API de ML todos al mismo tiempo al reiniciar el servidor.
  // Con 500 tenants: 500 × 100s = 50.000s ≈ 13.8h de distribución de arranque,
  // con refreshes escalonados en ventanas de 5.5h → ≤90 req/h en el peor caso.
  const TENANT_REFRESH_INTERVAL = 5.5 * 60 * 60 * 1000; // 5.5h
  const TENANT_STAGGER_MS = 100 * 1000;                  // 100s entre tenants

  // La fuente de verdad es tenant_tokens: cualquier tenant con un token guardado
  // debe renovarse proactivamente, sin importar si tiene stripe_subscription_id o no.
  try {
    const { data: tokenRows, error } = await supabase
      .from('tenant_tokens')
      .select('tenant_id, access_token, refresh_token, expires_at, tenants(id, name, ml_client_id, ml_client_secret)');
    if (error) throw error;
    if (!tokenRows || tokenRows.length === 0) {
      console.log('[token] No hay tenant_tokens registrados, omitiendo refresh proactivo');
      return;
    }

    // Precalentar tenantTokenCache con los tokens de Supabase
    for (const row of tokenRows) {
      tenantTokenCache.set(row.tenant_id, {
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        expires_at: Number(row.expires_at),
      });
    }

    const tenantNames = tokenRows.map(r => r.tenants?.name || r.tenant_id).join(', ');
    console.log(`[token] Programando refresh proactivo para ${tokenRows.length} tenant(s): ${tenantNames}`);

    tokenRows.forEach((row, idx) => {
      const tenant = { ...row.tenants, id: row.tenant_id };
      const delay = idx * TENANT_STAGGER_MS;

      const scheduleRefresh = () => {
        refreshTenantToken(tenant).catch(e => {
          if (e.name === 'TokenExpiredError') {
            console.warn(`[token] refresh_token vencido para tenant "${tenant.name || tenant.id}" — requiere reconexión manual`);
          } else {
            console.error(`[token] Error proactivo para tenant "${tenant.name || tenant.id}":`, e.message);
          }
        });
      };

      // Primer refresh: arranca escalonado
      setTimeout(() => {
        scheduleRefresh();
        // Refreshes subsecuentes cada 5.5h
        setInterval(scheduleRefresh, TENANT_REFRESH_INTERVAL);
      }, delay);
    });
  } catch (e) {
    console.error('[token] Error cargando tenant_tokens para refresh proactivo:', e.message);
  }
}

initTokens();

// Limpia caché de billing al arrancar (fuerza recalculo con lógica actual)
billingCache.clear();
supabase.from('billing_cache').delete().neq('period_key', 'x')
  .then(() => console.log('billing_cache limpiado en Supabase'))
  .catch(e => console.warn('No se pudo limpiar billing_cache:', e.message));

// ── JOB NOCTURNO: pre-calentar billing cache a las 2am hora México ────────
cron.schedule('0 2 * * *', async () => {
  const now = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short'
  }).format(new Date());
  console.log(`[cron-billing] ${now} — Iniciando pre-calentamiento de billing cache...`);
  try {
    const mxDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
    const [yr, mo] = mxDate.split('-').map(Number);
    let pm = mo - 1, py = yr;
    if (pm === 0) { pm = 12; py--; }
    await Promise.all([
      getBillingResumen(mo, yr).then(() => console.log(`[cron-billing] Mes actual ${yr}-${mo} guardado en caché`)),
      getBillingResumen(pm, py).then(() => console.log(`[cron-billing] Mes anterior ${py}-${pm} guardado en caché`)),
    ]);
    console.log('[cron-billing] Pre-calentamiento completado');
  } catch (e) {
    console.error('[cron-billing] Error:', e.message);
  }
}, { timezone: 'America/Mexico_City' });

function today() {
  // en-CA produce el formato YYYY-MM-DD directamente
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}

async function mlGet(url, params = {}) {
  const ctx = requestCtx.getStore();
  const isTenant = !!ctx?.tenant;
  const fetchFreshToken = () => isTenant ? refreshTenantToken(ctx.tenant) : refreshToken();

  const token = isTenant ? await getTenantToken(ctx.tenant) : await getToken();
  try {
    const r = await axios.get(url, { params, headers: { Authorization: `Bearer ${token}` } });
    return r.data;
  } catch (e) {
    if (e.response?.status === 401) {
      // Token expirado según ML → forzar refresh y reintentar una vez
      const freshToken = await fetchFreshToken();
      const r = await axios.get(url, { params, headers: { Authorization: `Bearer ${freshToken}` } });
      return r.data;
    }
    throw e;
  }
}

// ML visits API puede devolver array [{date,total}] o {total_visits, results:[]}
function parseVisitTotal(data) {
  if (Array.isArray(data)) return data.reduce((s, r) => s + (r.total || 0), 0);
  return data?.total_visits ?? 0;
}
function parseVisitResults(data) {
  return Array.isArray(data) ? data : (data?.results || []);
}

async function getReasonLabel(reasonId) {
  if (!reasonId) return reasonId;
  if (reasonLabelCache.has(reasonId)) return reasonLabelCache.get(reasonId);
  try {
    const data = await mlGet(`https://api.mercadolibre.com/post-purchase/v1/claims/reasons/${reasonId}`);
    const label = data.detail || data.name || reasonId;
    reasonLabelCache.set(reasonId, label);
    return label;
  } catch {
    reasonLabelCache.set(reasonId, reasonId);
    return reasonId;
  }
}

async function mlGetAds(url, params = {}) {
  const ctx = requestCtx.getStore();
  const isTenant = !!ctx?.tenant;
  const fetchFreshToken = () => isTenant ? refreshTenantToken(ctx.tenant) : refreshToken();

  const token = isTenant ? await getTenantToken(ctx.tenant) : await getToken();
  try {
    const r = await axios.get(url, { params, headers: { Authorization: `Bearer ${token}`, 'api-version': '2' } });
    return r.data;
  } catch (e) {
    if (e.response?.status === 401) {
      const freshToken = await fetchFreshToken();
      const r = await axios.get(url, { params, headers: { Authorization: `Bearer ${freshToken}`, 'api-version': '2' } });
      return r.data;
    }
    throw e;
  }
}

function toRange(dateFrom, dateTo) {
  return {
    from: `${dateFrom}T00:00:00.000-06:00`,
    to: `${dateTo}T23:59:59.000-06:00`
  };
}

function daysAgo(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date(today() + 'T00:00:00');
  return Math.round((now - d) / 86400000);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getPeriodRange(period, year, month, date, rangeFrom, rangeTo) {
  const fechaHoy = today();
  if (period === 'day') {
    const fecha = date || fechaHoy;
    const fechaAnt = addDays(fecha, -1);
    return { from: fecha, to: fecha, fromAnt: fechaAnt, toAnt: fechaAnt, label: fecha, days: 1 };
  }
  if (period === 'range') {
    const from = rangeFrom;
    const to = rangeTo;
    const days = Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;
    const toAnt = addDays(from, -1);
    const fromAnt = addDays(from, -days);
    return { from, to, fromAnt, toAnt, label: `${from} a ${to}`, days };
  }
  if (period === '7days') {
    return {
      from: dateNDaysAgo(6), to: fechaHoy,
      fromAnt: dateNDaysAgo(13), toAnt: dateNDaysAgo(7),
      label: 'Últimos 7 días', days: 7
    };
  }
  if (period === '30days') {
    return {
      from: dateNDaysAgo(29), to: fechaHoy,
      fromAnt: dateNDaysAgo(59), toAnt: dateNDaysAgo(30),
      label: 'Últimos 30 días', days: 30
    };
  }
  if (period === 'month') {
    const now = new Date();
    const y = parseInt(year) || now.getFullYear();
    const m = parseInt(month) || (now.getMonth() + 1);
    const lastDay = new Date(y, m, 0).getDate();
    const isCurrentMonth = y === now.getFullYear() && m === (now.getMonth() + 1);
    const dayTo = isCurrentMonth ? now.getDate() : lastDay;
    const from = `${y}-${String(m).padStart(2, '0')}-01`;
    const to = `${y}-${String(m).padStart(2, '0')}-${String(dayTo).padStart(2, '0')}`;
    let pm = m - 1, py = y;
    if (pm === 0) { pm = 12; py -= 1; }
    const prevLastDay = new Date(py, pm, 0).getDate();
    const fromAnt = `${py}-${String(pm).padStart(2, '0')}-01`;
    const toAnt = `${py}-${String(pm).padStart(2, '0')}-${String(prevLastDay).padStart(2, '0')}`;
    return { from, to, fromAnt, toAnt, label: `${y}-${String(m).padStart(2, '0')}`, days: dayTo };
  }
  // hoy (default)
  const ayer = dateNDaysAgo(1);
  return { from: fechaHoy, to: fechaHoy, fromAnt: ayer, toAnt: ayer, label: 'Hoy', days: 1 };
}

async function fetchPaidOrders(from, to) {
  let allOrders = [];
  let offset = 0;
  let total = 1;
  while (offset < total) {
    const d = await mlGet('https://api.mercadolibre.com/orders/search', {
      seller: getSellerId(), 'order.status': 'paid',
      'order.date_created.from': from, 'order.date_created.to': to,
      limit: 50, offset
    });
    total = d.paging.total;
    allOrders = allOrders.concat(d.results);
    offset += 50;
  }
  return allOrders;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'No autenticado' });
  try {
    const tenant = await getTenantConfig(req.session.tenantId);
    if (!tenant || !tenant.active) return res.status(401).json({ error: 'Sesión inválida' });
    req.tenant = tenant;
    requestCtx.run({ tenant }, next);
  } catch (e) {
    if (e.name === 'TokenExpiredError') return res.status(401).json({ error: 'TOKEN_EXPIRED' });
    res.status(500).json({ error: e.message });
  }
}

// Protege todas las rutas /api/* excepto login, logout y contact-enterprise (público desde la landing)
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout' || req.path === '/contact-enterprise') return next();
  requireAuth(req, res, next);
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email y password requeridos' });
    const { data: user } = await supabase
      .from('users')
      .select('id, email, password_hash, tenant_id, role, active')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();
    if (!user || !user.active) return res.status(401).json({ error: 'Credenciales inválidas' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });
    req.session.userId = user.id;
    req.session.tenantId = user.tenant_id;
    req.session.role = user.role;
    res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Error al cerrar sesión' });
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  res.json({
    userId: req.session.userId,
    tenantId: req.session.tenantId,
    role: req.session.role,
    tenant: { id: req.tenant.id, name: req.tenant.name, seller_id: req.tenant.seller_id || '' },
  });
});

app.post('/api/admin/crear-usuario', async (req, res) => {
  try {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
    const { email, password, role = 'viewer' } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email y password requeridos' });
    const password_hash = await bcrypt.hash(password, 12);
    const { data, error } = await supabase.from('users').insert({
      email: email.toLowerCase().trim(),
      password_hash,
      tenant_id: req.session.tenantId,
      role,
      active: true,
    }).select('id, email, role').single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, user: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Ventas ───────────────────────────────────────────────────────────────────

app.get('/api/ventas-hoy', async (req, res) => {
  try {
    const fecha = today();
    const from = `${fecha}T00:00:00.000-06:00`;
    const to = `${fecha}T23:59:59.000-06:00`;
    console.log('[ventas-hoy] from:', from, 'to:', to);

    const fechaAyer = dateNDaysAgo(1);
    const fromAyer = `${fechaAyer}T00:00:00.000-06:00`;
    const toAyer = `${fechaAyer}T23:59:59.000-06:00`;

    const [allOrders, ordersAyer] = await Promise.all([
      fetchPaidOrders(from, to),
      fetchPaidOrders(fromAyer, toAyer)
    ]);

    const total = allOrders.length;
    const ventaBruta = allOrders.reduce((s, o) => s + o.total_amount, 0);
    const unidades = allOrders.reduce((s, o) => s + o.order_items.reduce((ss, i) => ss + i.quantity, 0), 0);
    const precioLista = allOrders.reduce((s, o) => s + o.order_items.reduce((ss, i) => ss + i.gross_price, 0), 0);

    const ordenesAyer = ordersAyer.length;
    const ventaBrutaAyer = ordersAyer.reduce((s, o) => s + o.total_amount, 0);
    const unidadesAyer = ordersAyer.reduce((s, o) => s + o.order_items.reduce((ss, i) => ss + i.quantity, 0), 0);

    const byProduct = {};
    allOrders.forEach(o => {
      o.order_items.forEach(i => {
        const t = i.item.title;
        if (!byProduct[t]) byProduct[t] = { revenue: 0, units: 0, orders: 0 };
        byProduct[t].revenue += o.total_amount;
        byProduct[t].units += i.quantity;
        byProduct[t].orders += 1;
      });
    });
    const top = Object.entries(byProduct).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 20).map(([title, v]) => ({ title, ...v }));
    res.json({
      ordenes: total, ventaBruta, precioLista, descuentos: precioLista - ventaBruta, unidades,
      ticketPromedio: total > 0 ? ventaBruta / total : 0, top,
      ventaBrutaAyer, ordenesAyer, unidadesAyer
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── VENTAS EN VIVO ──────────────────────────────────────────────────────────
app.get('/api/ventas-live', async (req, res) => {
  try {
    const fecha     = today();
    const fechaAyer = dateNDaysAgo(1);
    const fromHoy   = `${fecha}T00:00:00.000-06:00`;
    const toHoy     = `${fecha}T23:59:59.000-06:00`;
    const fromAyer  = `${fechaAyer}T00:00:00.000-06:00`;
    const toAyer    = `${fechaAyer}T23:59:59.000-06:00`;

    // Fetch hoy y ayer en paralelo
    const [ordersHoy, ordersAyer] = await Promise.all([
      fetchPaidOrders(fromHoy, toHoy),
      fetchPaidOrders(fromAyer, toAyer),
    ]);

    // Totales de hoy
    const total_hoy     = ordersHoy.reduce((s, o) => s + o.total_amount, 0);
    const ordenes_hoy   = ordersHoy.length;
    const unidades_hoy  = ordersHoy.reduce((s, o) => s + o.order_items.reduce((ss, i) => ss + i.quantity, 0), 0);
    const ticket_promedio = ordenes_hoy > 0 ? total_hoy / ordenes_hoy : 0;

    // Helper: hora en CDMX de un date string
    const hourMX = dateStr => parseInt(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Mexico_City' }).format(new Date(dateStr))
    );

    // Ventas por hora: 24 buckets
    const ventas_por_hora = Array(24).fill(0);
    ordersHoy.forEach(o => { ventas_por_hora[hourMX(o.date_created)] += o.total_amount; });

    const ayer_por_hora = Array(24).fill(0);
    ordersAyer.forEach(o => { ayer_por_hora[hourMX(o.date_created)] += o.total_amount; });

    // Ayer hasta la hora actual (para comparativa)
    const horaActual = hourMX(new Date().toISOString());
    const comparativa_ayer = ayer_por_hora.slice(0, horaActual + 1).reduce((s, v) => s + v, 0);

    // Últimas 5 órdenes (más recientes primero)
    const sorted = [...ordersHoy].sort((a, b) => new Date(b.date_created) - new Date(a.date_created));
    const ultimas_5_ordenes = sorted.slice(0, 5).map(o => {
      const oi = o.order_items[0];
      return {
        id:           o.id,
        titulo:       oi?.item?.title || '',
        item_id:      oi?.item?.id   || null,
        monto:        o.total_amount,
        fecha:        o.date_created,
        minutos_atras: Math.max(0, Math.round((Date.now() - new Date(o.date_created)) / 60000)),
      };
    });
    const ultima_orden = ultimas_5_ordenes[0] || null;

    // Top 5 productos por monto
    const byItem = {};
    ordersHoy.forEach(o => o.order_items.forEach(i => {
      const id = i.item.id;
      if (!byItem[id]) byItem[id] = { item_id: id, titulo: i.item.title, ordenes: 0, monto: 0, unidades: 0 };
      byItem[id].ordenes  += 1;
      byItem[id].monto    += (i.unit_price || 0) * (i.quantity || 1);
      byItem[id].unidades += i.quantity || 1;
    }));
    const top_productos_hoy = Object.values(byItem)
      .sort((a, b) => b.monto - a.monto)
      .slice(0, 5);

    // Stock + thumbnail para los top 5
    if (top_productos_hoy.length) {
      try {
        const ids = top_productos_hoy.map(p => p.item_id).join(',');
        const det = await mlGet(`https://api.mercadolibre.com/items?ids=${ids}&attributes=id,available_quantity,thumbnail`);
        const sm = {};
        det.filter(d => d.code === 200).forEach(d => { sm[d.body.id] = d.body; });
        top_productos_hoy.forEach(p => {
          p.stock     = sm[p.item_id]?.available_quantity ?? null;
          p.thumbnail = sm[p.item_id]?.thumbnail ?? null;
        });
      } catch {}
    }

    // Compradores únicos
    const compradores_hoy = new Set(ordersHoy.map(o => o.buyer?.id).filter(Boolean)).size;

    // Visitas de HOY (best-effort) — last=1 devuelve ayer+hoy; extraemos el entry de hoy
    let visitas_hoy = null;
    try {
      const vr = await mlGet(`https://api.mercadolibre.com/users/${getSellerId()}/items_visits/time_window`, { last: 1, unit: 'day' });
      const hoyEntry = parseVisitResults(vr).find(r => r.date && r.date.startsWith(fecha));
      visitas_hoy = hoyEntry?.total ?? null;
    } catch {}

    const conversion = (visitas_hoy && compradores_hoy) ? (compradores_hoy / visitas_hoy * 100) : null;

    res.json({
      fecha, total_hoy, ordenes_hoy, unidades_hoy, ticket_promedio,
      ultima_orden, ultimas_5_ordenes, top_productos_hoy,
      ventas_por_hora, ayer_por_hora, comparativa_ayer,
      compradores_hoy, visitas_hoy, conversion,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.get('/api/ventas-mes', async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = year || new Date().getFullYear();
    const m = month || String(new Date().getMonth() + 1).padStart(2, '0');
    const yStr = String(y);
    const mStr = String(m).padStart(2, '0');
    const lastDay = new Date(y, m, 0).getDate();
    const dates = Array.from({ length: lastDay }, (_, i) => `${yStr}-${mStr}-${String(i + 1).padStart(2, '0')}`);

    const BATCH = 8;
    let allOrders = [];
    for (let i = 0; i < dates.length; i += BATCH) {
      const batch = dates.slice(i, i + BATCH);
      const batchOrders = await Promise.all(batch.map(async fecha => {
        const from = `${fecha}T00:00:00.000-06:00`;
        const to   = `${fecha}T23:59:59.000-06:00`;
        let orders = [], offset = 0, total = 1;
        while (offset < total) {
          const d = await mlGet('https://api.mercadolibre.com/orders/search', {
            seller: getSellerId(), 'order.status': 'paid',
            'order.date_created.from': from, 'order.date_created.to': to,
            limit: 50, offset
          });
          total = d.paging.total;
          orders = orders.concat(d.results);
          offset += 50;
        }
        return orders;
      }));
      batchOrders.forEach(dayOrders => allOrders.push(...dayOrders));
    }

    const total = allOrders.length;
    const ventaBruta = allOrders.reduce((s, o) => s + o.total_amount, 0);
    const unidades = allOrders.reduce((s, o) => s + o.order_items.reduce((ss, i) => ss + i.quantity, 0), 0);
    const precioLista = allOrders.reduce((s, o) => s + o.order_items.reduce((ss, i) => ss + i.gross_price, 0), 0);
    const byProduct = {};
    allOrders.forEach(o => {
      o.order_items.forEach(i => {
        const t = i.item.title;
        if (!byProduct[t]) byProduct[t] = { revenue: 0, units: 0, orders: 0 };
        byProduct[t].revenue += o.total_amount;
        byProduct[t].units += i.quantity;
        byProduct[t].orders += 1;
      });
    });
    const top = Object.entries(byProduct).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 10).map(([title, v]) => ({ title, ...v }));
    res.json({ ordenes: total, ventaBruta, precioLista, descuentos: precioLista - ventaBruta, unidades, ticketPromedio: total > 0 ? ventaBruta / total : 0, top, mes: `${yStr}-${mStr}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stock', async (req, res) => {
  try {
    let allIds = [];
    let offset = 0;
    let total = 1;
    while (offset < total) {
      const r = await mlGet(`https://api.mercadolibre.com/users/${getSellerId()}/items/search`, { status: 'active', limit: 50, offset });
      total = r.paging.total;
      allIds = allIds.concat(r.results);
      offset += 50;
    }
    let items = [];
    for (let i = 0; i < allIds.length; i += 20) {
      const ids = allIds.slice(i, i + 20).join(',');
      const details = await mlGet(`https://api.mercadolibre.com/items?ids=${ids}&attributes=id,title,available_quantity,price,status,variations`);
      items = items.concat(details.filter(d => d.code === 200).map(d => d.body));
    }
    const getPack = (title) => {
      const m = title.match(/(\d+)\s*pack/i);
      return m ? parseInt(m[1]) : 1;
    };
    const result = items.map(item => {
      const pack = getPack(item.title);
      const totalUnits = item.available_quantity || 0;
      const variations = (item.variations || []).map(v => {
        const attrs = {};
        (v.attribute_combinations || []).forEach(a => { attrs[a.name] = a.value_name; });
        return {
          id: v.id,
          color: attrs['Color'] || attrs['color'] || '',
          talla: attrs['Talla'] || attrs['talla'] || attrs['Size'] || '',
          stock: v.available_quantity || 0,
          piezas: (v.available_quantity || 0) * pack
        };
      });
      return { id: item.id, title: item.title, price: item.price, status: item.status, pack, totalUnits, totalPiezas: totalUnits * pack, variations };
    });
    const totalStock = result.reduce((s, i) => s + i.totalUnits, 0);
    const totalPiezas = result.reduce((s, i) => s + i.totalPiezas, 0);
    const totalPublicaciones = result.length;

    const [snap7, snapAyer] = await Promise.all([
      getStockSnapshot(dateNDaysAgo(7)),
      getStockSnapshot(dateNDaysAgo(1))
    ]);
    await saveStockSnapshot(totalPiezas, totalPublicaciones);

    res.json({
      totalPublicaciones, totalStock, totalPiezas, items: result,
      totalPiezasHace7d: snap7 ? snap7.total_piezas : null,
      totalPublicacionesAyer: snapAyer ? snapAyer.total_publicaciones : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/devoluciones/stats', async (req, res) => {
  try {
    const [openedData, closedData] = await Promise.all([
      mlGet('https://api.mercadolibre.com/post-purchase/v1/claims/search', { seller_id: getSellerId(), status: 'opened', limit: 50, offset: 0 }),
      mlGet('https://api.mercadolibre.com/post-purchase/v1/claims/search', { seller_id: getSellerId(), status: 'closed', limit: 100, offset: 0 }),
    ]);
    const allOpenClaims = openedData.data || [];
    const closedClaims = closedData.data || [];
    const totalOpen = openedData.paging?.total || 0;
    const totalClosed = closedData.paging?.total || 0;

    // Exclude outliers >60 días abiertos para stats y top productos
    const cutoff60 = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const openClaims = allOpenClaims.filter(c => new Date(c.date_created).getTime() >= cutoff60);

    const openReturns = openClaims.filter(c => c.type === 'returns').length;
    const openMediations = openClaims.filter(c => c.type === 'mediations').length;

    // Top reasons with labels from ML API
    const reasonCount = {};
    openClaims.forEach(c => { if (c.reason_id) reasonCount[c.reason_id] = (reasonCount[c.reason_id] || 0) + 1; });
    const reasonIds = Object.keys(reasonCount);
    const reasonLabels = {};
    await Promise.all(reasonIds.map(async id => { reasonLabels[id] = await getReasonLabel(id); }));
    const topReasons = Object.entries(reasonCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([reason_id, count]) => ({ reason_id, label: reasonLabels[reason_id] || reason_id, count }));

    // benefited=[] → sin devolución (vendedor retiene) | benefited=["complainant"] → comprador ganó
    let favorVendedor = 0, favorComprador = 0, sinResolucion = 0;
    let sumResHours = 0, resCount = 0;
    closedClaims.forEach(c => {
      if (!c.resolution) { sinResolucion++; return; }
      const ben = c.resolution.benefited || [];
      if (ben.includes('complainant')) favorComprador++;
      else favorVendedor++; // benefited=[] → reclamo cerrado sin devolución
      if (c.resolution.date_created) {
        const hrs = (new Date(c.resolution.date_created) - new Date(c.date_created)) / 3600000;
        if (hrs > 0 && hrs < 8760) { sumResHours += hrs; resCount++; }
      }
    });
    const withResolution = favorVendedor + favorComprador;
    res.json({
      totalOpen, totalClosed, openReturns, openMediations, topReasons,
      resolution: {
        favorVendedor, favorComprador, sinResolucion,
        total: withResolution,
        pctFavorVendedor: withResolution > 0 ? Math.round(favorVendedor / withResolution * 100) : 0,
        avgResolutionHours: resCount > 0 ? Math.round(sumResHours / resCount) : null,
      },
    });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.get('/api/devoluciones', async (req, res) => {
  try {
    const status = req.query.status || 'opened';
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    const data = await mlGet('https://api.mercadolibre.com/post-purchase/v1/claims/search', {
      seller_id: getSellerId(), status, limit, offset,
    });
    let claims = data.data || [];
    const total = data.paging?.total || 0;

    // Enrich open claims: order details + reason label + days_open
    if (status === 'opened' && claims.length > 0) {
      const uniqueReasons = [...new Set(claims.map(c => c.reason_id).filter(Boolean))];
      const [, reasonLabels] = await Promise.all([
        Promise.all(claims.map(async (claim, idx) => {
          if (!claim.resource_id) return;
          try {
            const order = await mlGet(`https://api.mercadolibre.com/orders/${claim.resource_id}`);
            claims[idx] = {
              ...claims[idx],
              order_items: (order.order_items || []).map(i => ({ title: i.item?.title, quantity: i.quantity, unit_price: i.unit_price })),
              total_amount: order.total_amount,
              buyer: order.buyer?.nickname || null,
            };
          } catch { /* sin enriquecimiento */ }
        })),
        (async () => {
          const map = {};
          await Promise.all(uniqueReasons.map(async id => { map[id] = await getReasonLabel(id); }));
          return map;
        })(),
      ]);
      const now = Date.now();
      claims = claims.map(c => {
        const sellerPlayer = (c.players || []).find(p => p.role === 'respondent');
        const sellerActions = sellerPlayer?.available_actions || [];
        const mandatoryAction = sellerActions.find(a => a.mandatory);
        let prioridad, due_date;
        if (mandatoryAction) {
          prioridad = 'urgente';
          due_date = mandatoryAction.due_date || null;
        } else if (sellerActions.length > 0) {
          prioridad = 'opcional';
          due_date = null;
        } else {
          prioridad = 'esperando';
          due_date = null;
        }
        return {
          ...c,
          reason_label: reasonLabels[c.reason_id] || c.reason_id,
          days_open: Math.floor((now - new Date(c.date_created)) / 86400000),
          prioridad,
          due_date,
          seller_actions: sellerActions.map(a => a.action),
        };
      });
    }

    // Closed claims: just add reason_label from cache (no extra API calls if already cached)
    if (status === 'closed' && claims.length > 0) {
      claims = claims.map(c => ({
        ...c,
        reason_label: reasonLabelCache.get(c.reason_id) || c.reason_id,
      }));
    }

    res.json({ total, offset, limit, claims });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor Holstone corriendo en http://localhost:${PORT}`));

app.get('/api/reputacion', async (req, res) => {
  try {
    const data = await mlGet(`https://api.mercadolibre.com/users/${getSellerId()}`);
    const rep = data.seller_reputation || {};
    const metrics = rep.metrics || {};
    const transactions = rep.transactions || {};
    const ratings = transactions.ratings || {};
    const RELEVANT_TAGS = ['large_seller', 'eshop', 'brand'];
    res.json({
      // existing fields (backward compat for overview cards)
      reputacion: rep.level_id,
      powerSeller: rep.power_seller_status,
      transacciones: transactions.completed || 0,
      cancelaciones: (metrics.cancellations?.rate || 0) * 100,
      cancelacionesNum: metrics.cancellations?.value || 0,
      reclamos: (metrics.claims?.rate || 0) * 100,
      reclamosNum: metrics.claims?.value || 0,
      enviosDemorados: (metrics.delayed_handling_time?.rate || 0) * 100,
      periodo: metrics.cancellations?.period || '',
      tiempoRespuesta: {
        periodo: metrics.sales?.period || '',
        envioDemoradoRate: (metrics.delayed_handling_time?.rate || 0) * 100,
        envioDemoradoNum: metrics.delayed_handling_time?.value || 0,
      },
      // new fields
      ventasCompletadas60d: metrics.sales?.completed || 0,
      periodoMetricas: metrics.sales?.period || '60 days',
      transaccionesTotal: transactions.total || 0,
      transaccionesCompletadas: transactions.completed || 0,
      transaccionesCanceladas: transactions.canceled || 0,
      ratings: {
        positivo: Math.round((ratings.positive || 0) * 100),
        negativo: Math.round((ratings.negative || 0) * 100),
        neutral: Math.round((ratings.neutral || 0) * 100),
      },
      points: data.points || 0,
      tags: (data.tags || []).filter(t => RELEVANT_TAGS.includes(t)),
      registracion: data.registration_date || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});


async function getAllItemIds(status) {
  let ids = [], offset = 0, total = 1;
  while (offset < total) {
    const r = await mlGet(`https://api.mercadolibre.com/users/${getSellerId()}/items/search`, { status, limit: 50, offset });
    total = r.paging.total;
    ids = ids.concat(r.results);
    offset += 50;
  }
  return ids;
}

app.get('/api/publicaciones', async (req, res) => {
  try {
    // Phase 1: fetch active and paused ID lists in parallel
    const [activeIds, pausedIds] = await Promise.all([
      getAllItemIds('active'),
      getAllItemIds('paused')
    ]);
    const allIds = activeIds.concat(pausedIds);
    const activas = activeIds.length;
    const pausadas = pausedIds.length;

    // Phase 2: fetch listing-type details in parallel batches of 20, concurrency 5
    let premium = 0, clasica = 0;
    const BATCH = 20, CONCURRENCY = 5;
    const batches = [];
    for (let i = 0; i < allIds.length; i += BATCH) batches.push(allIds.slice(i, i + BATCH));

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const group = batches.slice(i, i + CONCURRENCY);
      await Promise.all(group.map(async batch => {
        const ids = batch.join(',');
        const details = await mlGet(`https://api.mercadolibre.com/items?ids=${ids}&attributes=id,listing_type_id`);
        if (!Array.isArray(details)) return;
        details.filter(d => d.code === 200).forEach(d => {
          const lt = d.body?.listing_type_id;
          if (lt === 'gold_pro') premium++;
          else if (lt === 'gold_special') clasica++;
        });
      }));
    }

    res.json({ activas, pausadas, total: activas + pausadas, premium, clasica });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    res.status(500).json({ error: msg });
  }
});

app.get('/api/performance', async (req, res) => {
  try {
    const now = new Date();
    const toDate = now.toISOString().split('T')[0];
    const fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const itemsData = await mlGet(`https://api.mercadolibre.com/users/${getSellerId()}/items/search`, {
      status: 'active', limit: 50, offset: 0
    });
    const itemIds = itemsData.results;
    const totalPublicaciones = itemsData.paging.total;

    let totalVisitas = 0;
    const top10 = itemIds.slice(0, 10);
    if (top10.length > 0) {
      const visitResults = await Promise.all(
        top10.map(id =>
          mlGet(`https://api.mercadolibre.com/items/${id}/visits/time_window?last=7&unit=day`)
            .then(v => parseVisitTotal(v))
            .catch(() => 0)
        )
      );
      totalVisitas = visitResults.reduce((s, v) => s + v, 0);
    }

    const from = `${fromDate}T00:00:00.000-06:00`;
    const to = `${toDate}T23:59:59.000-06:00`;
    const ordersData = await mlGet('https://api.mercadolibre.com/orders/search', {
      seller: getSellerId(), 'order.status': 'paid',
      'order.date_created.from': from, 'order.date_created.to': to, limit: 1
    });
    const totalOrdenes = ordersData.paging.total;
    const conversion = totalVisitas > 0 ? (totalOrdenes / totalVisitas * 100) : 0;

    res.json({ visitas: totalVisitas, ordenes: totalOrdenes, conversion, periodo: '7 días', itemsConsultados: itemIds.length, totalPublicaciones });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    res.status(500).json({ error: msg });
  }
});

async function computeStockInteligente() {
  {
    // 1. Get all active item IDs (paginated)
    let allIds = [];
    let offset = 0;
    let total = 1;
    while (offset < total) {
      const r = await mlGet(`https://api.mercadolibre.com/users/${getSellerId()}/items/search`, {
        status: 'active', limit: 50, offset
      });
      total = r.paging.total;
      allIds = allIds.concat(r.results);
      offset += 50;
    }

    // 2. Get item details in batches of 20
    let items = [];
    for (let i = 0; i < allIds.length; i += 20) {
      const ids = allIds.slice(i, i + 20).join(',');
      const details = await mlGet(
        `https://api.mercadolibre.com/items?ids=${ids}&attributes=id,title,available_quantity,price,status,variations,catalog_listing,shipping`
      );
      items = items.concat(details.filter(d => d.code === 200).map(d => d.body));
    }

    // 3. Build 3-month window ending today
    const now = new Date();
    const cy = now.getFullYear();
    const cm = now.getMonth() + 1;
    const months = [];
    for (let i = 2; i >= 0; i--) {
      let m = cm - i; let y = cy;
      if (m <= 0) { m += 12; y -= 1; }
      months.push({ year: y, month: m });
    }
    const startDate = new Date(months[0].year, months[0].month - 1, 1);
    const totalDays = Math.max(1, Math.round((now - startDate) / 86400000));

    // 4. Fetch orders day-by-day (BATCH=8) to bypass the 1000-order ML cap
    const dates = [];
    const cur = new Date(startDate);
    while (cur <= now) {
      dates.push(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date(cur)));
      cur.setDate(cur.getDate() + 1);
    }
    const BATCH = 8;
    const allOrders = [];
    for (let i = 0; i < dates.length; i += BATCH) {
      const batch = dates.slice(i, i + BATCH);
      const batchOrders = await Promise.all(batch.map(async fecha => {
        const from = `${fecha}T00:00:00.000-06:00`;
        const to   = `${fecha}T23:59:59.000-06:00`;
        let orders = [], offset = 0, total = 1;
        while (offset < total) {
          const d = await mlGet('https://api.mercadolibre.com/orders/search', {
            seller: getSellerId(), 'order.status': 'paid',
            'order.date_created.from': from, 'order.date_created.to': to,
            limit: 50, offset
          });
          total = d.paging.total;
          orders = orders.concat(d.results);
          offset += 50;
        }
        return orders;
      }));
      batchOrders.forEach(dayOrders => allOrders.push(...dayOrders));
    }

    // 5. Build sales map: itemId -> { total, byVariant: { variantId: qty } }
    const salesMap = {};
    allOrders.forEach(order => {
      order.order_items.forEach(oi => {
        const iid = oi.item.id;
        const qty = oi.quantity;
        if (!salesMap[iid]) salesMap[iid] = { total: 0, byVariant: {} };
        salesMap[iid].total += qty;
        const vid = oi.item.variation_id;
        if (vid != null) salesMap[iid].byVariant[vid] = (salesMap[iid].byVariant[vid] || 0) + qty;
      });
    });

    // 6. Compute per-item and per-variant metrics
    const getPack = t => { const m = t.match(/(\d+)\s*pack/i); return m ? parseInt(m[1]) : 1; };
    const calcAlert = (days, stock) => {
      if (stock <= 0 || (days !== null && days <= 1)) return 'out';
      if (days === null) return 'no_sales';
      if (days <= 15) return 'critical';
      if (days <= 45) return 'low';
      return 'ok';
    };
    const calcDate = days => {
      if (days === null || days === undefined) return null;
      return new Date(now.getTime() + days * 86400000).toISOString().split('T')[0];
    };

    const result = items.map(item => {
      const pack = getPack(item.title);
      const totalStock = item.available_quantity || 0;
      const sales = salesMap[item.id] || { total: 0, byVariant: {} };
      const dailyAvg = sales.total / totalDays;
      const daysRemaining = dailyAvg > 0 ? Math.round(totalStock / dailyAvg) : null;
      const variations = (item.variations || []).map(v => {
        const attrs = {};
        (v.attribute_combinations || []).forEach(a => { attrs[a.name] = a.value_name; });
        const vs = v.available_quantity || 0;
        const vd = (sales.byVariant[v.id] || 0) / totalDays;
        const vDays = vd > 0 ? Math.round(vs / vd) : null;
        return {
          id: v.id,
          color: attrs['Color'] || attrs['color'] || '',
          talla: attrs['Talla'] || attrs['talla'] || attrs['Size'] || '',
          stock: vs, piezas: vs * pack,
          sales3m: sales.byVariant[v.id] || 0,
          monthlyAvg: Math.round(vd * 30 * 10) / 10,
          daysRemaining: vDays,
          depletionDate: calcDate(vDays),
          needed30: Math.ceil(vd * 30),
          needed60: Math.ceil(vd * 60),
          needed90: Math.ceil(vd * 90),
          alertLevel: calcAlert(vDays, vs)
        };
      });
      return {
        id: item.id, title: item.title, price: item.price || 0, pack,
        totalStock, totalPiezas: totalStock * pack,
        valorInventario: Math.round(totalStock * (item.price || 0)),
        sales3m: sales.total,
        monthlyAvg: Math.round(dailyAvg * 30 * 10) / 10,
        daysRemaining,
        depletionDate: calcDate(daysRemaining),
        needed30: Math.ceil(dailyAvg * 30),
        needed60: Math.ceil(dailyAvg * 60),
        needed90: Math.ceil(dailyAvg * 90),
        alertLevel: calcAlert(daysRemaining, totalStock),
        variations,
        catalogListing: item.catalog_listing || false,
        logisticType: item.shipping?.logistic_type || null
      };
    });

    result.sort((a, b) => {
      if (a.catalogListing !== b.catalogListing) return (b.catalogListing ? 1 : 0) - (a.catalogListing ? 1 : 0);
      return b.sales3m - a.sales3m;
    });

    const summary = {
      total: result.length,
      agotados: result.filter(i => i.totalStock === 0 || (i.variations && i.variations.some(v => v.stock === 0))).length,
      criticos: result.filter(i => i.alertLevel === 'critical').length,
      bajos: result.filter(i => i.alertLevel === 'low').length,
      sinVentas: result.filter(i => i.daysRemaining === null && i.totalStock > 0).length,
      ok: result.filter(i => i.alertLevel === 'ok' && i.daysRemaining !== null).length,
      valorInventario: Math.round(result.reduce((s, i) => s + i.valorInventario, 0))
    };

    return {
      items: result, summary, totalDays,
      periodoDesde: startDate.toISOString().split('T')[0],
      periodoHasta: now.toISOString().split('T')[0]
    };
  }
}

app.get('/api/stock-inteligente', async (req, res) => {
  try {
    const data = await computeStockInteligente();
    res.json(data);
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    res.status(500).json({ error: msg });
  }
});

// ── ENVÍOS ───────────────────────────────────────────────────────────────────

function dateNDaysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(d);
}

app.get('/api/envios', async (req, res) => {
  try {
    const period = req.query.period || 'today';
    const fechaHoy = today();
    let from, to;
    if (period === '7days') {
      from = `${dateNDaysAgo(6)}T00:00:00.000-06:00`;
      to = `${fechaHoy}T23:59:59.000-06:00`;
    } else if (period === '30days') {
      from = `${dateNDaysAgo(29)}T00:00:00.000-06:00`;
      to = `${fechaHoy}T23:59:59.000-06:00`;
    } else {
      from = `${fechaHoy}T00:00:00.000-06:00`;
      to = `${fechaHoy}T23:59:59.000-06:00`;
    }
    console.log('[envios] period:', period, 'from:', from, 'to:', to);

    // Obtener todas las órdenes pagadas en el rango
    let allOrders = [];
    let offset = 0;
    let total = 1;
    while (offset < total) {
      const d = await mlGet('https://api.mercadolibre.com/orders/search', {
        seller: getSellerId(), 'order.status': 'paid',
        'order.date_created.from': from, 'order.date_created.to': to,
        limit: 50, offset
      });
      total = d.paging.total;
      allOrders = allOrders.concat(d.results);
      offset += 50;
    }

    // Obtener detalle de cada envío en lotes (logistic_type + costo) con caché
    const shipmentIds = [...new Set(allOrders.filter(o => o.shipping?.id).map(o => o.shipping.id))];
    const missingEnvios = shipmentIds.filter(id => !shipmentCache.has(id));
    const BATCH = 15;
    for (let i = 0; i < missingEnvios.length; i += BATCH) {
      const batch = missingEnvios.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(id =>
        mlGet(`https://api.mercadolibre.com/shipments/${id}`).catch(() => null)
      ));
      batch.forEach((id, idx) => { if (results[idx]) shipmentCache.set(id, results[idx]); });
    }
    const shipmentMap = {};
    shipmentIds.forEach(id => { if (shipmentCache.has(id)) shipmentMap[id] = shipmentCache.get(id); });

    let totalEnvios = 0;
    let costoTotal = 0;
    const tipos = {};

    allOrders.forEach(o => {
      const shipment = o.shipping?.id ? shipmentMap[o.shipping.id] : null;
      const isFull = shipment?.logistic_type === 'fulfillment' || o.fulfilled === true;
      const tipoKey = isFull ? 'full' : 'me';
      const costo = shipment?.shipping_option?.list_cost ?? shipment?.base_cost ?? 0;

      totalEnvios++;
      costoTotal += costo;

      if (!tipos[tipoKey]) tipos[tipoKey] = { cantidad: 0, dinero: 0, costo: 0 };
      tipos[tipoKey].cantidad++;
      tipos[tipoKey].dinero += o.total_amount;
      tipos[tipoKey].costo += costo;
    });

    const NOMBRES = { full: 'Full', me: 'Mercado Envíos' };
    const desglose = ['full', 'me'].filter(k => tipos[k]).map(k => {
      const v = tipos[k];
      return {
        tipo: NOMBRES[k],
        cantidad: v.cantidad,
        porcentaje: totalEnvios ? Math.round((v.cantidad / totalEnvios) * 1000) / 10 : 0,
        dineroTransaccionado: Math.round(v.dinero),
        ticketPromedio: v.cantidad ? Math.round(v.dinero / v.cantidad) : 0,
        costo: Math.round(v.costo)
      };
    });

    res.json({
      period,
      totalEnvios,
      costoTotal: Math.round(costoTotal),
      desglose,
      periodoDesde: from,
      periodoHasta: to
    });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    res.status(500).json({ error: msg });
  }
});

// ── TENDENCIA DE VENTAS ──────────────────────────────────────────────────────

app.get('/api/tendencia', async (req, res) => {
  try {
    const period = req.query.period === '30days' ? '30days' : '7days';
    const days = period === '30days' ? 30 : 7;

    // Período actual:   dateNDaysAgo(days-1) → dateNDaysAgo(0)
    // Período anterior: dateNDaysAgo(2*days-1) → dateNDaysAgo(days)
    const dates     = Array.from({ length: days }, (_, i) => dateNDaysAgo(days - 1 - i));
    const datesPrev = Array.from({ length: days }, (_, i) => dateNDaysAgo(days * 2 - 1 - i));

    const BATCH = 8;
    async function fetchDias(dateList) {
      const result = [];
      for (let i = 0; i < dateList.length; i += BATCH) {
        const batch = dateList.slice(i, i + BATCH);
        const batchResults = await Promise.all(batch.map(async fecha => {
          const from = `${fecha}T00:00:00.000-06:00`;
          const to   = `${fecha}T23:59:59.000-06:00`;
          let orders = [], offset = 0, total = 1;
          while (offset < total) {
            const d = await mlGet('https://api.mercadolibre.com/orders/search', {
              seller: getSellerId(), 'order.status': 'paid',
              'order.date_created.from': from, 'order.date_created.to': to,
              limit: 50, offset
            });
            total = d.paging.total;
            orders = orders.concat(d.results);
            offset += 50;
          }
          const ordenes    = orders.length;
          const ventaBruta = orders.reduce((s, o) => s + o.total_amount, 0);
          const unidades   = orders.reduce((s, o) => s + o.order_items.reduce((ss, it) => ss + it.quantity, 0), 0);
          return { fecha, ordenes, ventaBruta: Math.round(ventaBruta), unidades,
            ticketPromedio: ordenes ? Math.round(ventaBruta / ordenes) : 0 };
        }));
        result.push(...batchResults);
      }
      return result;
    }

    const [dias, diasPrev] = await Promise.all([fetchDias(dates), fetchDias(datesPrev)]);

    // Visitas: last: days*2 cubre ambos períodos; mapa por fecha sirve para los dos
    try {
      const visitas = await mlGet(`https://api.mercadolibre.com/users/${getSellerId()}/items_visits/time_window`, {
        last: days * 2, unit: 'day'
      });
      const visitasMap = {};
      (visitas.results || []).forEach(r => { visitasMap[r.date.split('T')[0]] = r.total; });
      dias.forEach(d     => { d.visitas = visitasMap[d.fecha] || 0; });
      diasPrev.forEach(d => { d.visitas = visitasMap[d.fecha] || 0; });
    } catch (e) {
      console.error('Error obteniendo visitas:', e.response?.data || e.message);
      dias.forEach(d     => { d.visitas = 0; });
      diasPrev.forEach(d => { d.visitas = 0; });
    }

    res.json({ period, dias, periodo_anterior: diasPrev });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    res.status(500).json({ error: msg });
  }
});

// ── VENTAS — RESUMEN CON COMPARATIVA ────────────────────────────────────────

app.get('/api/ventas-resumen', async (req, res) => {
  try {
    const period = req.query.period || 'hoy';
    const range = getPeriodRange(period, req.query.year, req.query.month, req.query.date, req.query.from, req.query.to);
    const cur = toRange(range.from, range.to);
    const ant = toRange(range.fromAnt, range.toAnt);

    const [ordersCur, ordersAnt] = await Promise.all([
      fetchPaidOrders(cur.from, cur.to),
      fetchPaidOrders(ant.from, ant.to)
    ]);

    function summarize(orders) {
      const ventaBruta = orders.reduce((s, o) => s + o.total_amount, 0);
      const unidades = orders.reduce((s, o) => s + o.order_items.reduce((ss, i) => ss + i.quantity, 0), 0);
      const ordenes = orders.length;
      const buyerCounts = {};
      orders.forEach(o => {
        const bid = o.buyer?.id;
        if (bid == null) return;
        buyerCounts[bid] = (buyerCounts[bid] || 0) + 1;
      });
      const compradores = Object.keys(buyerCounts).length;
      const frecuentes = Object.values(buyerCounts).filter(c => c >= 2).length;
      const nuevos = compradores - frecuentes;
      return {
        ventaBruta, unidades, ordenes, compradores, frecuentes, nuevos,
        precioPromedio: ordenes > 0 ? ventaBruta / ordenes : 0
      };
    }

    const cs = summarize(ordersCur);
    const as = summarize(ordersAnt);

    // Visitas (solo disponibles para los últimos ~60 días)
    let visitasMap = {};
    const sellerId = getSellerId();
    try {
      const v = await mlGet(`https://api.mercadolibre.com/users/${sellerId}/items_visits/time_window`, { last: 60, unit: 'day' });
      parseVisitResults(v).forEach(r => { visitasMap[r.date.split('T')[0]] = r.total; });
      console.log(`[visitas] seller=${sellerId} results=${parseVisitResults(v).length} mapKeys=${Object.keys(visitasMap).length}`);
    } catch (e) {
      console.error(`[visitas] ERROR seller=${sellerId} status=${e.response?.status}`, e.response?.data || e.message);
    }

    function sumVisitas(from, to) {
      let s = 0;
      let d = new Date(from + 'T00:00:00');
      const end = new Date(to + 'T00:00:00');
      while (d <= end) {
        const key = d.toISOString().split('T')[0];
        s += visitasMap[key] || 0;
        d.setDate(d.getDate() + 1);
      }
      return s;
    }

    const visitasCur = daysAgo(range.to) <= 59 ? sumVisitas(range.from, range.to) : null;
    console.log(`[visitas] range=${range.from}→${range.to} daysAgo=${daysAgo(range.to)} visitasCur=${visitasCur}`);
    const visitasAnt = daysAgo(range.toAnt) <= 59 ? sumVisitas(range.fromAnt, range.toAnt) : null;
    const conversionCur = visitasCur === null ? null : (visitasCur > 0 ? cs.ordenes / visitasCur * 100 : 0);
    const conversionAnt = visitasAnt === null ? null : (visitasAnt > 0 ? as.ordenes / visitasAnt * 100 : 0);

    // Top productos del período
    const byProduct = {};
    ordersCur.forEach(o => {
      o.order_items.forEach(i => {
        const id = i.item?.id;
        if (!id) return;
        if (!byProduct[id]) byProduct[id] = { item_id: id, title: i.item.title, revenue: 0, units: 0, orders: 0 };
        byProduct[id].revenue += o.total_amount;
        byProduct[id].units += i.quantity;
        byProduct[id].orders += 1;
      });
    });
    const top = Object.values(byProduct).sort((a, b) => b.revenue - a.revenue).slice(0, 20);
    console.log('[debug-top] primeros 3:', JSON.stringify(top.slice(0,3).map(p=>({item_id:p.item_id,title:p.title?.slice(0,30)}))));

    res.json({
      period, label: range.label, from: range.from, to: range.to,
      ventaBruta: cs.ventaBruta, ventaBrutaAnt: as.ventaBruta,
      unidades: cs.unidades, unidadesAnt: as.unidades,
      precioPromedio: cs.precioPromedio, precioPromedioAnt: as.precioPromedio,
      visitas: visitasCur, visitasAnt,
      conversion: conversionCur, conversionAnt,
      compradores: cs.compradores, compradoresAnt: as.compradores,
      frecuentes: cs.frecuentes, frecuentesAnt: as.frecuentes,
      nuevos: cs.nuevos, nuevosAnt: as.nuevos,
      ordenes: cs.ordenes, ordenesAnt: as.ordenes,
      top
    });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── VENTAS — HEATMAP DÍA/HORA ───────────────────────────────────────────────

app.get('/api/heatmap', async (req, res) => {
  try {
    const period = req.query.period === '30days' ? '30days' : '7days';
    const days = period === '30days' ? 30 : 7;
    const dates = Array.from({ length: days }, (_, i) => dateNDaysAgo(days - 1 - i));

    const BATCH = 8;
    const allOrders = [];
    for (let i = 0; i < dates.length; i += BATCH) {
      const batch = dates.slice(i, i + BATCH);
      const batchOrders = await Promise.all(batch.map(async fecha => {
        const from = `${fecha}T00:00:00.000-06:00`;
        const to   = `${fecha}T23:59:59.000-06:00`;
        let orders = [], offset = 0, total = 1;
        while (offset < total) {
          const d = await mlGet('https://api.mercadolibre.com/orders/search', {
            seller: getSellerId(), 'order.status': 'paid',
            'order.date_created.from': from, 'order.date_created.to': to,
            limit: 50, offset
          });
          total = d.paging.total;
          orders = orders.concat(d.results);
          offset += 50;
        }
        return orders;
      }));
      batchOrders.forEach(dayOrders => allOrders.push(...dayOrders));
    }

    const DOW = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ ventas: 0, ordenes: 0 })));

    allOrders.forEach(o => {
      const d = new Date(o.date_created);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(d);
      const weekdayShort = parts.find(p => p.type === 'weekday').value;
      let hour = parseInt(parts.find(p => p.type === 'hour').value);
      if (hour === 24) hour = 0;
      const dow = DOW_MAP[weekdayShort];
      grid[dow][hour].ventas += o.total_amount;
      grid[dow][hour].ordenes += 1;
    });

    let max = 0;
    grid.forEach(row => row.forEach(c => { if (c.ventas > max) max = c.ventas; }));
    grid.forEach(row => row.forEach(c => {
      if (c.ventas === 0) c.nivel = 0;
      else if (c.ventas <= max / 3) c.nivel = 1;
      else if (c.ventas <= max * 2 / 3) c.nivel = 2;
      else c.nivel = 3;
    }));

    const porDia = grid.map((row, i) => ({ dia: DOW[i], ventas: row.reduce((s, c) => s + c.ventas, 0) }));
    const diaTop = porDia.reduce((a, b) => b.ventas > a.ventas ? b : a, porDia[0]);
    const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, ventas: grid.reduce((s, row) => s + row[h].ventas, 0) }));
    const horaTop = porHora.reduce((a, b) => b.ventas > a.ventas ? b : a, porHora[0]);
    const ventaTotal = allOrders.reduce((s, o) => s + o.total_amount, 0);

    res.json({
      period, days, grid, dow: DOW,
      diaConMasVentas: diaTop.ventas > 0 ? diaTop.dia : null,
      horaConMasVentas: horaTop.ventas > 0 ? `${String(horaTop.hora).padStart(2, '0')}:00 - ${String((horaTop.hora + 1) % 24).padStart(2, '0')}:00` : null,
      promedioPorDia: ventaTotal / days
    });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── VENTAS — CALENDARIO MENSUAL ─────────────────────────────────────────────

app.get('/api/calendario', async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year) || now.getFullYear();
    const month = parseInt(req.query.month) || (now.getMonth() + 1);
    const lastDay = new Date(year, month, 0).getDate();
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const range = toRange(from, to);
    const orders = await fetchPaidOrders(range.from, range.to);

    const byDay = {};
    orders.forEach(o => {
      const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date(o.date_created));
      if (!byDay[fecha]) byDay[fecha] = { ordenes: 0, ventaBruta: 0 };
      byDay[fecha].ordenes += 1;
      byDay[fecha].ventaBruta += o.total_amount;
    });

    const days = [];
    for (let day = 1; day <= lastDay; day++) {
      const fecha = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const data = byDay[fecha] || { ordenes: 0, ventaBruta: 0 };
      let nivel;
      if (data.ordenes === 0) nivel = 0;
      else if (data.ordenes <= 10) nivel = 1;
      else if (data.ordenes <= 50) nivel = 2;
      else nivel = 3;
      days.push({ fecha, ordenes: data.ordenes, ventaBruta: data.ventaBruta, nivel });
    }

    res.json({ year, month, days });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── VENTAS — POR PUBLICACIÓN ─────────────────────────────────────────────────

app.get('/api/ventas-por-publicacion', async (req, res) => {
  try {
    const period = req.query.period || '7days';
    const range = getPeriodRange(period, req.query.year, req.query.month);
    const cur = toRange(range.from, range.to);
    const orders = await fetchPaidOrders(cur.from, cur.to);

    const byItem = {};
    orders.forEach(o => {
      o.order_items.forEach(i => {
        const id = i.item.id;
        if (!byItem[id]) byItem[id] = { id, title: i.item.title, ventaBruta: 0, unidades: 0, ordenes: 0 };
        byItem[id].ventaBruta += o.total_amount;
        byItem[id].unidades += i.quantity;
        byItem[id].ordenes += 1;
      });
    });

    const items = Object.values(byItem);
    const totalVenta = items.reduce((s, i) => s + i.ventaBruta, 0);
    const ids = items.map(i => i.id);

    const typeMap = {};
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20).join(',');
      const details = await mlGet(`https://api.mercadolibre.com/items?ids=${chunk}&attributes=id,listing_type_id`);
      details.filter(d => d.code === 200).forEach(d => { typeMap[d.body.id] = d.body.listing_type_id; });
    }

    const visitDays = Math.min(range.days, 60);
    const visitMap = {};
    const BATCH = 10;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const results = await Promise.all(chunk.map(id =>
        mlGet(`https://api.mercadolibre.com/items/${id}/visits/time_window`, { last: visitDays, unit: 'day' })
          .then(v => parseVisitTotal(v)).catch(() => 0)
      ));
      chunk.forEach((id, idx) => { visitMap[id] = results[idx]; });
    }

    const result = items.map(i => {
      const visitas = visitMap[i.id] || 0;
      const lt = typeMap[i.id];
      return {
        id: i.id, title: i.title,
        tipo: lt === 'gold_pro' ? 'Premium' : 'Clásica',
        ventaBruta: i.ventaBruta,
        participacion: totalVenta > 0 ? (i.ventaBruta / totalVenta * 100) : 0,
        visitas,
        unidades: i.unidades,
        conversion: visitas > 0 ? (i.ordenes / visitas * 100) : 0
      };
    }).sort((a, b) => b.ventaBruta - a.ventaBruta);

    res.json({ period, label: range.label, items: result });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── VENTAS — PUBLICACIONES SIN VENTAS ───────────────────────────────────────

app.get('/api/sin-ventas', async (req, res) => {
  try {
    let allIds = [];
    let offset = 0;
    let total = 1;
    while (offset < total) {
      const r = await mlGet(`https://api.mercadolibre.com/users/${getSellerId()}/items/search`, { status: 'active', limit: 50, offset });
      total = r.paging.total;
      allIds = allIds.concat(r.results);
      offset += 50;
    }
    let items = [];
    for (let i = 0; i < allIds.length; i += 20) {
      const ids = allIds.slice(i, i + 20).join(',');
      const details = await mlGet(`https://api.mercadolibre.com/items?ids=${ids}&attributes=id,title,available_quantity,price,status`);
      items = items.concat(details.filter(d => d.code === 200).map(d => d.body));
    }
    items = items.filter(i => (i.available_quantity || 0) > 0);

    const to = `${today()}T23:59:59.000-06:00`;
    const from30 = `${dateNDaysAgo(29)}T00:00:00.000-06:00`;
    const orders30 = await fetchPaidOrders(from30, to);
    const soldIds30 = new Set();
    orders30.forEach(o => o.order_items.forEach(i => soldIds30.add(i.item.id)));

    const sinVentas = items.filter(i => !soldIds30.has(i.id));

    const from90 = `${dateNDaysAgo(89)}T00:00:00.000-06:00`;
    const orders90 = await fetchPaidOrders(from90, to);
    const lastSale = {};
    orders90.forEach(o => o.order_items.forEach(i => {
      const id = i.item.id;
      const date = o.date_created.split('T')[0];
      if (!lastSale[id] || date > lastSale[id]) lastSale[id] = date;
    }));

    const visitMap = {};
    const BATCH = 10;
    for (let i = 0; i < sinVentas.length; i += BATCH) {
      const chunk = sinVentas.slice(i, i + BATCH);
      const results = await Promise.all(chunk.map(it =>
        mlGet(`https://api.mercadolibre.com/items/${it.id}/visits/time_window`, { last: 30, unit: 'day' })
          .then(v => parseVisitTotal(v)).catch(() => 0)
      ));
      chunk.forEach((it, idx) => { visitMap[it.id] = results[idx]; });
    }

    const result = sinVentas.map(i => ({
      id: i.id, title: i.title, price: i.price, stock: i.available_quantity,
      visitas: visitMap[i.id] || 0,
      ultimaVenta: lastSale[i.id] || null
    })).sort((a, b) => b.visitas - a.visitas);

    res.json({ total: result.length, items: result });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── PUBLICIDAD (PRODUCT ADS) ─────────────────────────────────────────────────

const ADVERTISER_ID = 4299;
const ADS_METRICS = 'clicks,prints,cost,cpc,acos,roas,total_amount,units_quantity,direct_amount,indirect_amount';

app.get('/api/ads', async (req, res) => {
  try {
    const ctx = requestCtx.getStore();
    if (ctx?.tenant && !ctx.tenant.advertiser_id) {
      return res.json({ available: false, reason: 'no_ads_account' });
    }

    const from = req.query.from || dateNDaysAgo(6);
    const to = req.query.to || today();
    const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id) : null;

    // Campaigns ML Ads (paginadas, incluye eliminadas) + ventas totales del negocio — en paralelo
    const [rawCampaignsFirst, periodOrders] = await Promise.all([
      mlGetAds(`https://api.mercadolibre.com/advertising/MLM/advertisers/${getAdvertiserId()}/product_ads/campaigns/search`, {
        date_from: from, date_to: to, metrics: ADS_METRICS, limit: 50, offset: 0
      }),
      fetchPaidOrders(`${from}T00:00:00.000-06:00`, `${to}T23:59:59.000-06:00`).catch(() => [])
    ]);
    const ventaTotalPeriodo = periodOrders.reduce((s, o) => s + (o.total_amount || 0), 0);

    let allCampaigns = rawCampaignsFirst.results || [];
    let campTotal = rawCampaignsFirst.paging?.total ?? allCampaigns.length;
    let campOffset = 50;
    while (campOffset < campTotal) {
      const page = await mlGetAds(`https://api.mercadolibre.com/advertising/MLM/advertisers/${getAdvertiserId()}/product_ads/campaigns/search`, {
        date_from: from, date_to: to, metrics: ADS_METRICS, limit: 50, offset: campOffset
      });
      allCampaigns = allCampaigns.concat(page.results || []);
      campOffset += 50;
    }

    let ads = [];
    let offset = 0, total = 1;
    while (offset < total) {
      const d = await mlGetAds(`https://api.mercadolibre.com/advertising/MLM/advertisers/${getAdvertiserId()}/product_ads/ads/search`, {
        date_from: from, date_to: to, metrics: ADS_METRICS, limit: 50, offset
      });
      total = d.paging.total;
      ads = ads.concat(d.results);
      offset += 50;
    }

    const stockData = await computeStockInteligente().catch(() => null);
    const stockMap = {};
    if (stockData) {
      stockData.items.forEach(i => {
        stockMap[i.id] = { stock: i.totalStock, diasStock: i.daysRemaining };
      });
    }
    ads = ads.map(ad => ({
      ...ad,
      stock: stockMap[ad.item_id]?.stock ?? null,
      diasStock: stockMap[ad.item_id]?.diasStock ?? null
    }));

    let campaigns = allCampaigns;
    if (campaignId) {
      campaigns = campaigns.filter(c => c.id === campaignId);
      ads = ads.filter(a => a.campaign_id === campaignId);
    }

    res.json({ from, to, campaigns, ads, ventaTotalPeriodo });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    // 401/403 persistente de ML (después del retry) = el token no tiene scope de advertising
    if (e.response?.status === 401 || e.response?.status === 403) {
      return res.json({ available: false, reason: 'ads_scope_missing' });
    }
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.get('/api/ads-tendencia', async (req, res) => {
  try {
    const ctx = requestCtx.getStore();
    if (ctx?.tenant && !ctx.tenant.advertiser_id) {
      return res.json({ available: false, reason: 'no_ads_account' });
    }

    const from = req.query.from || dateNDaysAgo(6);
    const to = req.query.to || today();
    const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id) : null;

    const dateList = [];
    for (let d = from; d <= to; d = addDays(d, 1)) dateList.push(d);

    const dias = [];
    const CONCURRENCY = 5;
    for (let i = 0; i < dateList.length; i += CONCURRENCY) {
      const batch = dateList.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async fecha => {
        try {
          const d = await mlGetAds(`https://api.mercadolibre.com/advertising/MLM/advertisers/${getAdvertiserId()}/product_ads/campaigns/search`, {
            date_from: fecha, date_to: fecha, metrics: 'cost,total_amount,clicks,prints,direct_amount,indirect_amount', limit: 50
          });
          let results2 = d.results || [];
          if (campaignId) results2 = results2.filter(c => c.id === campaignId);
          const inversion      = results2.reduce((s, c) => s + (c.metrics?.cost            || 0), 0);
          const ventas         = results2.reduce((s, c) => s + (c.metrics?.total_amount    || 0), 0);
          const clicks         = results2.reduce((s, c) => s + (c.metrics?.clicks          || 0), 0);
          const prints         = results2.reduce((s, c) => s + (c.metrics?.prints          || 0), 0);
          const directAmount   = results2.reduce((s, c) => s + (c.metrics?.direct_amount   || 0), 0);
          const indirectAmount = results2.reduce((s, c) => s + (c.metrics?.indirect_amount || 0), 0);
          const roas = inversion > 0 ? ventas / inversion : 0;
          const acos = ventas > 0 ? (inversion / ventas) * 100 : 0;
          return { fecha, inversion, ventas, roas, acos, clicks, prints, directAmount, indirectAmount };
        } catch (innerErr) {
          // Propagar errores de autenticación al catch externo
          if (innerErr.response?.status === 401 || innerErr.response?.status === 403) throw innerErr;
          console.error(`[ads-tendencia] fecha=${fecha} err=${innerErr.response?.status}`, innerErr.response?.data || innerErr.message);
          return { fecha, inversion: 0, ventas: 0, roas: 0, acos: 0, clicks: 0, prints: 0, directAmount: 0, indirectAmount: 0 };
        }
      }));
      dias.push(...results);
    }

    res.json({ from, to, dias });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    if (e.response?.status === 401 || e.response?.status === 403) {
      return res.json({ available: false, reason: 'ads_scope_missing' });
    }
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── COSTOS Y RENTABILIDAD ─────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/costos/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    const records = rows.map(r => {
      const costoTotal = parseFloat(r.costo_total);
      return {
        item_id:     String(r.item_id || '').trim(),
        title:       String(r.title   || '').trim(),
        tipo_prenda: null,
        pack:        1,
        costo_base:  isNaN(costoTotal) ? 0 : costoTotal,
        costo_total: isNaN(costoTotal) ? 0 : costoTotal,
        updated_at:  new Date().toISOString()
      };
    }).filter(r => r.item_id && r.costo_total > 0); // ignorar filas sin costo_total

    if (!records.length) return res.status(400).json({ error: 'Sin registros válidos en el Excel' });

    const { error } = await supabase.from('costos_productos').upsert(records, { onConflict: 'item_id' });
    if (error) throw new Error(error.message);
    costosCache = null;  // invalidar caché tras upload

    res.json({ saved: records.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agregar-costo-producto', async (req, res) => {
  try {
    const { item_id, title, costo_total } = req.body;
    if (!item_id) return res.status(400).json({ error: 'item_id requerido' });
    const costo = parseFloat(costo_total);
    if (!costo || costo <= 0) return res.status(400).json({ error: 'costo_total debe ser mayor a 0' });
    const record = {
      item_id:     String(item_id).trim(),
      title:       String(title || '').trim(),
      tipo_prenda: 'General',
      pack:        1,
      costo_base:  costo,
      costo_total: costo,
      updated_at:  new Date().toISOString()
    };
    const { error } = await supabase.from('costos_productos').upsert(record, { onConflict: 'item_id' });
    if (error) throw new Error(error.message);
    costosCache = null;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/descargar-plantilla-costos', async (req, res) => {
  try {
    const from = `${dateNDaysAgo(90)}T00:00:00.000-06:00`;
    const to   = `${today()}T23:59:59.000-06:00`;

    // Órdenes últimos 90 días (cap 1000)
    let orders = [], offset = 0, total = 1;
    while (offset < total && orders.length < 1000) {
      const r = await mlGet('https://api.mercadolibre.com/orders/search', {
        seller: getSellerId(), 'order.status': 'paid',
        'order.date_created.from': from, 'order.date_created.to': to,
        limit: 50, offset
      });
      total = r.paging.total;
      orders = orders.concat(r.results);
      offset += 50;
    }

    // Costos existentes
    if (!costosCache || Date.now() - costosCacheTime > COSTOS_TTL) {
      const { data } = await supabase.from('costos_productos').select('item_id,costo_total,costo_base,pack,tipo_prenda');
      costosCache = data || [];
      costosCacheTime = Date.now();
    }
    const costosMap = {};
    costosCache.forEach(c => { costosMap[c.item_id] = c; });

    // Agregar ventas por item
    const byItem = {};
    orders.forEach(o => {
      (o.order_items || []).forEach(oi => {
        const id = oi.item?.id;
        if (!id) return;
        const qty = oi.quantity || 1;
        if (!byItem[id]) byItem[id] = { item_id: id, title: oi.item?.title || id, venta_bruta: 0 };
        byItem[id].venta_bruta += (oi.unit_price || 0) * qty;
      });
    });

    const dataRows = Object.values(byItem)
      .sort((a, b) => b.venta_bruta - a.venta_bruta)
      .map(it => ({
        item_id:     it.item_id,
        title:       it.title,
        costo_total: costosMap[it.item_id]?.costo_total ?? ''
      }));

    // ── Generar Excel con ExcelJS ─────────────────────────────────────────────
    const C = {
      azul:      'FF2563EB',
      azulDark:  'FF1D4ED8',
      azulLight: 'FFDBEAFE',
      blanco:    'FFFFFFFF',
      grisTxt:   'FF6B7280',
      grisLight: 'FFF9FAFB',
      grisBorde: 'FFE5E7EB',
      amarillo:  'FFFEF9C3',
      zebra:     'FFF8FAFC',
      oscuro:    'FF111827',
      ambar:     'FF92400E',
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Rocky Dashboard';

    // ── Pestaña "Ayuda" ───────────────────────────────────────────────────────
    const wsA = wb.addWorksheet('Ayuda');
    // A=margen, B=contenido izq, C=gutter/número, D=contenido der
    wsA.columns = [
      { width: 2  },
      { width: 40 },
      { width: 3  },
      { width: 40 },
    ];

    // Banner
    wsA.mergeCells('A1:D1');
    const bannerCell = wsA.getCell('A1');
    bannerCell.value = '🚀  Rocky';
    bannerCell.font  = { bold: true, size: 26, color: { argb: C.blanco }, name: 'Calibri' };
    bannerCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.azul } };
    bannerCell.alignment = { vertical: 'middle', indent: 1 };
    wsA.getRow(1).height = 52;

    wsA.mergeCells('A2:D2');
    const bannerSub = wsA.getCell('A2');
    bannerSub.value = 'Dashboard de rentabilidad para vendedores de MercadoLibre';
    bannerSub.font  = { size: 10, color: { argb: C.blanco }, italic: true };
    bannerSub.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.azulDark } };
    bannerSub.alignment = { vertical: 'middle', indent: 2 };
    wsA.getRow(2).height = 18;

    wsA.getRow(3).height = 10;

    // Título y subtítulo
    wsA.mergeCells('A4:D4');
    const tituloCell = wsA.getCell('A4');
    tituloCell.value = 'Plantilla de Costos';
    tituloCell.font  = { bold: true, size: 16, color: { argb: C.oscuro } };
    tituloCell.alignment = { vertical: 'middle', indent: 1 };
    wsA.getRow(4).height = 28;

    wsA.mergeCells('A5:D5');
    const subtitCell = wsA.getCell('A5');
    subtitCell.value = 'Completa la planilla agregando el costo de cada uno de tus productos para calcular tu rentabilidad real.';
    subtitCell.font  = { size: 11, color: { argb: C.grisTxt } };
    subtitCell.alignment = { wrapText: true, indent: 1 };
    wsA.getRow(5).height = 24;

    // Separador azul
    wsA.getRow(6).height = 6;
    ['A','B','C','D'].forEach(col => {
      wsA.getCell(`${col}6`).border = { bottom: { style: 'medium', color: { argb: C.azul } } };
    });

    wsA.getRow(7).height = 8;

    // Headers de las dos columnas (fila 8)
    const styleColHdr = (cell, text) => {
      cell.value = text;
      cell.font  = { bold: true, size: 12, color: { argb: C.azul } };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.azulLight } };
      cell.alignment = { vertical: 'middle', indent: 1 };
    };
    styleColHdr(wsA.getCell('B8'), '¿Qué costos debo registrar?');
    styleColHdr(wsA.getCell('D8'), '¿Cómo lleno la plantilla?');
    wsA.getRow(8).height = 24;

    // Columna izquierda (filas 9-19)
    const leftLines = [
      { text: 'Registra el costo real que te cuesta cada producto — lo que pagas para comprarlo o producirlo.' },
      { text: '' },
      { text: '✅  Incluye en el costo:', bold: true, color: 'FF166534' },
      { text: '•  Precio de compra al proveedor', indent: 2 },
      { text: '•  Costo de producción o manufactura', indent: 2 },
      { text: '•  Empaque si va incluido en el costo unitario', indent: 2 },
      { text: '' },
      { text: '🚫  NO incluyas (Rocky los calcula por ti):', bold: true, color: 'FFDC2626' },
      { text: '•  Comisión de MercadoLibre', indent: 2 },
      { text: '•  Costo de envío', indent: 2 },
      { text: '•  Publicidad / Ads', indent: 2 },
    ];
    leftLines.forEach((line, i) => {
      const cell = wsA.getCell(`B${9 + i}`);
      cell.value = line.text || '';
      cell.font  = { size: 10, bold: !!line.bold, color: { argb: line.color || C.grisTxt } };
      cell.alignment = { wrapText: true, indent: line.indent || 1 };
      wsA.getRow(9 + i).height = (line.text || '').length > 60 ? 24 : 16;
    });

    // Columna derecha (pasos, filas 9-14)
    const rightSteps = [
      'Descarga esta plantilla desde Rocky y ábrela en Excel o Google Sheets.',
      'Ve a la pestaña "Costos" (la segunda pestaña de este archivo).',
      'En la columna costo_total escribe el costo de cada producto. Es la única columna que debes llenar.',
      'MUY IMPORTANTE: No modifiques la columna item_id — es el código único que Rocky usa para cruzar costos con ventas.',
      'Guarda el archivo y súbelo en Rocky con el botón "📤 Subir costos".',
    ];
    rightSteps.forEach((step, i) => {
      const rn = 9 + i;
      wsA.getCell(`C${rn}`).value = `${i + 1}.`;
      wsA.getCell(`C${rn}`).font  = { bold: true, size: 10, color: { argb: C.azul } };
      wsA.getCell(`C${rn}`).alignment = { horizontal: 'center', vertical: 'top' };
      wsA.getCell(`D${rn}`).value = step;
      wsA.getCell(`D${rn}`).font  = { size: 10, color: { argb: C.grisTxt } };
      wsA.getCell(`D${rn}`).alignment = { wrapText: true, vertical: 'top' };
      const needed = step.length > 80 ? 28 : 18;
      const current = wsA.getRow(rn).height || 16;
      wsA.getRow(rn).height = Math.max(current, needed);
    });

    // Tabla de descripción de columnas (fila 21+)
    wsA.getRow(20).height = 10;

    wsA.mergeCells('A21:D21');
    const tblTitleCell = wsA.getCell('A21');
    tblTitleCell.value = 'Descripción de columnas';
    tblTitleCell.font  = { bold: true, size: 12, color: { argb: C.oscuro } };
    tblTitleCell.alignment = { indent: 1 };
    wsA.getRow(21).height = 24;

    [['B', 'Columna'], ['D', 'Descripción']].forEach(([col, val]) => {
      const cell = wsA.getCell(`${col}22`);
      cell.value = val;
      cell.font  = { bold: true, color: { argb: C.blanco } };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.azul } };
      cell.alignment = { indent: 1, vertical: 'middle' };
    });
    wsA.getRow(22).height = 20;

    const colDescs = [
      ['item_id',     'Identificador único del producto en MercadoLibre. NO modificar nunca.', false],
      ['title',       'Nombre del producto. Solo referencia visual, no afecta los cálculos.', false],
      ['costo_total', 'OBLIGATORIO — Costo total del producto tal como lo adquieres o produces.', true],
    ];
    colDescs.forEach(([col, desc, isOblig], i) => {
      const rn = 23 + i;
      const bgFill = isOblig
        ? { type: 'pattern', pattern: 'solid', fgColor: { argb: C.amarillo } }
        : { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? C.grisLight : C.blanco } };
      const bdr = { bottom: { style: 'thin', color: { argb: C.grisBorde } } };

      const colCell = wsA.getCell(`B${rn}`);
      colCell.value  = col;
      colCell.font   = { size: 10, bold: isOblig, color: { argb: isOblig ? C.ambar : C.oscuro } };
      colCell.fill   = bgFill;
      colCell.border = bdr;
      colCell.alignment = { indent: 1 };

      const descCell = wsA.getCell(`D${rn}`);
      descCell.value  = desc;
      descCell.font   = { size: 10, color: { argb: isOblig ? C.ambar : C.grisTxt } };
      descCell.fill   = bgFill;
      descCell.border = bdr;
      descCell.alignment = { wrapText: true };

      wsA.getRow(rn).height = 18;
    });

    // ── Pestaña "Costos" ──────────────────────────────────────────────────────
    const wsC = wb.addWorksheet('Costos');
    wsC.columns = [
      { key: 'item_id',     width: 22 },
      { key: 'title',       width: 56 },
      { key: 'costo_total', width: 16 },
    ];

    // Headers con richText: nombre en negrita + ejemplo en gris pequeño
    const hdrDefs = [
      { name: 'item_id',     ex: 'Ej: MLM123456789 (no modificar)' },
      { name: 'title',       ex: 'Nombre del producto (referencia)' },
      { name: 'costo_total', ex: 'Ej: 250.00  ★ OBLIGATORIO' },
    ];

    const hRow = wsC.getRow(1);
    hRow.height = 36;
    hdrDefs.forEach((hd, ci) => {
      const cell = hRow.getCell(ci + 1);
      cell.value = {
        richText: [
          { text: hd.name + '\n', font: { bold: true, size: 11, color: { argb: C.blanco }, name: 'Calibri' } },
          { text: hd.ex,          font: { size: 8, italic: true, color: { argb: 'FFBFDBFE' }, name: 'Calibri' } },
        ]
      };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.azul } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border    = { right: { style: 'thin', color: { argb: C.azulDark } } };
    });

    // Filas de datos: zebra striping + amarillo en costo_total
    dataRows.forEach((row, idx) => {
      const r = wsC.addRow([row.item_id, row.title, row.costo_total]);
      const zebraFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 0 ? C.zebra : C.blanco } };
      const amarFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.amarillo } };
      for (let ci = 1; ci <= 3; ci++) {
        const cell = r.getCell(ci);
        cell.fill      = ci === 3 ? amarFill : zebraFill;
        cell.font      = { size: 10, color: { argb: C.oscuro } };
        cell.alignment = { vertical: 'middle' };
        cell.border    = { bottom: { style: 'thin', color: { argb: C.grisBorde } } };
      }
      r.height = 18;
    });

    // Freeze header
    wsC.views = [{ state: 'frozen', ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-costos-rocky.xlsx"');
    res.send(buf);
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── FINANZAS: helper compartido ──────────────────────────────────────────────

async function getFinancialPeriod(from, to) {
  const fromISO = `${from}T00:00:00.000-06:00`;
  const toISO   = `${to}T23:59:59.000-06:00`;

  // 1. Paginar órdenes
  let orders = [], offset = 0, total = 1;
  while (offset < total && orders.length < 2000) {
    const r = await mlGet('https://api.mercadolibre.com/orders/search', {
      seller: getSellerId(), 'order.status': 'paid',
      'order.date_created.from': fromISO, 'order.date_created.to': toISO,
      limit: 50, offset
    });
    total = r.paging.total;
    orders = orders.concat(r.results);
    offset += 50;
  }

  // 2. Costos de envío (caché de objetos completos + concurrencia 5)
  const shippingIds = [...new Set(orders.filter(o => o.shipping?.id).map(o => o.shipping.id))];
  const missingShipIds = shippingIds.filter(id => !shipmentCache.has(id));
  for (let i = 0; i < missingShipIds.length; i += 5) {
    const batch = missingShipIds.slice(i, i + 5);
    const results = await Promise.all(batch.map(id =>
      mlGet(`https://api.mercadolibre.com/shipments/${id}`).catch(() => null)
    ));
    results.forEach((r, j) => { if (r) shipmentCache.set(batch[j], r); });
  }
  const shippingCosts = {};
  shippingIds.forEach(id => {
    const s = shipmentCache.get(id);
    shippingCosts[id] = s ? (s.shipping_option?.list_cost ?? s.base_cost ?? 0) : 0;
  });
  const shipOrderCount = {};
  orders.forEach(o => { if (o.shipping?.id) shipOrderCount[o.shipping.id] = (shipOrderCount[o.shipping.id] || 0) + 1; });

  // 3. Inversión publicidad (total de campañas + desglose por item)
  let inversion_publicidad = 0;
  const adsItemMap = {};
  try {
    const campResp = await mlGetAds(
      `https://api.mercadolibre.com/advertising/MLM/advertisers/${getAdvertiserId()}/product_ads/campaigns/search`,
      { date_from: from, date_to: to, metrics: 'cost' }
    );
    inversion_publicidad = (campResp.results || []).reduce((s, c) => s + (c.metrics?.cost || 0), 0);
    let ao = 0, at = 1;
    while (ao < at) {
      const d = await mlGetAds(
        `https://api.mercadolibre.com/advertising/MLM/advertisers/${getAdvertiserId()}/product_ads/ads/search`,
        { date_from: from, date_to: to, metrics: 'cost', limit: 50, offset: ao }
      );
      at = d.paging.total;
      (d.results || []).forEach(a => { if (a.item_id) adsItemMap[a.item_id] = (adsItemMap[a.item_id] || 0) + (a.metrics?.cost || 0); });
      ao += 50;
    }
  } catch (e) { /* ads no disponibles */ }

  // 4. Costos de Supabase (caché 30 min)
  if (!costosCache || Date.now() - costosCacheTime > COSTOS_TTL) {
    const { data } = await supabase.from('costos_productos').select('item_id,costo_total,pack');
    costosCache = data || [];
    costosCacheTime = Date.now();
  }
  const costosMap = {};
  costosCache.forEach(c => { costosMap[c.item_id] = c; });

  // 5. Agregar por item_id
  const byItem = {};
  const totals = { venta_bruta: 0, comision_ml: 0, costo_envio: 0, costo_producto: 0 };
  orders.forEach(o => {
    const sid = o.shipping?.id;
    const orderEnvioCost = sid ? (shippingCosts[sid] || 0) / (shipOrderCount[sid] || 1) : 0;
    const totalQty = (o.order_items || []).reduce((s, i) => s + (i.quantity || 1), 0);
    (o.order_items || []).forEach(oi => {
      const itemId = oi.item?.id;
      if (!itemId) return;
      const qty     = oi.quantity || 1;
      const venta   = (oi.unit_price || 0) * qty;
      const comision= oi.sale_fee || 0;
      const envio   = totalQty > 0 ? orderEnvioCost * qty / totalQty : 0;
      const costoE  = costosMap[itemId];
      const costo   = costoE ? costoE.costo_total * qty : 0;
      if (!byItem[itemId]) byItem[itemId] = {
        item_id: itemId, title: oi.item?.title || itemId,
        unidades: 0, venta_bruta: 0, comision_ml: 0,
        costo_envio: 0, costo_producto: 0, tiene_costo: !!costoE
      };
      byItem[itemId].unidades      += qty;
      byItem[itemId].venta_bruta   += venta;
      byItem[itemId].comision_ml   += comision;
      byItem[itemId].costo_envio   += envio;
      byItem[itemId].costo_producto+= costo;
      totals.venta_bruta    += venta;
      totals.comision_ml    += comision;
      totals.costo_envio    += envio;
      totals.costo_producto += costo;
    });
  });

  Object.keys(byItem).forEach(id => { byItem[id].publicidad = adsItemMap[id] || 0; });

  const items = Object.values(byItem).map(it => {
    const utilidad = it.venta_bruta - it.comision_ml - it.costo_envio - it.costo_producto - it.publicidad;
    const margen   = it.venta_bruta > 0 ? utilidad / it.venta_bruta * 100 : 0;
    return { ...it, utilidad, margen };
  }).sort((a, b) => b.utilidad - a.utilidad);

  totals.inversion_publicidad = inversion_publicidad;
  totals.utilidad       = totals.venta_bruta - totals.comision_ml - totals.costo_envio - totals.costo_producto - inversion_publicidad;
  totals.margen_promedio= totals.venta_bruta > 0 ? totals.utilidad / totals.venta_bruta * 100 : 0;

  return { items, totals, total_ordenes: orders.length, costosMap };
}

app.get('/api/rentabilidad', async (req, res) => {
  try {
    const from = req.query.from || dateNDaysAgo(6);
    const to   = req.query.to   || today();
    // Usar cache si está caliente; si no, hacer count rápido para evitar pipeline costoso
    const hasCostos = costosCache
      ? costosCache.length > 0
      : ((await supabase.from('costos_productos').select('*', { count: 'exact', head: true })).count || 0) > 0;
    if (!hasCostos) return res.json({ sin_costos: true, from, to });
    const data = await getFinancialPeriod(from, to);
    res.json({ from, to, ...data });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.get('/api/sin-costo-historico', async (req, res) => {
  try {
    const from = `${dateNDaysAgo(90)}T00:00:00.000-06:00`;
    const to   = `${today()}T23:59:59.000-06:00`;

    // Paginar órdenes de los últimos 90 días (cap 1000)
    let orders = [], offset = 0, total = 1;
    while (offset < total && orders.length < 1000) {
      const r = await mlGet('https://api.mercadolibre.com/orders/search', {
        seller: getSellerId(), 'order.status': 'paid',
        'order.date_created.from': from, 'order.date_created.to': to,
        limit: 50, offset
      });
      total = r.paging.total;
      orders = orders.concat(r.results);
      offset += 50;
    }

    // Costos (reutiliza caché si está caliente)
    if (!costosCache || Date.now() - costosCacheTime > COSTOS_TTL) {
      const { data } = await supabase.from('costos_productos').select('item_id,costo_total,pack');
      costosCache = data || [];
      costosCacheTime = Date.now();
    }
    const costosIds = new Set(costosCache.map(c => c.item_id));

    // Agregar por item_id, saltando los que ya tienen costo
    const byItem = {};
    orders.forEach(o => {
      (o.order_items || []).forEach(oi => {
        const id = oi.item?.id;
        if (!id || costosIds.has(id)) return;
        const qty = oi.quantity || 1;
        if (!byItem[id]) byItem[id] = { item_id: id, title: oi.item?.title || id, venta_bruta: 0, unidades: 0 };
        byItem[id].venta_bruta += (oi.unit_price || 0) * qty;
        byItem[id].unidades += qty;
      });
    });

    const items = Object.values(byItem).sort((a, b) => b.venta_bruta - a.venta_bruta);
    res.json({ items });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.get('/api/precio-sugerido', async (req, res) => {
  try {
    const from = req.query.from || dateNDaysAgo(29);
    const to   = req.query.to   || today();
    const { items } = await getFinancialPeriod(from, to);
    const result = items.filter(it => it.tiene_costo && it.unidades > 0).map(it => {
      const precio_actual  = it.venta_bruta / it.unidades;
      const costo_unitario = (it.comision_ml + it.costo_envio + it.costo_producto) / it.unidades;
      return {
        item_id: it.item_id, title: it.title, unidades: it.unidades,
        precio_actual, margen_actual: it.margen,
        precio_para_20: costo_unitario / 0.80,
        precio_para_25: costo_unitario / 0.75,
        precio_para_30: costo_unitario / 0.70,
      };
    });
    res.json({ from, to, items: result });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── Billing resumen: pagina /billing/integration/...details y agrupa por sub-tipo ──
// Caché en dos capas: Map en memoria (rápido) + Supabase billing_cache (persiste reinicios)
// SQL para crear la tabla en Supabase:
//   CREATE TABLE billing_cache (
//     period_key text PRIMARY KEY,
//     data       jsonb NOT NULL,
//     updated_at timestamptz NOT NULL DEFAULT now()
//   );

async function saveBillingToSupabase(periodKey, data) {
  try {
    await supabase.from('billing_cache').upsert({
      period_key: periodKey,
      data,
      updated_at: new Date().toISOString()
    }, { onConflict: 'period_key' });
  } catch (e) {
    console.warn('billing_cache upsert error:', e.message);
  }
}

async function loadBillingFromSupabase(periodKey) {
  try {
    const { data, error } = await supabase
      .from('billing_cache')
      .select('data, updated_at')
      .eq('period_key', periodKey)
      .maybeSingle();
    if (error || !data) return null;
    return { data: data.data, updatedAt: new Date(data.updated_at).getTime() };
  } catch (e) {
    console.warn('billing_cache select error:', e.message);
    return null;
  }
}

async function getBillingResumen(month, year) {
  const cacheKey = `${year}-${month}`;
  const periodKey = `${year}-${String(month).padStart(2,'0')}`;
  const now = Date.now();
  const BILLING_TTL = 60 * 60 * 1000;
  const isCurrentMonth = (month === new Date().getMonth() + 1 && year === new Date().getFullYear());

  // 1. Caché en memoria
  const mem = billingCache.get(cacheKey);
  if (mem && (!isCurrentMonth || (now - mem.ts) < BILLING_TTL)) return mem.data;

  // 2. Caché en Supabase (meses pasados: permanente; mes actual: 1h)
  const sb = await loadBillingFromSupabase(periodKey);
  if (sb) {
    const fresh = !isCurrentMonth || (now - sb.updatedAt) < BILLING_TTL;
    if (fresh) {
      billingCache.set(cacheKey, { data: sb.data, ts: sb.updatedAt });
      return sb.data;
    }
  }

  // 3. Consultar API de billing paginando con offset
  const key  = `${year}-${String(month).padStart(2,'0')}-01`;
  const base = `https://api.mercadolibre.com/billing/integration/periods/key/${key}/group/ML/details`;
  const LIMIT = 1000;

  const sums = {};
  let offset = 0, fetched = 0, total = Infinity;

  while (fetched < total) {
    const url = `${base}?user_id=${getSellerId()}&document_type=BILL&limit=${LIMIT}&offset=${offset}`;
    let r;
    try {
      r = await mlGet(url, {});
    } catch (e) {
      if (e.response?.status === 429) {
        await new Promise(res => setTimeout(res, 15000));
        r = await mlGet(url, {});
      } else throw e;
    }
    if (total === Infinity) total = r.total || 0;
    const results = r.results || [];
    if (!results.length) break;

    for (const rec of results) {
      const sub = rec.charge_info?.detail_sub_type || 'OTHER';
      const amt = rec.charge_info?.detail_amount || 0;
      sums[sub] = (sums[sub] || 0) + amt;
    }
    fetched += results.length;
    offset  += results.length;

    // 15s entre páginas para respetar el rate-limit de billing (5 req/min)
    if (fetched < total) await new Promise(res => setTimeout(res, 15000));
  }

  const g = (keys) => keys.reduce((s, k) => s + (sums[k] || 0), 0);
  const comisiones_venta    = g(['CV']);
  const costo_envios        = g(['CFF', 'CXD']);
  const publicidad          = g(['PADS']);
  const anulaciones         = g(['BV', 'BFF', 'BXD']);
  const almacenamiento_full = g(['CFWA']);
  const mantenimiento_pagina= g(['CESM']);
  const cargos_devolucion   = g(['CDSD']);
  const afiliados           = g(['CVAF']);
  const asesoria_otros      = g(['CPAC']);
  const envios_full         = g(['CFRS']);
  const cross_docking_full  = g(['CFCB', 'CFBA']);
  const total_cargos = comisiones_venta + costo_envios + publicidad - anulaciones
    + almacenamiento_full + mantenimiento_pagina + cargos_devolucion + afiliados
    + asesoria_otros + envios_full + cross_docking_full;

  const data = {
    key, month, year,
    comisiones_venta, costo_envios, publicidad, anulaciones,
    almacenamiento_full, mantenimiento_pagina, cargos_devolucion, afiliados,
    asesoria_otros, envios_full, cross_docking_full,
    total_cargos, raw: sums
  };

  // Guarda en ambas capas de caché
  billingCache.set(cacheKey, { data, ts: now });
  await saveBillingToSupabase(periodKey, data);
  return data;
}

app.get('/api/billing-resumen', async (req, res) => {
  try {
    const now   = new Date();
    const month = parseInt(req.query.month) || (now.getMonth() + 1);
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const data  = await getBillingResumen(month, year);
    res.json(data);
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.get('/api/estado-resultados', async (req, res) => {
  try {
    const now = new Date();
    const month = parseInt(req.query.month) || (now.getMonth() + 1);
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const from  = `${year}-${String(month).padStart(2,'0')}-01`;
    const to    = `${year}-${String(month).padStart(2,'0')}-${String(new Date(year, month, 0).getDate()).padStart(2,'0')}`;
    const prevD = new Date(year, month - 2, 1);
    const pm = prevD.getMonth() + 1, py = prevD.getFullYear();
    const pfrom = `${py}-${String(pm).padStart(2,'0')}-01`;
    const pto   = `${py}-${String(pm).padStart(2,'0')}-${String(new Date(py, pm, 0).getDate()).padStart(2,'0')}`;

    const [curr, prev, billing, billingPrev] = await Promise.all([
      getFinancialPeriod(from, to),
      getFinancialPeriod(pfrom, pto),
      getBillingResumen(month, year),
      getBillingResumen(pm, py),
    ]);

    // Construye los totales del mes mezclando órdenes y billing:
    // comision_ml, costo_envio, inversion_publicidad vienen de billing (fuente oficial ML)
    // venta_bruta y costo_producto vienen de órdenes (billing no los tiene)
    const buildTotals = (orders, b) => {
      const vb   = orders.totals.venta_bruta;
      const cp   = orders.totals.costo_producto;
      const cm   = b.comisiones_venta  || 0;
      const ce   = b.costo_envios      || 0;
      const pub  = b.publicidad        || 0;
      const utilBruta = vb - cm - ce - cp;
      const extraNet  = -(b.asesoria_otros||0) - (b.envios_full||0) - (b.cross_docking_full||0)
        - (b.almacenamiento_full||0) - (b.mantenimiento_pagina||0)
        - (b.cargos_devolucion||0) - (b.afiliados||0) + (b.anulaciones||0);
      const utilidad      = utilBruta - pub;
      const utilidad_neta = utilidad + extraNet;
      const margen_promedio = vb > 0 ? utilidad_neta / vb * 100 : 0;
      return {
        venta_bruta: vb, costo_producto: cp,
        comision_ml: cm, costo_envio: ce, inversion_publicidad: pub,
        utilidad, utilidad_neta, margen_promedio,
        total_ordenes: orders.total_ordenes,
        billing: b,
      };
    };

    const cTotals = buildTotals(curr, billing);
    const pTotals = buildTotals(prev, billingPrev);

    const delta = (a, b) => b > 0 ? (a - b) / b * 100 : null;
    res.json({
      month, year, from, to,
      current:  cTotals,
      previous: pTotals,
      delta: {
        venta_bruta:          delta(cTotals.venta_bruta,          pTotals.venta_bruta),
        comision_ml:          delta(cTotals.comision_ml,          pTotals.comision_ml),
        costo_envio:          delta(cTotals.costo_envio,          pTotals.costo_envio),
        costo_producto:       delta(cTotals.costo_producto,       pTotals.costo_producto),
        inversion_publicidad: delta(cTotals.inversion_publicidad, pTotals.inversion_publicidad),
        utilidad:             delta(cTotals.utilidad,             pTotals.utilidad),
        asesoria_otros:       delta(billing.asesoria_otros,       billingPrev.asesoria_otros),
        envios_full:          delta(billing.envios_full,          billingPrev.envios_full),
        cross_docking_full:   delta(billing.cross_docking_full,   billingPrev.cross_docking_full),
        almacenamiento_full:  delta(billing.almacenamiento_full,  billingPrev.almacenamiento_full),
        mantenimiento_pagina: delta(billing.mantenimiento_pagina, billingPrev.mantenimiento_pagina),
        cargos_devolucion:    delta(billing.cargos_devolucion,    billingPrev.cargos_devolucion),
        afiliados:            delta(billing.afiliados,            billingPrev.afiliados),
        anulaciones:          delta(billing.anulaciones,          billingPrev.anulaciones),
        utilidad_neta:        delta(cTotals.utilidad_neta,        pTotals.utilidad_neta),
      }
    });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.get('/api/tendencia-financiera', async (req, res) => {
  try {
    const n = Math.min(parseInt(req.query.months) || 6, 12);
    const now = new Date();
    const ranges = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = d.getFullYear(), m = d.getMonth() + 1;
      const ms = String(m).padStart(2,'0');
      ranges.push({
        label: d.toLocaleString('es-MX', { month: 'short', year: 'numeric' }),
        from: `${y}-${ms}-01`,
        to:   `${y}-${ms}-${String(new Date(y, m, 0).getDate()).padStart(2,'0')}`
      });
    }

    // Órdenes en paralelo por mes
    const fromISOs = ranges.map(r => `${r.from}T00:00:00.000-06:00`);
    const toISOs   = ranges.map(r => `${r.to}T23:59:59.000-06:00`);
    const monthOrders = await Promise.all(ranges.map(async (r, ri) => {
      let orders = [], offset = 0, total = 1;
      while (offset < total && orders.length < 2000) {
        const d = await mlGet('https://api.mercadolibre.com/orders/search', {
          seller: getSellerId(), 'order.status': 'paid',
          'order.date_created.from': fromISOs[ri], 'order.date_created.to': toISOs[ri],
          limit: 50, offset
        });
        total = d.paging.total;
        orders = orders.concat(d.results);
        offset += 50;
      }
      return orders;
    }));

    // Shipment IDs únicos de todos los meses — sólo fetcha los que no están en caché
    const allShipIds = [...new Set(monthOrders.flat().filter(o => o.shipping?.id).map(o => o.shipping.id))];
    const missingAll = allShipIds.filter(id => !shipmentCache.has(id));
    for (let i = 0; i < missingAll.length; i += 10) {
      const batch = missingAll.slice(i, i + 10);
      const results = await Promise.all(batch.map(id =>
        mlGet(`https://api.mercadolibre.com/shipments/${id}`).catch(() => null)
      ));
      results.forEach((r, j) => { if (r) shipmentCache.set(batch[j], r); });
    }
    const shippingCosts = {};
    allShipIds.forEach(id => {
      const s = shipmentCache.get(id);
      shippingCosts[id] = s ? (s.shipping_option?.list_cost ?? s.base_cost ?? 0) : 0;
    });
    const shipOrderCount = {};
    monthOrders.flat().forEach(o => { if (o.shipping?.id) shipOrderCount[o.shipping.id] = (shipOrderCount[o.shipping.id] || 0) + 1; });

    // Costos de producto (caché 30 min)
    if (!costosCache || Date.now() - costosCacheTime > COSTOS_TTL) {
      const { data } = await supabase.from('costos_productos').select('item_id,costo_total,pack');
      costosCache = data || [];
      costosCacheTime = Date.now();
    }
    const costosMap = {};
    costosCache.forEach(c => { costosMap[c.item_id] = c; });

    // Ads en paralelo por mes
    const adsPerMonth = await Promise.all(ranges.map(async r => {
      try {
        const d = await mlGetAds(
          `https://api.mercadolibre.com/advertising/MLM/advertisers/${getAdvertiserId()}/product_ads/campaigns/search`,
          { date_from: r.from, date_to: r.to, metrics: 'cost' }
        );
        return (d.results || []).reduce((s, c) => s + (c.metrics?.cost || 0), 0);
      } catch (e) { return 0; }
    }));

    // Agregar por mes
    const monthData = ranges.map((r, mi) => {
      const orders = monthOrders[mi];
      let venta_bruta = 0, comision_ml = 0, costo_envio = 0, costo_producto = 0;
      orders.forEach(o => {
        const sid = o.shipping?.id;
        const envioOrden = sid ? (shippingCosts[sid] || 0) / (shipOrderCount[sid] || 1) : 0;
        const totalQty = (o.order_items || []).reduce((s, i) => s + (i.quantity || 1), 0);
        (o.order_items || []).forEach(oi => {
          const qty = oi.quantity || 1;
          venta_bruta   += (oi.unit_price || 0) * qty;
          comision_ml   += oi.sale_fee || 0;
          costo_envio   += totalQty > 0 ? envioOrden * qty / totalQty : 0;
          const ce = costosMap[oi.item?.id];
          costo_producto += ce ? ce.costo_total * qty : 0;
        });
      });
      const inversion_publicidad = adsPerMonth[mi];
      const utilidad = venta_bruta - comision_ml - costo_envio - costo_producto - inversion_publicidad;
      const margen   = venta_bruta > 0 ? utilidad / venta_bruta * 100 : 0;
      return { label: r.label, from: r.from, to: r.to, venta_bruta, comision_ml, costo_envio, costo_producto, inversion_publicidad, utilidad, margen, total_ordenes: orders.length };
    });

    res.json({ months: monthData });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── Preguntas ────────────────────────────────────────────────────────────────

// GET /api/preguntas/metricas — tiempos de respuesta de las últimas 100 ANSWERED
app.get('/api/preguntas/metricas', async (req, res) => {
  try {
    const data = await mlGet('https://api.mercadolibre.com/questions/search', {
      seller_id: getSellerId(), status: 'ANSWERED', limit: 100, offset: 0
    });
    const questions = (data.questions || []).filter(q => q.answer?.date_created);

    let sumHoras = 0;
    let menos1h = 0, entre1y4h = 0, mas4h = 0;

    for (const q of questions) {
      const diffMs = new Date(q.answer.date_created) - new Date(q.date_created);
      const horas  = diffMs / 3600000;
      sumHoras += horas;
      if (horas < 1)       menos1h++;
      else if (horas <= 4) entre1y4h++;
      else                 mas4h++;
    }

    const total = questions.length;
    res.json({
      total_respondidas:      data.total || 0,
      muestra:                total,
      tiempo_promedio_horas:  total > 0 ? sumHoras / total : 0,
      respondidas_menos_1h:   menos1h,
      respondidas_1_4h:       entre1y4h,
      respondidas_mas_4h:     mas4h,
      pct_menos_1h:           total > 0 ? Math.round(menos1h / total * 100) : 0
    });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// GET /api/preguntas?status=UNANSWERED|ANSWERED&limit=50&offset=0
app.get('/api/preguntas', async (req, res) => {
  try {
    const status = req.query.status || 'UNANSWERED';
    const limit  = Math.min(parseInt(req.query.limit) || 50, 50);
    const offset = parseInt(req.query.offset) || 0;

    const mlParams = { seller_id: getSellerId(), status, limit, offset };
    // ML acepta sort=date_created_desc / date_created_asc
    if (status === 'ANSWERED') mlParams.sort = 'date_created_desc';

    const data = await mlGet('https://api.mercadolibre.com/questions/search', mlParams);

    const questions = data.questions || [];

    // Enriquece con título e imagen de cada item (dedupado)
    const itemIds = [...new Set(questions.map(q => q.item_id).filter(Boolean))];
    const itemMap = {};
    await Promise.all(itemIds.map(async id => {
      try {
        const item = await mlGet(`https://api.mercadolibre.com/items/${id}`, { attributes: 'id,title,thumbnail' });
        itemMap[id] = { title: item.title, thumbnail: item.thumbnail };
      } catch { itemMap[id] = { title: id, thumbnail: null }; }
    }));

    const enriched = questions.map(q => ({
      ...q,
      item: itemMap[q.item_id] || { title: q.item_id, thumbnail: null }
    }));

    // Para UNANSWERED, ML cierra preguntas después de 30 días; filtrarlas
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const filtered = status === 'UNANSWERED'
      ? enriched.filter(q => new Date(q.date_created).getTime() >= cutoff)
      : enriched;

    res.json({ total: filtered.length, offset, limit, questions: filtered });
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// POST /api/preguntas/:id/responder  body: { text }
app.post('/api/preguntas/:id/responder', async (req, res) => {
  try {
    const ctx = requestCtx.getStore();
    const isTenant = !!ctx?.tenant;
    const fetchFreshToken = () => isTenant ? refreshTenantToken(ctx.tenant) : refreshToken();
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'text requerido' });
    const token = isTenant ? await getTenantToken(ctx.tenant) : await getToken();
    const body = { question_id: parseInt(req.params.id), text: text.trim() };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    try {
      const r = await axios.post('https://api.mercadolibre.com/answers', body, { headers });
      return res.json(r.data);
    } catch (e) {
      if (e.response?.status === 401) {
        const freshToken = await fetchFreshToken();
        const r = await axios.post('https://api.mercadolibre.com/answers', body, {
          headers: { ...headers, Authorization: `Bearer ${freshToken}` },
        });
        return res.json(r.data);
      }
      throw e;
    }
  } catch (e) {
    console.error('[preguntas/responder] Error ML:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// ── DIRECTOR COMERCIAL AI ────────────────────────────────────────────────────

const NO_KEY_MSG = 'Para activar el Director Comercial AI necesitas agregar créditos en platform.anthropic.com y configurar tu API key en el archivo .env (ANTHROPIC_API_KEY=tu_key).';

app.post('/api/ai-director', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message requerido' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.json({ response: NO_KEY_MSG, data_used: [] });
  }

  // Build current-month date range (Mexico City offset -06:00)
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const mm    = String(month).padStart(2, '0');
  const dd    = String(now.getDate()).padStart(2, '0');
  const fromMes  = `${year}-${mm}-01`;
  const toMes    = `${year}-${mm}-${dd}`;
  const todayStr = toMes;

  // Fetch ALL business data in parallel
  const [ventasMesR, ventasHoyR, stockR, adsR, rentabilidadR, devolucionesR, reputacionR, billingR] =
    await Promise.allSettled([

      // 1. Ventas del mes (paginated)
      (async () => {
        const from = `${fromMes}T00:00:00.000-06:00`;
        const to   = `${toMes}T23:59:59.000-06:00`;
        let allOrders = [], offset = 0, total = 1;
        while (offset < total) {
          const d = await mlGet('https://api.mercadolibre.com/orders/search', {
            seller: getSellerId(), 'order.status': 'paid',
            'order.date_created.from': from, 'order.date_created.to': to,
            limit: 50, offset
          });
          total = d.paging.total;
          allOrders = allOrders.concat(d.results);
          offset += 50;
        }
        const ventaBruta = allOrders.reduce((s, o) => s + o.total_amount, 0);
        const unidades   = allOrders.reduce((s, o) => s + o.order_items.reduce((ss, i) => ss + i.quantity, 0), 0);
        const byProduct = {};
        allOrders.forEach(o => o.order_items.forEach(i => {
          const t = i.item.title;
          if (!byProduct[t]) byProduct[t] = { revenue: 0, units: 0 };
          byProduct[t].revenue += o.total_amount;
          byProduct[t].units   += i.quantity;
        }));
        const top10 = Object.entries(byProduct)
          .sort((a, b) => b[1].revenue - a[1].revenue)
          .slice(0, 10).map(([title, v]) => ({ title, ...v }));
        return { ordenes: total, ventaBruta, unidades, top10 };
      })(),

      // 2. Ventas de hoy
      (async () => {
        const from = `${todayStr}T00:00:00.000-06:00`;
        const to   = `${todayStr}T23:59:59.000-06:00`;
        const orders = await fetchPaidOrders(from, to);
        const ventaBruta = orders.reduce((s, o) => s + o.total_amount, 0);
        const unidades   = orders.reduce((s, o) => s + o.order_items.reduce((ss, i) => ss + i.quantity, 0), 0);
        return { ordenes: orders.length, ventaBruta, unidades };
      })(),

      // 3. Stock inteligente (3-month analysis)
      computeStockInteligente(),

      // 4. Publicidad del mes (omitido si el tenant no tiene advertiser_id)
      (async () => {
        const adsCtx = requestCtx.getStore();
        if (adsCtx?.tenant && !adsCtx.tenant.advertiser_id) {
          return { available: false, campaignsCount: 0, inversion: 0, ventasAds: 0, roasTotal: 0, acosTotal: 0, acosAlto: [] };
        }
        try {
          const ADS_M = 'clicks,prints,cost,acos,roas,total_amount,units_quantity';
          const campResp = await mlGetAds(
            `https://api.mercadolibre.com/advertising/MLM/advertisers/${getAdvertiserId()}/product_ads/campaigns/search`,
            { date_from: fromMes, date_to: toMes, metrics: ADS_M }
          );
          let ads = [], ao = 0, at = 1;
          while (ao < at) {
            const d = await mlGetAds(
              `https://api.mercadolibre.com/advertising/MLM/advertisers/${getAdvertiserId()}/product_ads/ads/search`,
              { date_from: fromMes, date_to: toMes, metrics: 'clicks,cost,acos,roas,total_amount', limit: 50, offset: ao }
            );
            at = d.paging.total;
            ads = ads.concat(d.results);
            ao += 50;
          }
          const campaigns = campResp.results || [];
          const inversion  = campaigns.reduce((s, c) => s + (c.metrics?.cost || 0), 0);
          const ventasAds  = campaigns.reduce((s, c) => s + (c.metrics?.total_amount || 0), 0);
          const roasTotal  = inversion > 0 ? ventasAds / inversion : 0;
          const acosTotal  = ventasAds > 0 ? inversion / ventasAds * 100 : 0;
          const acosAlto   = ads
            .filter(a => (a.metrics?.acos || 0) > 30 && (a.metrics?.cost || 0) > 50)
            .sort((a, b) => (b.metrics?.cost || 0) - (a.metrics?.cost || 0))
            .slice(0, 5)
            .map(a => ({ title: a.ad_title || a.item_id, acos: a.metrics?.acos, cost: a.metrics?.cost }));
          return { campaignsCount: campaigns.length, inversion, ventasAds, roasTotal, acosTotal, acosAlto };
        } catch (e) { return { campaignsCount: 0, inversion: 0, ventasAds: 0, roasTotal: 0, acosTotal: 0, acosAlto: [] }; }
      })(),

      // 5. Rentabilidad del mes
      getFinancialPeriod(fromMes, toMes),

      // 6. Devoluciones y reclamos abiertos
      (async () => {
        const [opened, closed] = await Promise.all([
          mlGet('https://api.mercadolibre.com/post-purchase/v1/claims/search', { seller_id: getSellerId(), status: 'opened', limit: 50 }),
          mlGet('https://api.mercadolibre.com/post-purchase/v1/claims/search', { seller_id: getSellerId(), status: 'closed', limit: 50 }),
        ]);
        const openClaims = opened.data || [];
        const urgente = openClaims.filter(c => {
          const seller = (c.players || []).find(p => p.role === 'respondent');
          return (seller?.available_actions || []).some(a => a.mandatory);
        }).length;
        return { abiertos: opened.paging?.total || 0, cerrados: closed.paging?.total || 0, urgente };
      })(),

      // 7. Reputación
      (async () => {
        const data = await mlGet(`https://api.mercadolibre.com/users/${getSellerId()}`);
        const rep = data.seller_reputation;
        return {
          nivel:           rep.level_id,
          reclamos:        rep.metrics?.claims?.rate || 0,
          cancelaciones:   rep.metrics?.cancellations?.rate || 0,
          enviosDemorados: rep.metrics?.delayed_handling_time?.rate || 0,
          completadas60d:  rep.transactions?.completed || 0,
        };
      })(),

      // 8. Billing del mes
      getBillingResumen(month, year),
    ]);

  const data_used = [];
  const safe = (r, name) => {
    if (r.status === 'fulfilled') { data_used.push(name); return r.value; }
    return null;
  };
  const ventasMes    = safe(ventasMesR,    'ventas_mes');
  const ventasHoy    = safe(ventasHoyR,    'ventas_hoy');
  const stock        = safe(stockR,        'stock');
  const ads          = safe(adsR,          'publicidad');
  const rentabilidad = safe(rentabilidadR, 'rentabilidad');
  const devoluciones = safe(devolucionesR, 'devoluciones');
  const reputacion   = safe(reputacionR,   'reputacion');
  const billing      = safe(billingR,      'billing');

  // Build detailed system prompt with real data
  const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const lines = [
    'Eres el Director Comercial AI de Holstone, una marca de ropa deportiva/casual que vende en MercadoLibre México como vendedor Platinum.',
    'Tu rol: analizar los datos en tiempo real del negocio y dar recomendaciones estratégicas concretas y accionables.',
    'Responde SIEMPRE en español. Sé conciso y directo. Usa bullets cuando sea apropiado. Cuando respondas, usa los números específicos del contexto.',
    `FECHA ACTUAL: ${todayStr} | MES: ${MESES[month-1]} ${year}`,
    '',
    '=== DATOS EN TIEMPO REAL DE HOLSTONE ===',
    '',
  ];

  if (ventasMes) {
    const ticket = ventasMes.ordenes > 0 ? ventasMes.ventaBruta / ventasMes.ordenes : 0;
    lines.push(`## VENTAS DEL MES (${MESES[month-1]} ${year})`);
    lines.push(`- Órdenes: ${ventasMes.ordenes}`);
    lines.push(`- Venta bruta: $${ventasMes.ventaBruta.toFixed(2)} MXN`);
    lines.push(`- Unidades vendidas: ${ventasMes.unidades}`);
    lines.push(`- Ticket promedio: $${ticket.toFixed(0)} MXN`);
    if (ventasMes.top10?.length) {
      lines.push(`- TOP 10 PRODUCTOS (por ingresos del mes):`);
      ventasMes.top10.forEach((p, i) =>
        lines.push(`  ${i+1}. "${p.title}" → $${p.revenue.toFixed(0)} MXN | ${p.units} uds`)
      );
    }
    lines.push('');
  }

  if (ventasHoy) {
    lines.push(`## VENTAS DE HOY (${todayStr})`);
    lines.push(`- Órdenes: ${ventasHoy.ordenes}`);
    lines.push(`- Venta bruta: $${ventasHoy.ventaBruta.toFixed(2)} MXN`);
    lines.push(`- Unidades: ${ventasHoy.unidades}`);
    lines.push('');
  }

  if (stock) {
    const { summary } = stock;
    lines.push(`## INVENTARIO (STOCK INTELIGENTE)`);
    lines.push(`- Publicaciones activas: ${summary.total}`);
    lines.push(`- Sin stock (agotados): ${summary.agotados}`);
    lines.push(`- Stock crítico (≤7 días restantes): ${summary.criticos}`);
    lines.push(`- Stock bajo (≤14 días): ${summary.bajos}`);
    lines.push(`- Sin historial de ventas: ${summary.sinVentas}`);
    lines.push(`- Valor total de inventario: $${summary.valorInventario.toLocaleString('es-MX')} MXN`);
    const agotados = stock.items.filter(i => i.totalStock === 0).slice(0, 8);
    if (agotados.length) {
      lines.push(`- AGOTADOS (muestra): ${agotados.map(i => `"${i.title.substring(0,50)}"`).join('; ')}`);
    }
    const criticos = stock.items.filter(i => i.alertLevel === 'critical').slice(0, 5);
    if (criticos.length) {
      lines.push(`- CRÍTICOS: ${criticos.map(i => `"${i.title.substring(0,40)}" (${i.daysRemaining}d restantes)`).join('; ')}`);
    }
    lines.push('');
  }

  if (ads) {
    lines.push(`## PUBLICIDAD DEL MES`);
    lines.push(`- Campañas activas: ${ads.campaignsCount}`);
    lines.push(`- Inversión total: $${ads.inversion.toFixed(2)} MXN`);
    lines.push(`- Ventas atribuidas: $${ads.ventasAds.toFixed(2)} MXN`);
    lines.push(`- ROAS: ${ads.roasTotal.toFixed(2)}x`);
    lines.push(`- ACOS: ${ads.acosTotal.toFixed(1)}%`);
    if (ads.acosAlto?.length) {
      lines.push(`- ADS CON ACOS ALTO (>30%, inversión >$50 MXN):`);
      ads.acosAlto.forEach(a =>
        lines.push(`  * "${a.title}" → ACOS ${a.acos?.toFixed(1)}% | Inversión $${a.cost?.toFixed(0)} MXN`)
      );
    }
    lines.push('');
  }

  if (rentabilidad) {
    const t = rentabilidad.totals;
    const pctComision = t.venta_bruta > 0 ? t.comision_ml / t.venta_bruta * 100 : 0;
    lines.push(`## RENTABILIDAD DEL MES`);
    lines.push(`- Venta bruta: $${t.venta_bruta.toFixed(2)} MXN`);
    lines.push(`- Comisiones ML: $${t.comision_ml.toFixed(2)} MXN (${pctComision.toFixed(1)}% de ventas)`);
    lines.push(`- Costo envíos: $${t.costo_envio.toFixed(2)} MXN`);
    lines.push(`- Costo productos: $${t.costo_producto.toFixed(2)} MXN`);
    lines.push(`- Inversión publicidad: $${t.inversion_publicidad.toFixed(2)} MXN`);
    lines.push(`- Utilidad neta: $${t.utilidad.toFixed(2)} MXN`);
    lines.push(`- Margen neto: ${t.margen_promedio.toFixed(1)}%`);
    const topRent = rentabilidad.items.filter(i => i.tiene_costo).slice(0, 5);
    if (topRent.length) {
      lines.push(`- TOP 5 MÁS RENTABLES:`);
      topRent.forEach((p, i) =>
        lines.push(`  ${i+1}. "${p.title.substring(0,50)}" → Utilidad $${p.utilidad.toFixed(0)} | Margen ${p.margen.toFixed(1)}%`)
      );
    }
    const perdida = rentabilidad.items.filter(i => i.tiene_costo && i.utilidad < 0).slice(0, 3);
    if (perdida.length) {
      lines.push(`- PRODUCTOS CON PÉRDIDA:`);
      perdida.forEach(p =>
        lines.push(`  * "${p.title.substring(0,50)}" → Pérdida $${Math.abs(p.utilidad).toFixed(0)} | Margen ${p.margen.toFixed(1)}%`)
      );
    }
    lines.push('');
  }

  if (devoluciones) {
    lines.push(`## DEVOLUCIONES Y RECLAMOS`);
    lines.push(`- Reclamos abiertos: ${devoluciones.abiertos}`);
    lines.push(`- Reclamos cerrados: ${devoluciones.cerrados}`);
    if (devoluciones.urgente > 0)
      lines.push(`- URGENTES (acción obligatoria del vendedor): ${devoluciones.urgente}`);
    lines.push('');
  }

  if (reputacion) {
    lines.push(`## REPUTACIÓN (últimos 60 días)`);
    lines.push(`- Nivel: ${reputacion.nivel} (Platinum)`);
    lines.push(`- Reclamos: ${(reputacion.reclamos * 100).toFixed(2)}% (límite <1%)`);
    lines.push(`- Cancelaciones: ${(reputacion.cancelaciones * 100).toFixed(2)}% (límite <0.5%)`);
    lines.push(`- Envíos demorados: ${(reputacion.enviosDemorados * 100).toFixed(2)}% (límite <8%)`);
    lines.push(`- Ventas completadas: ${reputacion.completadas60d}`);
    lines.push('');
  }

  if (billing) {
    lines.push(`## BILLING DEL MES (Cargos ML)`);
    lines.push(`- Comisiones por venta (CV): $${billing.comisiones_venta.toFixed(2)} MXN`);
    lines.push(`- Costo de envíos (CFF+CXD): $${billing.costo_envios.toFixed(2)} MXN`);
    lines.push(`- Publicidad (PADS): $${billing.publicidad.toFixed(2)} MXN`);
    lines.push(`- Almacenamiento Full: $${billing.almacenamiento_full.toFixed(2)} MXN`);
    lines.push(`- Total cargos ML: $${billing.total_cargos.toFixed(2)} MXN`);
    lines.push('');
  }

  const systemPrompt = lines.join('\n');

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const messages = [
      ...history.filter(m => m.role && m.content).slice(-12),
      { role: 'user', content: message.trim() },
    ];

    const completion = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    res.json({ response: completion.content[0].text, data_used });
  } catch (e) {
    if (e.status === 401) return res.json({ response: 'API key inválida. Verifica tu ANTHROPIC_API_KEY en el archivo .env.', data_used });
    if (e.status === 529 || e.message?.includes('credit') || e.message?.includes('balance')) {
      return res.json({ response: NO_KEY_MSG, data_used });
    }
    if (e.name === 'TokenExpiredError') throw e;
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── OAuth ML Self-Service ─────────────────────────────────────────────────────

// Registro de nuevo tenant + usuario admin (sin ML vinculado todavía)
app.post('/auth/register', async (req, res) => {
  try {
    const { email, password, nombreTienda } = req.body;
    if (!email || !password || !nombreTienda)
      return res.status(400).json({ error: 'email, password y nombreTienda son requeridos' });
    if (password.length < 8)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });

    const { data: existing } = await supabase.from('users').select('id').eq('email', email.toLowerCase().trim()).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Este email ya está registrado' });

    const { data: tenant, error: tenantErr } = await supabase.from('tenants').insert({
      name: nombreTienda.trim(),
      seller_id: '',
      ml_client_id: process.env.ML_CLIENT_ID,
      ml_client_secret: process.env.ML_CLIENT_SECRET,
      active: true,
    }).select().single();
    if (tenantErr) throw tenantErr;

    const password_hash = await bcrypt.hash(password, 12);
    const { data: user, error: userErr } = await supabase.from('users').insert({
      tenant_id: tenant.id,
      email: email.toLowerCase().trim(),
      password_hash,
      role: 'admin',
      active: true,
    }).select().single();
    if (userErr) throw userErr;

    req.session.userId = user.id;
    req.session.tenantId = tenant.id;
    req.session.role = user.role;
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Error al crear la cuenta' });
  }
});

// Inicia el flujo OAuth con MercadoLibre
app.get('/auth/ml/connect', (req, res) => {
  if (!req.session?.userId) return res.redirect('/');
  const { ML_CLIENT_ID, ML_REDIRECT_URI } = process.env;
  const url = `https://auth.mercadolibre.com.mx/authorization?response_type=code` +
    `&client_id=${encodeURIComponent(ML_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent('offline_access read_orders advertising')}` +
    `&state=${req.session.tenantId}`;
  res.redirect(url);
});

// Recibe el código de ML, obtiene tokens y seller_id, actualiza el tenant
app.get('/auth/ml/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!req.session?.userId || req.session.tenantId !== state) {
    return res.redirect('/inicio?error=oauth_estado_invalido');
  }
  if (!code) return res.redirect('/inicio?error=oauth_sin_codigo');

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', process.env.ML_CLIENT_ID);
    params.append('client_secret', process.env.ML_CLIENT_SECRET);
    params.append('code', code);
    params.append('redirect_uri', process.env.ML_REDIRECT_URI);

    const tokenRes = await axios.post('https://api.mercadolibre.com/oauth/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expires_at = Date.now() + ((expires_in - 300) * 1000);

    // Obtener seller_id real del usuario de ML
    const meRes = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const seller_id = String(meRes.data.id);

    const tenantId = req.session.tenantId;

    await supabase.from('tenant_tokens').upsert({
      tenant_id: tenantId,
      access_token,
      refresh_token,
      expires_at,
      updated_at: new Date().toISOString(),
    });

    // Intentar obtener el advertiser_id de ML Ads con el nuevo token
    let advertiser_id = null;
    try {
      const adsRes = await axios.get(
        `https://api.mercadolibre.com/advertising/MLM/advertisers/${seller_id}`,
        { headers: { Authorization: `Bearer ${access_token}`, 'api-version': '2' } }
      );
      advertiser_id = adsRes.data?.id ?? null;
      if (advertiser_id) console.log(`[oauth] advertiser_id descubierto para ${seller_id}: ${advertiser_id}`);
    } catch (e) {
      // 404 = el seller_id no es el advertiser_id (caso común); se puede configurar manualmente
      console.log(`[oauth] advertiser_id no auto-descubierto para ${seller_id} (status ${e.response?.status}) — se puede configurar manualmente`);
    }

    // Guardar seller_id, advertiser_id (si se obtuvo) y, solo si es la primera conexión, trial_started_at
    const { data: tenantRow } = await supabase.from('tenants').select('trial_started_at, advertiser_id').eq('id', tenantId).single();
    const trialUpdate = { seller_id };
    if (advertiser_id) trialUpdate.advertiser_id = advertiser_id;
    if (!tenantRow?.trial_started_at) trialUpdate.trial_started_at = new Date().toISOString();
    await supabase.from('tenants').update(trialUpdate).eq('id', tenantId);

    // Invalidar cache en memoria para forzar recarga con el nuevo seller_id
    tenantTokenCache.set(tenantId, { access_token, refresh_token, expires_at });

    res.redirect('/inicio?ml_connected=1');
  } catch (e) {
    console.error('ML callback error:', e.response?.data || e.message);
    res.redirect('/inicio?error=oauth_fallido');
  }
});

// ── Plan recomendado ─────────────────────────────────────────────────────────
function calcularTierPlan(ventasMensuales) {
  if (ventasMensuales <= 500_000)    return { tier: 'starter',    precio_mensual: 399,  precio_anual: 319  };
  if (ventasMensuales <= 3_000_000)  return { tier: 'growth',     precio_mensual: 899,  precio_anual: 719  };
  if (ventasMensuales <= 15_000_000) return { tier: 'scale',      precio_mensual: 1999, precio_anual: 1599 };
  return                               { tier: 'enterprise', precio_mensual: null, precio_anual: null };
}

function calcularTrial(trialStartedAt) {
  const trialStarted = trialStartedAt ? new Date(trialStartedAt) : null;
  const diasDesdeInicio = trialStarted ? Math.floor((new Date() - trialStarted) / (1000 * 60 * 60 * 24)) : 0;
  const dias_restantes_trial = trialStarted ? Math.max(0, 14 - diasDesdeInicio) : 14;
  const trial_vencido = trialStarted ? dias_restantes_trial === 0 : false;
  return { dias_restantes_trial, trial_vencido };
}

app.get('/api/mi-plan-recomendado', async (req, res) => {
  const ahora = new Date();
  const primerDiaMesActual = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
  const ultimoDiaMesAnterior = new Date(primerDiaMesActual - 1);
  const y = ultimoDiaMesAnterior.getFullYear();
  const m = ultimoDiaMesAnterior.getMonth() + 1;
  const mStr = String(m).padStart(2, '0');
  const mesCalculado = `${y}-${mStr}`;

  const tenantId = requestCtx.getStore()?.tenant?.id;

  // Si ya tiene suscripción activa, no calcular trial — responder directo
  if (tenantId) {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status, tier, billing_cycle')
      .eq('tenant_id', tenantId)
      .eq('status', 'activo')
      .maybeSingle();
    if (sub) {
      return res.json({
        tiene_suscripcion_activa: true,
        status: 'activo',
        tier: sub.tier,
        billing_cycle: sub.billing_cycle,
        dias_restantes_trial: 0,
        trial_vencido: false,
      });
    }
  }

  // Calcular días de trial
  const { data: tenantRow } = tenantId
    ? await supabase.from('tenants').select('trial_started_at').eq('id', tenantId).single()
    : { data: null };
  const trialInfo = calcularTrial(tenantRow?.trial_started_at);

  try {
    const lastDay = new Date(y, m, 0).getDate();
    const from = `${y}-${mStr}-01T00:00:00.000-06:00`;
    const to   = `${y}-${mStr}-${lastDay}T23:59:59.000-06:00`;

    let allOrders = [];
    let offset = 0;
    let total = 1;
    while (offset < total) {
      const d = await mlGet('https://api.mercadolibre.com/orders/search', {
        seller: getSellerId(), 'order.status': 'paid',
        'order.date_created.from': from, 'order.date_created.to': to,
        limit: 50, offset
      });
      total = d.paging.total;
      allOrders = allOrders.concat(d.results);
      offset += 50;
    }

    const ventaBruta = allOrders.reduce((s, o) => s + o.total_amount, 0);
    res.json({ ...calcularTierPlan(ventaBruta), ventas_base: ventaBruta, mes_calculado: mesCalculado, ...trialInfo });
  } catch (e) {
    console.error('[mi-plan-recomendado] ML error, usando fallback ventas=0:', e.message);
    res.json({ ...calcularTierPlan(0), ventas_base: 0, mes_calculado: mesCalculado, fallback: true, ...trialInfo });
  }
});

// ── Mi Suscripción ────────────────────────────────────────────────────────────
app.get('/api/mi-suscripcion', async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const ahora = new Date();
    const primerDiaMesActual = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
    const ultimoDiaMesAnterior = new Date(primerDiaMesActual - 1);
    const y = ultimoDiaMesAnterior.getFullYear();
    const m = ultimoDiaMesAnterior.getMonth() + 1;
    const mStr = String(m).padStart(2, '0');

    // Helper para obtener ventas del mes anterior
    async function fetchVentas() {
      try {
        const lastDay = new Date(y, m, 0).getDate();
        const from = `${y}-${mStr}-01T00:00:00.000-06:00`;
        const to   = `${y}-${mStr}-${lastDay}T23:59:59.000-06:00`;
        let allOrders = [], offset = 0, total = 1;
        while (offset < total) {
          const d = await mlGet('https://api.mercadolibre.com/orders/search', {
            seller: getSellerId(), 'order.status': 'paid',
            'order.date_created.from': from, 'order.date_created.to': to,
            limit: 50, offset
          });
          total = d.paging.total;
          allOrders = allOrders.concat(d.results);
          offset += 50;
        }
        return allOrders.reduce((s, o) => s + o.total_amount, 0);
      } catch { return 0; }
    }

    // Si tiene suscripción activa, devolver estado real sin calcular trial
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status, tier, billing_cycle, precio_mxn, proxima_fecha_pago, metodo_pago, updated_at')
      .eq('tenant_id', tenantId)
      .eq('status', 'activo')
      .maybeSingle();

    if (sub) {
      const ventaBruta = await fetchVentas();
      const plan = calcularTierPlan(ventaBruta);
      return res.json({
        tiene_suscripcion_activa: true,
        status:               'activo',
        tier:                 sub.tier,
        billing_cycle:        sub.billing_cycle,
        precio_mensual:       plan.precio_mensual,
        precio_anual:         plan.precio_anual,
        precio_mxn:           sub.precio_mxn,
        proxima_fecha_pago:   sub.proxima_fecha_pago,
        metodo_pago:          sub.metodo_pago,
        activo_desde:         sub.updated_at,
        ventas_base:          ventaBruta,
        mes_calculado:        `${y}-${mStr}`,
        dias_restantes_trial: 0,
        trial_vencido:        false,
        trial_started_at:     null,
      });
    }

    // Sin suscripción activa — calcular estado de trial
    const { data: tenant } = await supabase
      .from('tenants').select('trial_started_at').eq('id', tenantId).single();
    const { dias_restantes_trial, trial_vencido } = calcularTrial(tenant?.trial_started_at);

    const ventaBruta = await fetchVentas();
    const plan = calcularTierPlan(ventaBruta);

    res.json({
      ...plan,
      ventas_base:          ventaBruta,
      mes_calculado:        `${y}-${mStr}`,
      dias_restantes_trial,
      trial_vencido,
      trial_started_at:     tenant?.trial_started_at || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Estado de cuenta (suscripción activa, pendiente, suspendida, etc.) ────────
app.get('/api/estado-cuenta', async (req, res) => {
  try {
    const { data } = await supabase
      .from('subscriptions')
      .select('status, tier, billing_cycle')
      .eq('tenant_id', req.tenant.id)
      .maybeSingle();
    res.json(data ?? { status: 'sin_suscripcion' });
  } catch (e) {
    console.error('[estado-cuenta]', e.message);
    res.json({ status: 'sin_suscripcion' });
  }
});

// ── Stripe Checkout ───────────────────────────────────────────────────────────
app.post('/api/crear-checkout', async (req, res) => {
  const { tier, billing_cycle } = req.body;
  if (!tier || !billing_cycle) return res.status(400).json({ error: 'tier y billing_cycle son requeridos' });
  if (tier === 'enterprise') return res.status(400).json({ error: 'Enterprise va por contacto directo' });

  const priceId = STRIPE_PRICES[tier]?.[billing_cycle];
  if (!priceId) return res.status(400).json({ error: 'Combinación de tier/billing_cycle inválida' });

  const { data: user } = await supabase
    .from('users')
    .select('email')
    .eq('id', req.session.userId)
    .single();

  try {
    const appUrl = process.env.APP_URL || 'https://holstone-dashboard.onrender.com';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: user?.email,
      metadata: { tenant_id: req.tenant.id, tier, billing_cycle },
      success_url: `${appUrl}/inicio?payment=success`,
      cancel_url:  `${appUrl}/inicio?payment=cancelled`,
    });
    res.json({ checkout_url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e.message);
    res.status(500).json({ error: 'Error al crear la sesión de pago' });
  }
});

app.post('/api/crear-checkout-mp', async (req, res) => {
  const { tier, billing_cycle, payer_email: payerEmailOverride } = req.body;
  if (!tier || !billing_cycle) return res.status(400).json({ error: 'tier y billing_cycle son requeridos' });
  if (tier === 'enterprise') return res.status(400).json({ error: 'Enterprise va por contacto directo' });

  const precio = MP_PRICES[tier]?.[billing_cycle];
  if (!precio) return res.status(400).json({ error: 'Combinación inválida' });

  const { data: user } = await supabase
    .from('users').select('email').eq('id', req.session.userId).single();

  const appUrl = process.env.APP_URL || 'https://holstone-dashboard.onrender.com';
  const frecuencia = billing_cycle === 'anual' ? 12 : 1;
  const payerEmail = payerEmailOverride || user?.email;

  try {
    const preapprovalClient = new PreApproval(mpClient);
    const result = await preapprovalClient.create({
      body: {
        reason:             `Holstone ${tier} - ${billing_cycle}`,
        auto_recurring: {
          frequency:          frecuencia,
          frequency_type:     'months',
          transaction_amount: precio,
          currency_id:        'MXN',
        },
        back_url:           `${appUrl}/inicio?payment=success`,
        payer_email:        payerEmail,
        external_reference: JSON.stringify({ tenant_id: req.tenant.id, tier, billing_cycle }),
      },
    });
    res.json({ checkout_url: result.init_point });
  } catch (e) {
    // El SDK de MP lanza objetos planos (no instancias de Error), capturar todo
    let errObj;
    try { errObj = JSON.parse(JSON.stringify(e)); } catch { errObj = String(e); }
    console.error('[crear-checkout-mp] Error completo:', JSON.stringify(errObj, null, 2));
    res.status(500).json({
      error:    'Error al crear la suscripción en Mercado Pago',
      detail:   e.message || e.error || e.cause || 'objeto sin mensaje',
      apiError: errObj,
    });
  }
});

// ── Contacto Enterprise ───────────────────────────────────────────────────────
app.post('/api/contact-enterprise', async (req, res) => {
  const { nombre, email, empresa, telefono, ventas } = req.body;
  if (!nombre || (!email && !telefono)) return res.status(400).json({ error: 'nombre y (email o teléfono) son requeridos' });

  if (!process.env.RESEND_API_KEY) {
    console.log('[contact-enterprise] Sin RESEND_API_KEY — datos recibidos:', { nombre, email, empresa, telefono, ventas });
    return res.json({ ok: true });
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'Rocky <onboarding@resend.dev>',
      to: 'contacto@timaytempo.com.mx',
      subject: `Nuevo lead Enterprise: ${empresa || nombre}`,
      html: `
        <h2>Nuevo contacto Enterprise — Rocky</h2>
        <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
          <tr><td style="padding:6px 16px 6px 0;color:#64748b">Nombre</td><td style="padding:6px 0"><strong>${nombre}</strong></td></tr>
          <tr><td style="padding:6px 16px 6px 0;color:#64748b">Email</td><td style="padding:6px 0"><a href="mailto:${email}">${email}</a></td></tr>
          <tr><td style="padding:6px 16px 6px 0;color:#64748b">Empresa</td><td style="padding:6px 0">${empresa || '—'}</td></tr>
          <tr><td style="padding:6px 16px 6px 0;color:#64748b">Teléfono / WhatsApp</td><td style="padding:6px 0">${telefono || '—'}</td></tr>
          <tr><td style="padding:6px 16px 6px 0;color:#64748b">Ventas mensuales</td><td style="padding:6px 0">${ventas || '—'}</td></tr>
        </table>
      `,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Resend error:', e.message);
    res.status(500).json({ error: 'Error al enviar el email' });
  }
});

// ── Olvidé mi contraseña ──────────────────────────────────────────────────────
app.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.json({ ok: true });

  try {
    const { data: user } = await supabase
      .from('users').select('id').eq('email', email.toLowerCase().trim()).maybeSingle();

    if (user) {
      const token     = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      await supabase.from('password_reset_tokens').insert({
        user_id: user.id, token, expires_at: expiresAt, used: false,
      });

      const appUrl    = process.env.APP_URL || 'https://holstone-dashboard.onrender.com';
      const resetLink = `${appUrl}/reset-password?token=${token}`;
      const resend    = new Resend(process.env.RESEND_API_KEY);

      await resend.emails.send({
        from:    'Rocky <onboarding@resend.dev>',
        to:      email,
        subject: 'Restablece tu contraseña de Rocky',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
            <h2 style="margin:0 0 8px;color:#1e293b">Restablece tu contraseña</h2>
            <p style="color:#475569;margin:0 0 24px">
              Recibiste este correo porque solicitaste restablecer tu contraseña de Rocky.
              Haz clic en el botón para elegir una nueva:
            </p>
            <a href="${resetLink}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">
              Restablecer contraseña
            </a>
            <p style="color:#94a3b8;margin:24px 0 0;font-size:13px">
              Este link expira en <strong>1 hora</strong>. Si no solicitaste esto, puedes ignorar este correo.
            </p>
            <p style="color:#cbd5e1;margin:8px 0 0;font-size:12px">${resetLink}</p>
          </div>
        `,
      });
    }
  } catch (e) {
    console.error('[forgot-password]', e.message);
  }

  res.json({ ok: true }); // siempre la misma respuesta — no revelar si el email existe
});

// ── Restablecer contraseña con token ─────────────────────────────────────────
app.post('/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: 'Datos incompletos' });
  if (newPassword.length < 8)  return res.status(400).json({ error: 'Mínimo 8 caracteres' });

  try {
    const { data: row } = await supabase
      .from('password_reset_tokens')
      .select('id, user_id, expires_at, used')
      .eq('token', token)
      .maybeSingle();

    if (!row || row.used || new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Link inválido o expirado' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password_hash: hash }).eq('id', row.user_id);
    await supabase.from('password_reset_tokens').update({ used: true }).eq('id', row.id);

    res.json({ ok: true });
  } catch (e) {
    console.error('[reset-password]', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Cambiar contraseña (usuario logueado) ─────────────────────────────────────
app.post('/api/cambiar-password', async (req, res) => {
  const { passwordActual, passwordNueva } = req.body || {};
  if (!passwordActual || !passwordNueva) return res.status(400).json({ error: 'Datos incompletos' });
  if (passwordNueva.length < 8) return res.status(400).json({ error: 'Mínimo 8 caracteres' });

  try {
    const { data: user } = await supabase
      .from('users').select('password_hash').eq('id', req.session.userId).single();

    const valid = await bcrypt.compare(passwordActual, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(passwordNueva, 10);
    await supabase.from('users').update({ password_hash: hash }).eq('id', req.session.userId);

    res.json({ ok: true });
  } catch (e) {
    console.error('[cambiar-password]', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Global error handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'TOKEN_EXPIRED' });
  }
  const msg = err.response?.data?.message || err.response?.data?.error || err.message;
  console.error('[server] Error no manejado en:', req.path, msg);
  if (!res.headersSent) res.status(500).json({ error: msg });
});

// ── Catch-all: serve index.html para rutas de sección (/ventas, /stock, etc.) ──
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    next();
  }
});

