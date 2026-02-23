#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(join(__dirname, '..', 'dist', 'index.js')).href);
