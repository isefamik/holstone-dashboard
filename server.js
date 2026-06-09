const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const SELLER_ID = process.env.SELLER_ID;

let tokenData = {
  access_token: process.env.ML_TOKEN,
  expires_at: Date.now() + (5 * 60 * 60 * 1000)
};

async function refreshToken() {
  try {
    console.log('Renovando token de ML...');
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('refresh_token', process.env.ML_REFRESH_TOKEN);
    const response = await axios.post('https://api.mercadolibre.com/oauth/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    tokenData.access_token = response.data.access_token;
    tokenData.expires_at = Date.now() + ((response.data.expires_in - 300) * 1000);
    console.log('Token renovado exitosamente');
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

setInterval(refreshToken, 5 * 60 * 60 * 1000);
refreshToken();

function today() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function mlGet(url, params = {}) {
  const token = await getToken();
  const r = await axios.get(url, {
    params,
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.data;
}

app.get('/api/ventas-hoy', async (req, res) => {
  try {
    const fecha = today();
    const from = `${fecha}T00:00:00.000-06:00`;
    const to = `${fecha}T23:59:59.000-06:00`;
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
    res.json({ ordenes: total, ventaBruta, precioLista, descuentos: precioLista - ventaBruta, unidades, ticketPromedio: total > 0 ? ventaBruta / total : 0, top });
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
    res.json({ totalPublicaciones: result.length, totalStock, totalPiezas, items: result });
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
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));

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
      periodo: metrics.cancellations?.period || ''
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
      if (stock === 0) return 'out';
      if (days === null) return 'ok';
      if (days <= 7) return 'critical';
      if (days <= 15) return 'low';
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
          alertLevel: calcAlert(vDays, vs)
        };
      });
      return {
        id: item.id, title: item.title, price: item.price, pack,
        totalStock, totalPiezas: totalStock * pack,
        sales3m: sales.total,
        monthlyAvg: Math.round(dailyAvg * 30 * 10) / 10,
        daysRemaining,
        depletionDate: calcDate(daysRemaining),
        needed30: Math.ceil(dailyAvg * 30),
        needed60: Math.ceil(dailyAvg * 60),
        alertLevel: calcAlert(daysRemaining, totalStock),
        variations
      };
    });

    result.sort((a, b) => b.sales3m - a.sales3m);

    const summary = {
      total: result.length,
      agotados: result.filter(i => i.alertLevel === 'out').length,
      criticos: result.filter(i => i.alertLevel === 'critical').length,
      bajos: result.filter(i => i.alertLevel === 'low').length,
      ok: result.filter(i => i.alertLevel === 'ok').length
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
