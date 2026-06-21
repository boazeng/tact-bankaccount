import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'node:fs';

dotenv.config({ path: 'C:/Users/User/Aiprojects/env/.env' });
const outDir = 'output';
fs.mkdirSync(outDir, { recursive: true });

const token = process.env.AUTH_EMERGENCY_TOKEN;
if (!token) { console.error('AUTH_EMERGENCY_TOKEN not set'); process.exit(1); }

const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();

await page.goto(`http://localhost:3030/emergency-login?token=${encodeURIComponent(token)}`,
  { waitUntil: 'networkidle2', timeout: 30_000 });
await new Promise(r => setTimeout(r, 800));

await page.goto('http://localhost:3030/', { waitUntil: 'networkidle2', timeout: 30_000 });
await new Promise(r => setTimeout(r, 1500));
await page.screenshot({ path: `${outDir}/smoke_index.png`, fullPage: false });
console.log(`Index: ${outDir}/smoke_index.png`);

// Click expand on the first bank to show table
await page.click('[data-toggle-bank]');
await new Promise(r => setTimeout(r, 500));
await page.screenshot({ path: `${outDir}/smoke_expanded.png`, fullPage: false });
console.log(`Expanded: ${outDir}/smoke_expanded.png`);

await browser.close();
