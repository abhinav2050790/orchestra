import { Router } from 'express';
import { db, withTransaction } from '../db.js';
import { authOptional, authRequired } from '../middleware.js';
import { HttpError, isEmail, requireFields } from '../util.js';

const router = Router();

const VALID_STATUSES = ['pending', 'paid', 'shipped', 'cancelled'];

function orderWithItems(id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) throw new HttpError(404, 'Order not found');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  return { ...order, items };
}

function canSee(order, user, emailQuery) {
  if (user?.role === 'admin') return true;
  if (order.user_id && user && order.user_id === user.id) return true;
  if (!order.user_id && emailQuery && emailQuery.toLowerCase() === order.customer_email) return true;
  return false;
}

router.post(
  '/',
  authOptional,
  (req, res, next) => {
    requireFields(req.body, ['items', 'customer']);
    next();
  },
  (req, res) => {
    const { items, customer } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      throw new HttpError(400, 'items must be a non-empty array');
    }
    for (const it of items) {
      if (!Number.isInteger(it.variantId) || !Number.isInteger(it.quantity) || it.quantity < 1) {
        throw new HttpError(400, 'Each item needs variantId (int) and quantity (int >= 1)');
      }
    }
    requireFields(customer, ['name', 'email', 'address']);
    if (!isEmail(customer.email)) throw new HttpError(400, 'Invalid customer email');

    const order = withTransaction(() => {
      let totalCents = 0;
      const lines = [];
      const getItem = db.prepare(`
        SELECT v.id AS variant_id, v.size, v.color, v.price_cents, v.stock,
               p.name AS product_name, p.slug
        FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.id = ?
      `);
      const decrement = db.prepare('UPDATE variants SET stock = stock - ? WHERE id = ? AND stock >= ?');

      for (const it of items) {
        const row = getItem.get(it.variantId);
        if (!row) throw new HttpError(404, `Variant ${it.variantId} not found`);
        const result = decrement.run(it.quantity, row.variant_id, it.quantity);
        if (result.changes === 0) {
          throw new HttpError(409, `Insufficient stock for ${row.product_name} (${row.size}/${row.color})`);
        }
        totalCents += row.price_cents * it.quantity;
        lines.push({ row, quantity: it.quantity });
      }

      const userId = req.user ? req.user.id : null;
      const insOrder = db.prepare(`
        INSERT INTO orders (user_id, status, customer_name, customer_email, address, total_cents)
        VALUES (?, 'pending', ?, ?, ?, ?)
      `);
      const orderId = insOrder.run(
        userId,
        String(customer.name).trim(),
        customer.email.toLowerCase().trim(),
        String(customer.address).trim(),
        totalCents
      ).lastInsertRowid;

      const insItem = db.prepare(`
        INSERT INTO order_items (order_id, variant_id, product_name, slug, size, color, quantity, unit_price_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const { row, quantity } of lines) {
        insItem.run(orderId, row.variant_id, row.product_name, row.slug, row.size, row.color, quantity, row.price_cents);
      }
      return orderId;
    });

    res.status(201).json(orderWithItems(order));
  }
);

router.get('/', authRequired, (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = db.prepare('SELECT id FROM orders ORDER BY created_at DESC').all();
  } else {
    rows = db.prepare('SELECT id FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  }
  res.json({ orders: rows.map((r) => orderWithItems(r.id)), count: rows.length });
});

router.get('/:id', authOptional, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) throw new HttpError(404, 'Order not found');
  if (!canSee(order, req.user, req.query.email)) throw new HttpError(403, 'Not allowed to view this order');
  res.json(orderWithItems(order.id));
});

router.post('/:id/pay', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) throw new HttpError(404, 'Order not found');
  if (order.status !== 'pending') {
    throw new HttpError(409, `Cannot pay an order with status '${order.status}'`);
  }
  db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(order.id);
  res.json({ ...orderWithItems(order.id), payment: 'mock-payment-success' });
});

router.patch('/:id/status', authRequired, (req, res) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Admin access required');
  const status = req.body.status;
  if (!VALID_STATUSES.includes(status)) {
    throw new HttpError(400, `status must be one of ${VALID_STATUSES.join(', ')}`);
  }
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) throw new HttpError(404, 'Order not found');
  if (order.status === status) throw new HttpError(409, 'Order already has this status');

  withTransaction(() => {
    if (status === 'cancelled' && order.status !== 'cancelled') {
      const restock = db.prepare('UPDATE variants SET stock = stock + ? WHERE id = ?');
      const items = db.prepare('SELECT variant_id, quantity FROM order_items WHERE order_id = ?').all(order.id);
      for (const it of items) restock.run(it.quantity, it.variant_id);
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
  });
  res.json(orderWithItems(order.id));
});

export default router;
