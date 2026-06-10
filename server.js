const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const SELLER_ID = process.env.SELLER_ID;

// ── Token persistence (Supabase) ────────────────────────────────────────────

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TOKEN_ROW_ID = 'ml_token';

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

function today() {
  // en-CA produce el formato YYYY-MM-DD directamente
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}

async function mlGet(url, params = {}) {
  const token = await getToken();
  const r = await axios.get(url, {
    params,
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.data;
}

async function fetchPaidOrders(from, to) {
  let allOrders = [];
  let offset = 0;
  let total = 1;
  while (offset < total) {
    const d = await mlGet('https://api.mercadolibre.com/orders/search', {
      seller: SELLER_ID, 'order.status': 'paid',
      'order.date_created.from': from, 'order.date_created.to': to,
      limit: 50, offset
    });
    total = d.paging.total;
    allOrders = allOrders.concat(d.results);
    offset += 50;
  }
  return allOrders;
}

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
    const top = Object.entries(byProduct).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 10).map(([title, v]) => ({ title, ...v }));
    res.json({
      ordenes: total, ventaBruta, precioLista, descuentos: precioLista - ventaBruta, unidades,
      ticketPromedio: total > 0 ? ventaBruta / total : 0, top,
      ventaBrutaAyer, ordenesAyer, unidadesAyer
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
        seller: SELLER_ID, 'order.status': 'paid',
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
      const r = await mlGet(`https://api.mercadolibre.com/users/${SELLER_ID}/items/search`, { status: 'active', limit: 50, offset });
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

app.get('/api/devoluciones', async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = year || new Date().getFullYear();
    const m = month || String(new Date().getMonth() + 1).padStart(2, '0');
    const from = `${y}-${String(m).padStart(2,'0')}-01T00:00:00.000-06:00`;
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${y}-${String(m).padStart(2,'0')}-${lastDay}T23:59:59.000-06:00`;
    let all = [];
    let offset = 0;
    let total = 1;
    while (offset < total) {
      const d = await mlGet('https://api.mercadolibre.com/orders/search', {
        seller: SELLER_ID, 'order.status': 'cancelled',
        'order.date_created.from': from, 'order.date_created.to': to,
        limit: 50, offset
      });
      total = d.paging.total;
      all = all.concat(d.results);
      offset += 50;
    }
    const totalMonto = all.reduce((s, o) => s + (o.total_amount || 0), 0);
    const totalUnidades = all.reduce((s, o) => s + o.order_items.reduce((ss, i) => ss + i.quantity, 0), 0);
    const byProduct = {};
    all.forEach(o => {
      o.order_items.forEach(i => {
        const t = i.item.title;
        if (!byProduct[t]) byProduct[t] = { monto: 0, unidades: 0, ordenes: 0 };
        byProduct[t].monto += o.total_amount || 0;
        byProduct[t].unidades += i.quantity;
        byProduct[t].ordenes += 1;
      });
    });
    const top = Object.entries(byProduct).sort((a, b) => b[1].ordenes - a[1].ordenes).slice(0, 10).map(([title, v]) => ({ title, ...v }));
    res.json({ total, totalMonto, totalUnidades, top });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor Holstone corriendo en http://localhost:${PORT}`));

app.get('/api/reclamos', async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = year || new Date().getFullYear();
    const m = month || String(new Date().getMonth() + 1).padStart(2, '0');
    const from = `${y}-${String(m).padStart(2,'0')}-01T00:00:00.000-06:00`;
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${y}-${String(m).padStart(2,'0')}-${lastDay}T23:59:59.000-06:00`;
    const token = await getToken();
    const r = await axios.get(`https://api.mercadolibre.com/post-purchase/v1/claims/search`, {
      params: { seller_id: SELLER_ID, type: 'returns', limit: 50, date_created_from: from, date_created_to: to },
      headers: { Authorization: `Bearer ${token}` }
    });
    const claims = r.data.data || [];
    const total = r.data.meta?.total || claims.length;
    res.json({ total, claims: claims.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/reputacion', async (req, res) => {
  try {
    const data = await mlGet(`https://api.mercadolibre.com/users/${SELLER_ID}`);
    const rep = data.seller_reputation || {};
    const metrics = rep.metrics || {};
    const transactions = rep.transactions || {};
    res.json({
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
        envioDemoradoNum: metrics.delayed_handling_time?.value || 0
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});


app.get('/api/publicaciones', async (req, res) => {
  try {
    const [actR, pausR] = await Promise.all([
      mlGet(`https://api.mercadolibre.com/users/${SELLER_ID}/items/search`, { status: 'active', limit: 1 }),
      mlGet(`https://api.mercadolibre.com/users/${SELLER_ID}/items/search`, { status: 'paused', limit: 1 })
    ]);
    const activas = actR.paging.total;
    const pausadas = pausR.paging.total;
    res.json({ activas, pausadas, total: activas + pausadas });
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

    const itemsData = await mlGet(`https://api.mercadolibre.com/users/${SELLER_ID}/items/search`, {
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
      seller: SELLER_ID, 'order.status': 'paid',
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

app.get('/api/stock-inteligente', async (req, res) => {
  try {
    // 1. Get all active item IDs (paginated)
    let allIds = [];
    let offset = 0;
    let total = 1;
    while (offset < total) {
      const r = await mlGet(`https://api.mercadolibre.com/users/${SELLER_ID}/items/search`, {
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
          seller: SELLER_ID, 'order.status': 'paid',
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

    res.json({
      items: result, summary, totalDays,
      periodoDesde: startDate.toISOString().split('T')[0],
      periodoHasta: now.toISOString().split('T')[0]
    });
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
        seller: SELLER_ID, 'order.status': 'paid',
        'order.date_created.from': from, 'order.date_created.to': to,
        limit: 50, offset
      });
      total = d.paging.total;
      allOrders = allOrders.concat(d.results);
      offset += 50;
    }

    // Obtener detalle de cada envío en lotes (logistic_type + costo)
    const shipmentIds = [...new Set(allOrders.filter(o => o.shipping?.id).map(o => o.shipping.id))];
    const shipmentMap = {};
    const BATCH = 15;
    for (let i = 0; i < shipmentIds.length; i += BATCH) {
      const batch = shipmentIds.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(id =>
        mlGet(`https://api.mercadolibre.com/shipments/${id}`).catch(() => null)
      ));
      batch.forEach((id, idx) => { if (results[idx]) shipmentMap[id] = results[idx]; });
    }

    let totalEnvios = 0;
    let costoTotal = 0;
    const tipos = {};

    allOrders.forEach(o => {
      const shipment = o.shipping?.id ? shipmentMap[o.shipping.id] : null;
      const isFull = shipment?.logistic_type === 'fulfillment' || o.fulfilled === true;
      const tipoKey = isFull ? 'full' : 'me';
      const costo = shipment?.base_cost || 0;

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
            seller: SELLER_ID, 'order.status': 'paid',
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
      const visitas = await mlGet(`https://api.mercadolibre.com/users/${SELLER_ID}/items_visits/time_window`, {
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
