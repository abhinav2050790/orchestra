import { Router } from 'express';
import { db } from '../db.js';
import { adminRequired } from '../middleware.js';
import { HttpError, slugify } from '../util.js';

const router = Router();

const VALID_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const VALID_SORTS = {
  name_asc: 'p.name ASC',
  price_asc: 'min_price ASC',
  price_desc: 'min_price DESC',
  newest: 'p.created_at DESC',
};

function variantsFor(productId) {
  return db
    .prepare('SELECT * FROM variants WHERE product_id = ? ORDER BY price_cents ASC, size ASC')
    .all(productId);
}

router.get('/', (req, res) => {
  const search = String(req.query.search || '').trim();
  const sortKey = req.query.sort in VALID_SORTS ? req.query.sort : 'newest';

  let sql = `
    SELECT p.*, MIN(v.price_cents) AS min_price, MAX(v.price_cents) AS max_price,
           SUM(v.stock) AS total_stock
    FROM products p LEFT JOIN variants v ON v.product_id = p.id`;
  const params = [];
  if (search) {
    sql += ' WHERE p.name LIKE ? OR p.description LIKE ?';
    const pat = `%${search}%`;
    params.push(pat, pat);
  }
  sql += ` GROUP BY p.id ORDER BY ${VALID_SORTS[sortKey]}`;

  const products = db.prepare(sql).all(...params).map((p) => ({
    ...p,
    variants: variantsFor(p.id),
  }));
  res.json({ products, count: products.length });
});

router.get('/:slug', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(req.params.slug);
  if (!product) throw new HttpError(404, 'Product not found');
  res.json({ ...product, variants: variantsFor(product.id) });
});

function uniqueSlug(name) {
  const base = slugify(name);
  let slug = base;
  let i = 2;
  while (db.prepare('SELECT 1 FROM products WHERE slug = ?').get(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

function uniqueSku(slug, size, color) {
  const base = `${slug}-${size}-${color}`.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  let sku = base;
  let i = 2;
  while (db.prepare('SELECT 1 FROM variants WHERE sku = ?').get(sku)) {
    sku = `${base}-${i++}`;
  }
  return sku;
}

function validateVariants(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, 'At least one variant is required');
  }
  for (const v of raw) {
    if (!v.size || !VALID_SIZES.includes(v.size)) {
      throw new HttpError(400, `Variant size must be one of ${VALID_SIZES.join(', ')}`);
    }
    if (!v.color || typeof v.color !== 'string') throw new HttpError(400, 'Variant color required');
    if (!Number.isInteger(v.priceCents) || v.priceCents < 0) {
      throw new HttpError(400, 'Variant priceCents must be a non-negative integer');
    }
    if (!Number.isInteger(v.stock) || v.stock < 0) {
      throw new HttpError(400, 'Variant stock must be a non-negative integer');
    }
  }
}

router.post('/', adminRequired, (req, res) => {
  const { name, description = '', imageUrl = null, variants } = req.body;
  if (!name || typeof name !== 'string') throw new HttpError(400, 'Product name required');
  validateVariants(variants);

  db.exec('BEGIN');
  try {
    const slug = uniqueSlug(name);
    const result = db
      .prepare('INSERT INTO products (slug, name, description, image_url) VALUES (?, ?, ?, ?)')
      .run(slug, name.trim(), String(description), imageUrl);
    const productId = result.lastInsertRowid;
    const insVar = db.prepare(
      'INSERT INTO variants (product_id, size, color, price_cents, stock, sku) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const v of variants) {
      insVar.run(productId, v.size, v.color.trim(), v.priceCents, v.stock, uniqueSku(slug, v.size, v.color));
    }
    db.exec('COMMIT');
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    res.status(201).json({ ...product, variants: variantsFor(productId) });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

router.patch('/:id', adminRequired, (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) throw new HttpError(404, 'Product not found');
  const fields = [];
  const params = [];
  for (const [bodyKey, col] of [
    ['name', 'name'],
    ['description', 'description'],
    ['imageUrl', 'image_url'],
  ]) {
    if (req.body[bodyKey] !== undefined) {
      fields.push(`${col} = ?`);
      params.push(bodyKey === 'imageUrl' && req.body[bodyKey] === '' ? null : req.body[bodyKey]);
    }
  }
  if (fields.length) {
    params.push(existing.id);
    db.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id);
  res.json({ ...product, variants: variantsFor(product.id) });
});

router.delete('/:id', adminRequired, (req, res) => {
  const result = db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  if (result.changes === 0) throw new HttpError(404, 'Product not found');
  res.status(204).end();
});

router.post('/:id/variants', adminRequired, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) throw new HttpError(404, 'Product not found');
  validateVariants([req.body]);
  const sku = uniqueSku(product.slug, req.body.size, req.body.color);
  try {
    db.prepare(
      'INSERT INTO variants (product_id, size, color, price_cents, stock, sku) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(product.id, req.body.size, req.body.color.trim(), req.body.priceCents, req.body.stock, sku);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new HttpError(409, 'A variant with this size and color already exists');
    }
    throw err;
  }
  res.status(201).json({ ...product, variants: variantsFor(product.id) });
});

router.patch('/variants/:variantId', adminRequired, (req, res) => {
  const variant = db.prepare('SELECT * FROM variants WHERE id = ?').get(req.params.variantId);
  if (!variant) throw new HttpError(404, 'Variant not found');
  const updates = {};
  if (req.body.priceCents !== undefined) {
    if (!Number.isInteger(req.body.priceCents) || req.body.priceCents < 0) {
      throw new HttpError(400, 'priceCents must be a non-negative integer');
    }
    updates.price_cents = req.body.priceCents;
  }
  if (req.body.stock !== undefined) {
    if (!Number.isInteger(req.body.stock) || req.body.stock < 0) {
      throw new HttpError(400, 'stock must be a non-negative integer');
    }
    updates.stock = req.body.stock;
  }
  const keys = Object.keys(updates);
  if (keys.length) {
    db.prepare(`UPDATE variants SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...Object.values(updates),
      variant.id
    );
  }
  res.json(db.prepare('SELECT * FROM variants WHERE id = ?').get(variant.id));
});

export default router;
