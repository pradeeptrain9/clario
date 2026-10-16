import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  MODE: z.enum(['mock', 'sandbox']).default('mock'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('127.0.0.1'),
  /** Spoken passphrase for high-risk payments. Mock mode falls back to a demo phrase; sandbox has none unless set. */
  CLARIO_PASSPHRASE: z.string().default(''),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_FAST_MODEL: z.string().default('gemini-flash-latest'),
  GEMINI_REVIEW_MODEL: z.string().default('gemini-pro-latest'),
  HF_TOKEN: z.string().default(''),
  PAYPAL_CLIENT_ID: z.string().default(''),
  PAYPAL_CLIENT_SECRET: z.string().default(''),
  PAYPAL_API_BASE: z.string().url().default('https://api-m.sandbox.paypal.com'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // The Google SDK conventionally reads GOOGLE_API_KEY; accept either name.
  // Hugging Face tooling reads HF_TOKEN now and HUGGING_FACE_HUB_TOKEN historically.
  const merged = {
    ...env,
    GEMINI_API_KEY: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
    HF_TOKEN: env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN || '',
  };
  const cfg = schema.parse(merged);
  if (cfg.MODE === 'sandbox' && (!cfg.PAYPAL_CLIENT_ID || !cfg.PAYPAL_CLIENT_SECRET)) {
    throw new Error('MODE=sandbox requires PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
  }
  // Never talk to live money from a hackathon build.
  if (!cfg.PAYPAL_API_BASE.includes('sandbox')) {
    throw new Error('PAYPAL_API_BASE must be a sandbox host. Clario refuses to run against live PayPal.');
  }
  return cfg;
}

export const config = loadConfig();
export const hasGemini = () => config.GEMINI_API_KEY.length > 0;
export const hasHuggingFace = () => config.HF_TOKEN.length > 0;
