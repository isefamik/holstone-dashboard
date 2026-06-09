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
