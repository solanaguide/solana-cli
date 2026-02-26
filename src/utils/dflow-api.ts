import { getConfigValue } from '../core/config-manager.js';

export function getDFlowApiKey(): string | undefined {
  return getConfigValue('api.dflowApiKey') as string | undefined;
}

export function getDFlowBaseUrl(): string {
  return 'https://quote-api.dflow.net';
}

export function getDFlowHeaders(): Record<string, string> {
  const apiKey = getDFlowApiKey();
  return apiKey ? { 'x-api-key': apiKey } : {};
}
