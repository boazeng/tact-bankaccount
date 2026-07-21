import { scrapeLeumi, bankInfo as leumiInfo } from './leumi.js';
import { scrapeDiscount, bankInfo as discountInfo } from './discount.js';
import { scrapePoalim, bankInfo as poalimInfo } from './poalim.js';
import { scrapeMizrachi, bankInfo as mizrachiInfo } from './mizrachi.js';
import { scrapeBeinleumi, bankInfo as beinleumiInfo } from './beinleumi.js';

export const bankRegistry = {
  leumi: {
    info: leumiInfo,
    scrape: scrapeLeumi,
    credentialsFromEnv: (env) => ({
      username: env.LEUMI_USERNAME ?? env.USER_NAME,
      password: env.LEUMI_PASSWORD ?? env.USER_PASSWARD,
      loginUrl: env.LEUMI_URL ?? env.URL,
    }),
  },
  discount: {
    info: discountInfo,
    scrape: scrapeDiscount,
    credentialsFromEnv: (env) => ({
      userId: env.DISCOUNT_USER_ID,
      password: env.DISCOUNT_PASSWORD,
      loginUrl: env.DISCOUNT_URL,
    }),
  },
  poalim: {
    info: poalimInfo,
    scrape: scrapePoalim,
    credentialsFromEnv: (env) => ({
      userId: env.POALIM_USER_ID,
      password: env.POALIM_PASSWORD,
      loginUrl: env.POALIM_URL,
    }),
  },
  mizrachi: {
    info: mizrachiInfo,
    scrape: scrapeMizrachi,
    credentialsFromEnv: (env) => ({
      userId: env.MIZRACHI_USER_ID,
      password: env.MIZRACHI_PASSWORD,
      loginUrl: env.MIZRACHI_URL,
    }),
  },
  beinleumi: {
    info: beinleumiInfo,
    scrape: scrapeBeinleumi,
    credentialsFromEnv: (env) => ({
      userId: env.BEINLEUMI_USER_ID,
      password: env.BEINLEUMI_PASSWORD,
      loginUrl: env.BEINLEUMI_URL,
    }),
  },
};

export function getBank(bankId) {
  const b = bankRegistry[bankId];
  if (!b) throw new Error(`Unknown bank: ${bankId}`);
  return b;
}

export function listBanks() {
  return Object.entries(bankRegistry).map(([id, b]) => ({ id, ...b.info }));
}
