const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config();

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
app.use(express.json());
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
    maxAge: 3 * 60 * 60 * 1000, // 3 horas; rolling: true reinicia el contador con cada request
  },
}));

const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const SELLER_ID = process.env.SELLER_ID;

// ── Multi-tenant helpers ─────────────────────────────────────────────────────

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
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('client_id', tenant.ml_client_id);
  params.append('client_secret', tenant.ml_client_secret);
  params.append('refresh_token', cached.refresh_token || tenant.ml_refresh_token);
  const response = await axios.post('https://api.mercadolibre.com/oauth/token', params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const newToken = {
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token || cached.refresh_token,
    expires_at: Date.now() + ((response.data.expires_in - 300) * 1000),
  };
  tenantTokenCache.set(tenant.id, newToken);
  await supabase.from('tenant_tokens').upsert({
    tenant_id: tenant.id,
    access_token: newToken.access_token,
    refresh_token: newToken.refresh_token,
    expires_at: newToken.expires_at,
    updated_at: new Date().toISOString(),
  });
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

  // Refresh at startup if token is expired or about to expire (< 10 min)
  if (Date.now() >= tokenData.expires_at - 10 * 60 * 1000) {
    await refreshToken();
  } else {
    console.log('Token vigente, no es necesario renovar al arrancar');
  }

  setInterval(refreshToken, 5.5 * 60 * 60 * 1000);
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
  const token = ctx?.tenant ? await getTenantToken(ctx.tenant) : await getToken();
  const r = await axios.get(url, {
    params,
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.data;
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
  const token = ctx?.tenant ? await getTenantToken(ctx.tenant) : await getToken();
  const r = await axios.get(url, {
    params,
    headers: { Authorization: `Bearer ${token}`, 'api-version': '2' }
  });
  return r.data;
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
    res.status(500).json({ error: e.message });
  }
}

// Protege todas las rutas /api/* excepto login y logout
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
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
    tenant: { id: req.tenant.id, name: req.tenant.name },
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
      const hoyEntry = (vr.results || []).find(r => r.date && r.date.startsWith(fecha));
      visitas_hoy = hoyEntry?.total ?? vr.total_visits ?? null;
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
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.get('/api/ventas-mes', async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = year || new Date().getFullYear();
    const m = month || String(new Date().getMonth() + 1).padStart(2, '0');
    const from = `${y}-${String(m).padStart(2,'0')}-01T00:00:00.000-06:00`;
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${y}-${String(m).padStart(2,'0')}-${lastDay}T23:59:59.000-06:00`;
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
    res.json({ ordenes: total, ventaBruta, precioLista, descuentos: precioLista - ventaBruta, unidades, ticketPromedio: total > 0 ? ventaBruta / total : 0, top, mes: `${y}-${String(m).padStart(2,'0')}` });
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
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
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
            .then(v => v.total_visits || 0)
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
        `https://api.mercadolibre.com/items?ids=${ids}&attributes=id,title,available_quantity,price,status,variations`
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

    // 4. Fetch 3 months of paid orders concurrently
    const allMonthOrders = await Promise.all(months.map(async ({ year, month }) => {
      const mm = String(month).padStart(2, '0');
      const from = `${year}-${mm}-01T00:00:00.000-06:00`;
      const lastDay = new Date(year, month, 0).getDate();
      const isCurrent = year === cy && month === cm;
      const dayTo = isCurrent ? String(now.getDate()).padStart(2, '0') : String(lastDay).padStart(2, '0');
      const to = `${year}-${mm}-${dayTo}T23:59:59.000-06:00`;
      let orders = []; let off = 0; let tot = 1;
      while (off < tot) {
        const d = await mlGet('https://api.mercadolibre.com/orders/search', {
          seller: getSellerId(), 'order.status': 'paid',
          'order.date_created.from': from, 'order.date_created.to': to,
          limit: 50, offset: off
        });
        tot = d.paging.total;
        orders = orders.concat(d.results);
        off += 50;
      }
      return orders;
    }));
    const allOrders = allMonthOrders.flat();

    // 5. Build sales map: itemId -> { total, byVariant: { variantId: qty } }
    const salesMap = {};
    allOrders.forEach(order => {
      order.order_items.forEach(oi => {
        const iid = oi.item.id;
        const vid = oi.item.variation_id || 0;
        const qty = oi.quantity;
        if (!salesMap[iid]) salesMap[iid] = { total: 0, byVariant: {} };
        salesMap[iid].total += qty;
        salesMap[iid].byVariant[vid] = (salesMap[iid].byVariant[vid] || 0) + qty;
      });
    });

    // 6. Compute per-item and per-variant metrics
    const getPack = t => { const m = t.match(/(\d+)\s*pack/i); return m ? parseInt(m[1]) : 1; };
    const calcAlert = (days, stock) => {
      if (stock <= 0 || (days !== null && days <= 1)) return 'out';
      if (days === null) return 'ok';
      if (days <= 7) return 'critical';
      if (days < 15) return 'low';
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
        variations
      };
    });

    result.sort((a, b) => b.sales3m - a.sales3m);

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
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    res.status(500).json({ error: msg });
  }
});

