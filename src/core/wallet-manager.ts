import { type KeyPairSigner, createKeyPairSignerFromBytes } from '@solana/kit';
import { writeKeyFile, readKeyFile, softDeleteKeyFile, keyFileExists } from '../utils/fs.js';
import * as walletRepo from '../db/repos/wallet-repo.js';
import { getConfigValue } from './config-manager.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';

export interface WalletInfo {
  name: string;
  address: string;
  filePath: string;
  labels: string[];
  createdAt: string;
}

export async function createWallet(name: string): Promise<WalletInfo> {
  if (walletRepo.getWallet(name)) {
    throw new Error(`Wallet "${name}" already exists`);
  }
  if (keyFileExists(name)) {
    throw new Error(`Key file for "${name}" already exists`);
  }

  // Generate 32 random bytes as seed, then derive the full 64-byte keypair
  const privateKeyBytes = crypto.getRandomValues(new Uint8Array(32));

  // createKeyPairSignerFromPrivateKeyBytes derives the public key from the private key
  const { createKeyPairFromPrivateKeyBytes } = await import('@solana/keys');
  const keyPair = await createKeyPairFromPrivateKeyBytes(privateKeyBytes, true);

  // Export: private key is PKCS8 (48-byte header + 32-byte key), public key is raw 32 bytes
  const privatePkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));

  // Solana CLI format: 64 bytes = 32 private + 32 public
  const keypairBytes = new Uint8Array(64);
  keypairBytes.set(privatePkcs8.slice(16), 0); // PKCS8 header for Ed25519 is 16 bytes
  keypairBytes.set(publicRaw, 32);

  // Validate by re-importing
  const signer = await createKeyPairSignerFromBytes(keypairBytes);
  const walletAddress = signer.address;

  const filePath = writeKeyFile(name, keypairBytes);
  walletRepo.insertWallet(name, walletAddress, filePath);

  return {
    name,
    address: walletAddress,
    filePath,
    labels: [],
    createdAt: new Date().toISOString(),
  };
}

export async function createBatch(baseName: string, count: number): Promise<WalletInfo[]> {
  const results: WalletInfo[] = [];
  const digits = String(count).length;
  for (let i = 1; i <= count; i++) {
    const name = `${baseName}-${String(i).padStart(digits, '0')}`;
    results.push(await createWallet(name));
  }
  return results;
}

export async function importFromFile(filePath: string, name: string): Promise<WalletInfo> {
  if (walletRepo.getWallet(name)) {
    throw new Error(`Wallet "${name}" already exists`);
  }

  const keypairBytes = readKeyFileExternal(filePath);
  const signer = await createKeyPairSignerFromBytes(keypairBytes);
  const address = signer.address;

  const savedPath = writeKeyFile(name, keypairBytes);
  walletRepo.insertWallet(name, address, savedPath);

  return {
    name,
    address,
    filePath: savedPath,
    labels: [],
    createdAt: new Date().toISOString(),
  };
}

export async function importFromSolanaCli(name?: string): Promise<WalletInfo> {
  const solanaCfgPath = join(homedir(), '.config', 'solana', 'id.json');
  if (!existsSync(solanaCfgPath)) {
    throw new Error(`Solana CLI keypair not found at ${solanaCfgPath}`);
  }
  const walletName = name || 'solana-cli';
  return importFromFile(solanaCfgPath, walletName);
}

function readKeyFileExternal(filePath: string): Uint8Array {
  const raw = readFileSync(filePath, 'utf-8');
  const arr: number[] = JSON.parse(raw);
  return new Uint8Array(arr);
}

export async function loadSigner(name: string): Promise<KeyPairSigner> {
  const wallet = walletRepo.getWallet(name);
  if (!wallet) {
    throw new Error(`Wallet "${name}" not found`);
  }
  const keypairBytes = readKeyFile(wallet.file_path);
  return createKeyPairSignerFromBytes(keypairBytes);
}

/** Return raw 64-byte keypair (private+public) for v1 SDK compat. */
export function loadSignerRawBytes(name: string): Uint8Array {
  const wallet = walletRepo.getWallet(name);
  if (!wallet) {
    throw new Error(`Wallet "${name}" not found`);
  }
  return readKeyFile(wallet.file_path);
}

export function resolveWalletName(nameOrAddress: string): string {
  const byName = walletRepo.getWallet(nameOrAddress);
  if (byName) return byName.name;
  const byAddress = walletRepo.getWalletByAddress(nameOrAddress);
  if (byAddress) return byAddress.name;
  throw new Error(`Wallet "${nameOrAddress}" not found. Run \`sol wallet list\` to see available wallets.`);
}

export function getDefaultWalletName(): string {
  // Check config for default wallet
  const configured = getConfigValue('defaults.wallet') as string | undefined;
  if (configured) {
    if (walletRepo.getWallet(configured)) return configured;
  }
  // Fall back to first wallet
  const first = walletRepo.getDefaultWalletName();
  if (!first) throw new Error('No wallets found. Create one with: sol wallet create');
  return first;
}

export function listWallets(label?: string): WalletInfo[] {
  const rows = label ? walletRepo.listWalletsByLabel(label) : walletRepo.listWallets();
  return rows.map(row => ({
    name: row.name,
    address: row.address,
    filePath: row.file_path,
    labels: walletRepo.getLabels(row.name),
    createdAt: row.created_at,
  }));
}

export function removeWallet(name: string): void {
  const wallet = walletRepo.getWallet(name);
  if (!wallet) throw new Error(`Wallet "${name}" not found`);
  // Soft-delete: rename key file so it can be recovered
  softDeleteKeyFile(wallet.file_path);
  walletRepo.removeWallet(name);
}

export function addLabel(name: string, label: string): void {
  const wallet = walletRepo.getWallet(name);
  if (!wallet) throw new Error(`Wallet "${name}" not found`);
  walletRepo.addLabel(name, label);
}

export function removeLabel(name: string, label: string): void {
  walletRepo.removeLabel(name, label);
}

export function getWalletFilePath(name: string): string {
  const wallet = walletRepo.getWallet(name);
  if (!wallet) throw new Error(`Wallet "${name}" not found`);
  return wallet.file_path;
}
