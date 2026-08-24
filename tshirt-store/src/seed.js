import bcrypt from 'bcryptjs';
import { db } from './db.js';

const existing = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;

if (existing > 0 && !process.env.FORCE) {
  console.log('Database already seeded. Run with FORCE=1 to reseed.');
  process.exit(0);
}

if (process.env.FORCE) {
  db.exec('DELETE FROM order_items; DELETE FROM orders; DELETE FROM variants; DELETE FROM products; DELETE FROM users;');
}

const adminHash = bcrypt.hashSync('admin123', 10);
db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('admin@shop.dev', ?, 'Admin', 'admin')").run(adminHash);

const demoHash = bcrypt.hashSync('demo1234', 10);
db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('demo@shop.dev', ?, 'Demo User', 'user')").run(demoHash);

const sizes = ['S', 'M', 'L', 'XL'];
const colors = ['Black', 'White', 'Navy'];

const products = [
  {
    slug: 'classic-crew-tee',
    name: 'Classic Crew Tee',
    description: 'Heavyweight 100% combed cotton tee with a relaxed crew neck. The everyday staple.',
    priceCents: 1900,
  },
  {
    slug: 'graphic-print-tee',
    name: 'Graphic Print Tee',
    description: 'Soft-washed cotton tee with a screen-printed front graphic designed by local artists.',
    priceCents: 2400,
  },
  {
    slug: 'oversized-drop-tee',
    name: 'Oversized Drop Tee',
    description: 'Boxy oversized fit with dropped shoulders and a wide ribbed collar.',
    priceCents: 2900,
  },
  {
    slug: 'pocket-tee',
    name: 'Pocket Tee',
    description: 'Midweight jersey tee with a contrast chest pocket and tonal stitching.',
    priceCents: 2100,
  },
];

let variantCount = 0;
for (const p of products) {
  const result = db
    .prepare('INSERT INTO products (slug, name, description, image_url) VALUES (?, ?, ?, ?)')
    .run(p.slug, p.name, p.description, null);
  const productId = result.lastInsertRowid;
  for (const size of sizes) {
    for (const color of colors) {
      db.prepare(
        'INSERT INTO variants (product_id, size, color, price_cents, stock, sku) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        productId,
        size,
        color,
        p.priceCents,
        20 + Math.floor(Math.random() * 40),
        `${p.slug}-${size}-${color}`.toUpperCase()
      );
      variantCount++;
    }
  }
}

console.log(`Seeded ${products.length} products (${variantCount} variants)`);
console.log('Admin login:   admin@shop.dev / admin123');
console.log('Demo user:     demo@shop.dev / demo1234');
