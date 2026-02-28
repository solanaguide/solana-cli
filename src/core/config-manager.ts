import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse, stringify } from 'smol-toml';

export interface Permissions {
  canSetPermissions?: boolean;
  canTransfer?: boolean;
  canSwap?: boolean;
  canStake?: boolean;
  canWithdrawStake?: boolean;
  canLend?: boolean;
  canWithdrawLend?: boolean;
  canBorrow?: boolean;
  canBurn?: boolean;
  canCreateWallet?: boolean;
  canRemoveWallet?: boolean;
  canExportWallet?: boolean;
  canPredict?: boolean;
  canFetch?: boolean;
}

export interface Limits {
  maxTransactionUsd?: number;
  maxDailyUsd?: number;
}

export interface Allowlist {
  addresses?: string[];
  tokens?: string[];
}

export interface SolConfig {
  rpc?: { url?: string };
  api?: { jupiterApiKey?: string; dflowApiKey?: string };
  onramp?: { provider?: string; transakApiKey?: string; sphereKey?: string };
  defaults?: { wallet?: string; slippageBps?: number; priorityFee?: string; router?: string };
  permissions?: Permissions;
  limits?: Limits;
  allowlist?: Allowlist;
  [key: string]: unknown;
}

const SOL_DIR = join(homedir(), '.sol');
const CONFIG_PATH = join(SOL_DIR, 'config.toml');

export function getSolDir(): string {
  return SOL_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function ensureSolDir(): void {
  if (!existsSync(SOL_DIR)) {
    mkdirSync(SOL_DIR, { recursive: true });
  }
}

export function readConfig(): SolConfig {
  ensureSolDir();
  if (!existsSync(CONFIG_PATH)) return {};
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  return parse(raw) as SolConfig;
}

export function writeConfig(config: SolConfig): void {
  ensureSolDir();
  writeFileSync(CONFIG_PATH, stringify(config as Record<string, unknown>));
}

export function getConfigValue(key: string): unknown {
  const config = readConfig();
  const parts = key.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function isPermitted(name: string): boolean {
  const perms = readConfig().permissions;
  return perms?.[name as keyof Permissions] !== false;
}

const SECURITY_SECTIONS = ['permissions', 'limits', 'allowlist'];

export function isSecurityKey(key: string): boolean {
  return SECURITY_SECTIONS.some(s => key.startsWith(`${s}.`) || key === s);
}

export function setConfigValue(key: string, value: string): void {
  if (isSecurityKey(key)) {
    if (!isPermitted('canSetPermissions')) {
      throw new Error('Security settings are locked. Edit ~/.sol/config.toml directly.');
    }
  }

  const config = readConfig();
  const parts = key.split('.');

  // Parse value — try number, boolean, array, else string
  let parsed: unknown = value;
  if (value === 'true') parsed = true;
  else if (value === 'false') parsed = false;
  else if (/^\d+$/.test(value)) parsed = parseInt(value, 10);
  else if (/^\d+\.\d+$/.test(value)) parsed = parseFloat(value);
  else if (value.includes(',')) parsed = value.split(',').map(s => s.trim()).filter(Boolean);

  let current: Record<string, unknown> = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = parsed;

  writeConfig(config);
}

export function listConfig(): Record<string, unknown> {
  return flatten(readConfig());
}

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flatten(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}
