import { createServer } from 'node:http';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createServices } from './container.js';

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const services = createServices(config);
  const app = createApp(services);
  const server = createServer(app.handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  const sweep = setInterval(() => services.store.sweep(), 60_000);
  sweep.unref();

  server.listen(config.port, config.host, () => {
    const mode = config.demoMode ? 'DEMO_MODE (all integrations mocked, fictional data)' : 'LIVE';
    services.logger.info(`listening on http://${config.host}:${config.port}`, { mode, orchestrator: config.orchestrator });
    if (config.demoMode) {
      console.log(`\n  Dashboard: http://localhost:${config.port}/   [${mode}]\n`);
    }
  });

  const shutdown = async (signal: string) => {
    services.logger.info('shutting down', { signal, inFlight: app.inFlight.size });
    server.close();
    await Promise.race([Promise.allSettled([...app.inFlight]), new Promise((r) => setTimeout(r, 8000))]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main();
