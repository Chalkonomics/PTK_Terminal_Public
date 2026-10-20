import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  mode: 'dryRun',
  symbol: 'BTC',
  accountAddress: '',
  equitySource: 'api',
  equityFixed: 1000,
  riskPct: 0.01,
  leverage: 20,
  minStopDistance: 80,
  maxStopDistancePct: 0.03,
  minStopDistancePct: 0.0005,
  magnitudeBandPct: 0.1,
  markMaxAgeMs: 5000,
  maxMarginUsage: 0.8,
  minLiqToStopRatio: 1.2,
  clipboardMaxAgeMs: 90000,
  clipboardWarnAgeMs: 60000,
  clipboardPollMs: 250,
  entryOrderType: 'marketableLimit',
  marketableLimitOffsetBps: 5,
  marketOrderSlippageBps: 50,
  stopLimitSlippageBps: 100,
  maxSlippageBps: 10,
  hotkeyLong: 'Ctrl+Shift+Up',
  hotkeyShort: 'Ctrl+Shift+Down',
  hotkeyPanic: 'Ctrl+Shift+X',
  setupLabels: ['A', 'B', 'C'],
  logPath: './trades.csv',
  // Mirror trades into Notion (needs NOTION_TOKEN and NOTION_DATABASE_ID in .env). Mainnet only;
  // notionTestnet lets testnet trades through while testing the sync.
  notionSync: false,
  notionTestnet: false,
  // Files in effects/. null plays a built-in synthesised placeholder.
  sounds: { accepted: 'reload.mp3', refused: null, danger: null },
});

export const SOUND_KINDS = ['accepted', 'refused', 'danger'];
const SOUND_FILE = /^[\w.-]+\.(mp3|wav|ogg)$/i;

const MODES = ['dryRun', 'testnet', 'live'];

/**
 * Reads config.json from rootDir, overlays it on DEFAULTS and validates.
 * Throws with every problem listed if anything is wrong.
 */
export function loadConfig(rootDir) {
  const file = path.join(rootDir, 'config.json');
  if (!fs.existsSync(file)) {
    throw new Error(`config.json not found in ${rootDir}. Copy config.example.json to config.json and edit it.`);
  }

  let user;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }

  const unknown = Object.keys(user).filter((k) => !(k in DEFAULTS));
  const config = { ...DEFAULTS, ...user, sounds: { ...DEFAULTS.sounds, ...user.sounds } };
  const errors = validateConfig(config);
  for (const kind of SOUND_KINDS) {
    const file = config.sounds[kind];
    if (typeof file === 'string' && SOUND_FILE.test(file) && !fs.existsSync(path.join(rootDir, 'effects', file))) {
      errors.push(`sounds.${kind}: effects/${file} does not exist`);
    }
  }
  if (unknown.length) errors.push(`unknown keys: ${unknown.join(', ')}`);
  if (errors.length) throw new Error(`config.json is invalid:\n  - ${errors.join('\n  - ')}`);

  config.logPath = path.resolve(rootDir, config.logPath);
  return Object.freeze(config);
}