// ── TENDENCIA DE VENTAS ──────────────────────────────────────────────────────

app.get('/api/tendencia', async (req, res) => {
  try {
    const period = req.query.period === '30days' ? '30days' : '7days';
    const days = period === '30days' ? 30 : 7;
    const dates = [];
    for (let i = days - 1; i >= 0; i--) dates.push(dateNDaysAgo(i));
    console.log('[tendencia] period:', period, 'desde:', dates[0], 'hasta:', dates[dates.length - 1]);

    const BATCH = 8;
    const dias = [];
    for (let i = 0; i < dates.length; i += BATCH) {
      const batch = dates.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(async fecha => {
        const from = `${fecha}T00:00:00.000-06:00`;
        const to = `${fecha}T23:59:59.000-06:00`;
        let orders = [];
        let offset = 0;
        let total = 1;
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
        const ordenes = orders.length;
        const ventaBruta = orders.reduce((s, o) => s + o.total_amount, 0);
        const unidades = orders.reduce((s, o) => s + o.order_items.reduce((ss, it) => ss + it.quantity, 0), 0);
        return {
          fecha,
          ordenes,
          ventaBruta: Math.round(ventaBruta),
          unidades,
          ticketPromedio: ordenes ? Math.round(ventaBruta / ordenes) : 0
        };
      }));
      dias.push(...batchResults);
    }

    // Visitas diarias (suma de todos los items del vendedor)
    try {
      const visitas = await mlGet(`https://api.mercadolibre.com/users/${getSellerId()}/items_visits/time_window`, {
        last: days, unit: 'day'
      });
      const visitasMap = {};
      (visitas.results || []).forEach(r => {
        visitasMap[r.date.split('T')[0]] = r.total;
      });
      dias.forEach(d => { d.visitas = visitasMap[d.fecha] || 0; });
    } catch (e) {
      console.error('Error obteniendo visitas:', e.response?.data || e.message);
      dias.forEach(d => { d.visitas = 0; });
    }

    res.json({ period, dias });
  } catch (e) {
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
    try {
      const v = await mlGet(`https://api.mercadolibre.com/users/${getSellerId()}/items_visits/time_window`, { last: 60, unit: 'day' });
      (v.results || []).forEach(r => { visitasMap[r.date.split('T')[0]] = r.total; });
    } catch (e) {
      console.error('Error obteniendo visitas:', e.response?.data || e.message);
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
    const visitasAnt = daysAgo(range.toAnt) <= 59 ? sumVisitas(range.fromAnt, range.toAnt) : null;
    const conversionCur = visitasCur === null ? null : (visitasCur > 0 ? cs.ordenes / visitasCur * 100 : 0);
    const conversionAnt = visitasAnt === null ? null : (visitasAnt > 0 ? as.ordenes / visitasAnt * 100 : 0);

    // Top productos del período
    const byProduct = {};
    ordersCur.forEach(o => {
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
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── VENTAS — HEATMAP DÍA/HORA ───────────────────────────────────────────────

app.get('/api/heatmap', async (req, res) => {
  try {
    const period = req.query.period === '30days' ? '30days' : '7days';
    const days = period === '30days' ? 30 : 7;
    const from = `${dateNDaysAgo(days - 1)}T00:00:00.000-06:00`;
    const to = `${today()}T23:59:59.000-06:00`;
    const orders = await fetchPaidOrders(from, to);

    const DOW = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ ventas: 0, ordenes: 0 })));

    orders.forEach(o => {
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
    const ventaTotal = orders.reduce((s, o) => s + o.total_amount, 0);

    res.json({
      period, days, grid, dow: DOW,
      diaConMasVentas: diaTop.ventas > 0 ? diaTop.dia : null,
      horaConMasVentas: horaTop.ventas > 0 ? `${String(horaTop.hora).padStart(2, '0')}:00 - ${String((horaTop.hora + 1) % 24).padStart(2, '0')}:00` : null,
      promedioPorDia: ventaTotal / days
    });
  } catch (e) {
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
          .then(v => v.total_visits || 0).catch(() => 0)
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
          .then(v => v.total_visits || 0).catch(() => 0)
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
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── PUBLICIDAD (PRODUCT ADS) ─────────────────────────────────────────────────

const ADVERTISER_ID = 4299;
const ADS_METRICS = 'clicks,prints,cost,cpc,acos,roas,total_amount,units_quantity,direct_amount,indirect_amount';

app.get('/api/ads', async (req, res) => {
  try {
    const from = req.query.from || dateNDaysAgo(6);
    const to = req.query.to || today();
    const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id) : null;

    const campaignsResp = await mlGetAds(`https://api.mercadolibre.com/advertising/MLM/advertisers/${getAdvertiserId()}/product_ads/campaigns/search`, {
      date_from: from, date_to: to, metrics: ADS_METRICS
    });

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

    let campaigns = campaignsResp.results;
    if (campaignId) {
      campaigns = campaigns.filter(c => c.id === campaignId);
      ads = ads.filter(a => a.campaign_id === campaignId);
    }

    res.json({ from, to, campaigns, ads });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.get('/api/ads-tendencia', async (req, res) => {
  try {
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
        const d = await mlGetAds(`https://api.mercadolibre.com/advertising/MLM/advertisers/${getAdvertiserId()}/product_ads/campaigns/search`, {
          date_from: fecha, date_to: fecha, metrics: 'cost,total_amount,clicks'
        });
        let results2 = d.results || [];
        if (campaignId) results2 = results2.filter(c => c.id === campaignId);
        const inversion = results2.reduce((s, c) => s + (c.metrics?.cost || 0), 0);
        const ventas = results2.reduce((s, c) => s + (c.metrics?.total_amount || 0), 0);
        const clicks = results2.reduce((s, c) => s + (c.metrics?.clicks || 0), 0);
        const roas = inversion > 0 ? ventas / inversion : 0;
        const acos = ventas > 0 ? (inversion / ventas) * 100 : 0;
        return { fecha, inversion, ventas, roas, acos, clicks };
      }));
      dias.push(...results);
    }

    res.json({ from, to, dias });
  } catch (e) {
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

    const records = rows.map(r => ({
      item_id:     String(r.item_id    || '').trim(),
      title:       String(r.title      || '').trim(),
      tipo_prenda: String(r.tipo_prenda|| '').trim(),
      pack:        parseInt(r.pack)    || 1,
      costo_base:  parseFloat(r.costo_base)  || 0,
      costo_total: parseFloat(r.costo_total) || 0,
      updated_at:  new Date().toISOString()
    })).filter(r => r.item_id);

    if (!records.length) return res.status(400).json({ error: 'Sin registros válidos en el Excel' });

    const { error } = await supabase.from('costos_productos').upsert(records, { onConflict: 'item_id' });
    if (error) throw new Error(error.message);
    costosCache = null;  // invalidar caché tras upload

    res.json({ saved: records.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    const data = await getFinancialPeriod(from, to);
    res.json({ from, to, ...data });
  } catch (e) {
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
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// POST /api/preguntas/:id/responder  body: { text }
app.post('/api/preguntas/:id/responder', async (req, res) => {
  try {
    const token = await getToken();
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'text requerido' });
    const r = await axios.post(
      'https://api.mercadolibre.com/answers',
      { question_id: parseInt(req.params.id), text: text.trim() },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.message || e.message });
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

      // 4. Publicidad del mes
      (async () => {
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
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── Catch-all: serve index.html para rutas de sección (/ventas, /stock, etc.) ──
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    next();
  }
});

