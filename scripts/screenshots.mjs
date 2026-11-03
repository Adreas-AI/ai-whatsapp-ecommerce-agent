/* global document -- used inside page.waitForFunction, which runs in the browser */
// Captures dashboard screenshots for the README (DEMO_MODE only).
// Run inside the Playwright image on the compose network:
//   bash scripts/screenshots.sh
import { chromium } from 'playwright';

const BASE = process.env.DASHBOARD_URL ?? 'http://gateway:3000';
const OUT = process.env.OUT_DIR ?? '/out';

async function clickScenario(page, title) {
  await page.getByRole('button', { name: title, exact: true }).click();
  // Wait until the busy state clears (the send button re-enables) and a reply bubble exists.
  await page.waitForFunction(() => !document.getElementById('send').disabled, null, { timeout: 30_000 });
  await page.waitForTimeout(800);
}

const browser = await chromium.launch();
try {
  // bypassCSP: the dashboard's strict CSP (no eval) would otherwise block Playwright's waitForFunction.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'light', bypassCSP: true });
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Reset demo' }).click();
  await page.waitForTimeout(500);

  await clickScenario(page, 'Product availability');
  await clickScenario(page, 'Order status (verified by phone)');
  await page.screenshot({ path: `${OUT}/dashboard-order-verified.png`, fullPage: true });

  await clickScenario(page, 'Order status (verified by email)');
  await page.screenshot({ path: `${OUT}/dashboard-email-verification.png`, fullPage: true });

  await clickScenario(page, 'Someone else’s order');
  await page.screenshot({ path: `${OUT}/dashboard-ownership-refused.png`, fullPage: true });

  await clickScenario(page, 'Complaint → human handoff');
  await page.screenshot({ path: `${OUT}/dashboard-handoff.png`, fullPage: true });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', bypassCSP: true });
  await mobile.goto(BASE);
  await mobile.waitForTimeout(1500);
  await mobile.screenshot({ path: `${OUT}/dashboard-mobile-dark.png`, fullPage: false });
  console.log('screenshots written to', OUT);
} finally {
  await browser.close();
}
