const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
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
    const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
      params: {
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      }
    });
    tokenData.access_token = response.data.access_token;
    tokenData.expires_at = Date.now() + ((response.data.expires_in - 300) * 1000);
    console.log('Token renovado exitosamente');
    return tokenData.access_token;
  } catch (e) {
    console.error('Error renovando token:', e.message);
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
    const r = await mlGet(`https://api.mercadolibre.com/users/${SELLER_ID}/items/search`, { limit: 50 });
    const ids = r.results.slice(0, 20).join(',');
    const details = await mlGet(`https://api.mercadolibre.com/items?ids=${ids}&attributes=id,title,available_quantity,price,status`);
    const items = details.filter(d => d.code === 200).map(d => d.body);
    const totalStock = items.reduce((s, i) => s + (i.available_quantity || 0), 0);
    const activas = items.filter(i => i.status === 'active').length;
    res.json({ totalPublicaciones: r.paging.total, totalStock, activas, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