export function validateConfig(c) {
  const errors = [];
  const positive = (k) => {
    if (typeof c[k] !== 'number' || !(c[k] > 0)) errors.push(`${k} must be a positive number`);
  };
  const fraction = (k, max) => {
    if (typeof c[k] !== 'number' || !(c[k] > 0 && c[k] < max)) errors.push(`${k} must be between 0 and ${max}`);
  };

  if (!MODES.includes(c.mode)) errors.push(`mode must be one of ${MODES.join(', ')}`);
  if (c.symbol !== 'BTC') errors.push('symbol must be BTC (the tool is BTC-only)');
  if (!['api', 'fixed'].includes(c.equitySource)) errors.push('equitySource must be api or fixed');
  if (!['market', 'marketableLimit'].includes(c.entryOrderType)) errors.push('entryOrderType must be market or marketableLimit');

  const needsAddress = c.mode !== 'dryRun' || c.equitySource === 'api';
  if (c.accountAddress === '' ? needsAddress : !/^0x[0-9a-fA-F]{40}$/.test(c.accountAddress)) {
    errors.push('accountAddress must be the main account 0x address (public, not a key)');
  }

  ['equityFixed', 'leverage', 'minStopDistance', 'markMaxAgeMs', 'clipboardMaxAgeMs', 'clipboardWarnAgeMs',
    'clipboardPollMs', 'marketableLimitOffsetBps', 'marketOrderSlippageBps', 'stopLimitSlippageBps',
    'maxSlippageBps'].forEach(positive);
  fraction('riskPct', 0.05);
  fraction('maxStopDistancePct', 0.2);
  fraction('minStopDistancePct', 0.01);
  fraction('magnitudeBandPct', 0.5);
  fraction('maxMarginUsage', 1.0001);
  if (typeof c.minLiqToStopRatio !== 'number' || !(c.minLiqToStopRatio >= 1)) errors.push('minLiqToStopRatio must be at least 1');

  if (c.minStopDistancePct >= c.maxStopDistancePct) errors.push('minStopDistancePct must be below maxStopDistancePct');
  if (c.clipboardWarnAgeMs >= c.clipboardMaxAgeMs) errors.push('clipboardWarnAgeMs must be below clipboardMaxAgeMs');
  if (!Array.isArray(c.setupLabels) || !c.setupLabels.every((l) => typeof l === 'string' && l.trim())) {
    errors.push('setupLabels must be an array of non-empty strings');
  }
  for (const k of ['hotkeyLong', 'hotkeyShort', 'hotkeyPanic']) {
    if (typeof c[k] !== 'string' || !c[k].includes('+')) errors.push(`${k} must be a modifier combo, e.g. Ctrl+Shift+Up`);
  }
  if (new Set([c.hotkeyLong, c.hotkeyShort, c.hotkeyPanic]).size !== 3) errors.push('hotkeys must be distinct');
  if (typeof c.logPath !== 'string' || !c.logPath) errors.push('logPath must be a path');
  for (const k of ['notionSync', 'notionTestnet']) {
    if (typeof c[k] !== 'boolean') errors.push(`${k} must be true or false`);
  }
  if (!c.sounds || typeof c.sounds !== 'object') errors.push('sounds must be an object');
  else {
    const extra = Object.keys(c.sounds).filter((k) => !SOUND_KINDS.includes(k));
    if (extra.length) errors.push(`sounds has unknown keys: ${extra.join(', ')} (use ${SOUND_KINDS.join(', ')})`);
    for (const kind of SOUND_KINDS) {
      const v = c.sounds[kind];
      if (v !== null && !(typeof v === 'string' && SOUND_FILE.test(v))) {
        errors.push(`sounds.${kind} must be null or a file name in effects/ (mp3, wav or ogg), not a path`);
      }
    }
  }

  return errors;
}

/**
 * Loads the agent wallet key from .env. Never called in dryRun.
 * The returned key must never be logged or sent to the renderer.
 */
export async function loadAgentKey(rootDir, mode) {
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: path.join(rootDir, '.env'), quiet: true });
  return resolveAgentKey(process.env, mode);
}

/** The .env variable holding the API wallet key for a mode. Testnet and mainnet need separate wallets. */
export function agentKeyVar(mode) {
  if (mode === 'testnet') return 'HL_AGENT_KEY_TESTNET';
  if (mode === 'live') return 'HL_AGENT_KEY_MAINNET';
  throw new Error(`no API wallet key is used in ${mode} mode`);
}

/** Picks and validates the key for a mode from an env object. Error messages never include the key. */
export function resolveAgentKey(env, mode) {
  const name = agentKeyVar(mode);
  const network = mode === 'testnet' ? 'testnet' : 'mainnet';
  const key = env[name]?.trim();
  if (!key) {
    const legacy = env.HL_AGENT_PRIVATE_KEY ? ' (HL_AGENT_PRIVATE_KEY is no longer read: rename it to HL_AGENT_KEY_TESTNET or HL_AGENT_KEY_MAINNET)' : '';
    throw new Error(`${name} missing from .env; create and authorise a ${network} API wallet in the Hyperliquid UI${legacy}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    const hint = /^0x[0-9a-fA-F]{40}$/.test(key) ? ' (that looks like a wallet address; the private key is 64 hex characters)' : '';
    throw new Error(`${name} is not a 0x-prefixed 32-byte hex private key${hint}`);
  }
  return key;
}
