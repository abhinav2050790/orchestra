import express from 'express';
import cors from 'cors';
import './db.js';
import { authOptional, errorHandler, notFound } from './middleware.js';
import authRouter from './routes/auth.js';
import productsRouter from './routes/products.js';
import ordersRouter from './routes/orders.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(authOptional);

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'tshirt-store-api' }));
app.use('/api/auth', authRouter);
app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`tshirt-store-api listening on http://localhost:${PORT}`));
