import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, validateConfig } from './config.js';
import oidcRouter, { initOidc } from './auth/oidc.js';
import askRouter from './routes/ask.js';
import { initMcp } from './mcp/inventoryServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  validateConfig();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(
    session({
      name: 'xaa.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax' },
    })
  );

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api', oidcRouter);
  app.use('/api', askRouter);

  // Serve the built client in production.
  const clientDist = path.resolve(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'), (err) => {
      if (err) res.status(404).send('Client not built. Run `npm run build` or use `npm run dev`.');
    });
  });

  await initMcp();
  await initOidc();

  app.listen(config.port, () => {
    console.log(`\n🚀 XAA demo server on http://localhost:${config.port}`);
    console.log(`   In dev, open the Vite app on http://localhost:5173\n`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
