const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
 
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
 
const ML_TOKEN = process.env.ML_TOKEN;
const SELLER_ID = process.env.SELLER_ID;
 
function today() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
      const r = await axios.get(`https://api.mercadolibre.com/orders/search`, {
        params: { seller: SELLER_ID, 'order.status': 'paid', 'order.date_created.from': from, 'order.date_created.to': to, limit: 50, offset },
        headers: { Authorization: `Bearer ${ML_TOKEN}` }
      });
      total = r.data.paging.total;
      allOrders = allOrders.concat(r.data.results);
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
 
app.get('/api/stock', async (req, res) => {
  try {
    const r = await axios.get(`https://api.mercadolibre.com/users/${SELLER_ID}/items/search`, {
      params: { limit: 50 },
      headers: { Authorization: `Bearer ${ML_TOKEN}` }
    });
    const ids = r.data.results.slice(0, 20).join(',');
    const details = await axios.get(`https://api.mercadolibre.com/items?ids=${ids}&attributes=id,title,available_quantity,price,status`, {
      headers: { Authorization: `Bearer ${ML_TOKEN}` }
    });
    const items = details.data.filter(d => d.code === 200).map(d => d.body);
    const totalStock = items.reduce((s, i) => s + (i.available_quantity || 0), 0);
    const activas = items.filter(i => i.status === 'active').length;
    res.json({ totalPublicaciones: r.data.paging.total, totalStock, activas, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
app.get('/api/perfil', async (req, res) => {
  try {
    const r = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${ML_TOKEN}` }
    });
    res.json({ nickname: r.data.nickname, reputacion: r.data.seller_reputation?.level_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
 