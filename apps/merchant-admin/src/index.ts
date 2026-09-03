import 'dotenv/config';
import express from 'express';
import { MerchantRepository } from '@vac/merchant-core';
import { NeonMerchantRepository, hasNeonDatabase } from '@vac/merchant-core/neon';

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.WEB_ORIGIN || 'http://localhost:3001');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PATCH,POST,OPTIONS');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const repo = hasNeonDatabase() ? new NeonMerchantRepository() : new MerchantRepository();

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/state', async (_req, res) => res.json({ merchant: await repo.merchantState(), products: await repo.listProducts() }));
app.get('/products', async (_req, res) => res.json(await repo.listProducts()));
app.patch('/products/:id/price', async (req, res) => { try { await repo.setProductPrice(req.params.id, Number(req.body.price)); res.json(await repo.getProduct(req.params.id)); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.patch('/products/:id/inventory', async (req, res) => { try { await repo.setInventory(req.params.id, Number(req.body.inventory)); res.json(await repo.getProduct(req.params.id)); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.patch('/products/:id/active', async (req, res) => { try { await repo.setProductActive(req.params.id, Boolean(req.body.active)); res.json(await repo.getProduct(req.params.id)); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.patch('/merchant/discount', async (req, res) => { try { await repo.setDiscount(Number(req.body.discount)); res.json(await repo.merchantState()); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.patch('/merchant/delivery', async (req, res) => { try { await repo.setDelivery(Number(req.body.delivery)); res.json(await repo.merchantState()); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.post('/reset', async (_req, res) => { await repo.reset(); res.json({ ok: true }); });

const port = Number(process.env.MERCHANT_ADMIN_PORT || 3002);
app.listen(port, () => console.log(`Merchant admin listening on http://localhost:${port} (${hasNeonDatabase() ? 'Neon' : 'SQLite'})`));
