import { Command } from 'commander';
import { readlineSync } from '../utils/readline.js';
import { getConfigValue, setConfigValue, listConfig, getConfigPath, readConfig, writeConfig, isSecurityKey, isPermitted } from '../core/config-manager.js';
import { getSecurityStatus } from '../core/security.js';
import { output, success, failure, isJsonMode } from '../output/formatter.js';
import { table } from '../output/table.js';

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Manage CLI configuration');

  config
    .command('set <key> <value>')
    .description('Set a config value (e.g., sol config set rpc.url https://my-rpc.com)')
    .action((key: string, value: string) => {
      try {
        setConfigValue(key, value);
        if (isJsonMode()) {
          output(success({ key, value: getConfigValue(key) }));
        } else {
          console.log(`Set ${key} = ${value}`);
          if (isSecurityKey(key)) {
            console.log(`\nWhen you have finished modifying security settings, run 'sol config lock' to permanently prevent agents from changing settings.`);
          }
        }
      } catch (err: any) {
        output(failure('CONFIG_SET_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  config
    .command('get <key>')
    .description('Get a config value')
    .action((key: string) => {
      const value = getConfigValue(key);
      if (isJsonMode()) {
        output(success({ key, value }));
      } else if (value === undefined) {
        console.log(`(not set)`);
      } else {
        console.log(String(value));
      }
    });

  config
    .command('list')
    .description('List all config values')
    .action(() => {
      const values = listConfig();
      if (isJsonMode()) {
        output(success(values));
      } else {
        const entries = Object.entries(values);
        if (entries.length === 0) {
          console.log('No configuration set. Use: sol config set <key> <value>');
        } else {
          console.log(table(
            entries.map(([key, value]) => ({ key, value: String(value) })),
            [
              { key: 'key', header: 'Key' },
              { key: 'value', header: 'Value' },
            ]
          ));
        }
      }
    });

  config
    .command('path')
    .description('Show config file path')
    .action(() => {
      const path = getConfigPath();
      if (isJsonMode()) {
        output(success({ path }));
      } else {
        console.log(path);
      }
    });

  // ── config status ──────────────────────────────────────────

  config
    .command('status')
    .description('Show security posture — permissions, limits, and allowlists')
    .action(() => {
      try {
        const status = getSecurityStatus();

        if (isJsonMode()) {
          output(success(status));
          return;
        }

        console.log(`Security Settings (${status.configPath})\n`);

        // Permissions
        const locked = !status.canSetPermissions;
        console.log(`Permissions:${' '.repeat(30)}Agent-modifiable: ${locked ? 'no (locked)' : 'yes'}`);
        const permEntries = Object.entries(status.permissions);
        for (let i = 0; i < permEntries.length; i += 2) {
          const [k1, v1] = permEntries[i];
          const left = `  ${k1.padEnd(18)}${v1 ? '✓' : '✗'}`;
          if (i + 1 < permEntries.length) {
            const [k2, v2] = permEntries[i + 1];
            console.log(`${left}    ${k2.padEnd(18)}${v2 ? '✓' : '✗'}`);
          } else {
            console.log(left);
          }
        }
        console.log('');

        // Limits
        console.log('Limits:');
        if (status.limits.maxTransactionUsd != null) {
          console.log(`  Per-transaction   $${fmtUsd(status.limits.maxTransactionUsd)}`);
        } else {
          console.log('  Per-transaction   (none)');
        }
        if (status.limits.maxDailyUsd != null) {
          const pct = status.limits.maxDailyUsd > 0
            ? Math.round((status.limits.usedDailyUsd / status.limits.maxDailyUsd) * 100)
            : 0;
          console.log(`  Daily (24h)       $${fmtUsd(status.limits.maxDailyUsd)}`);
          console.log(`  Used (24h)        $${fmtUsd(status.limits.usedDailyUsd)} / $${fmtUsd(status.limits.maxDailyUsd)} (${pct}%)`);
        } else {
          console.log('  Daily (24h)       (none)');
        }
        console.log('');

        // Address allowlist
        if (status.allowlist.addressesActive) {
          console.log(`Address Allowlist (active):`);
          for (const addr of status.allowlist.addresses) {
            console.log(`  ${addr}`);
          }
          console.log(`  + ${status.ownWalletCount} own wallet${status.ownWalletCount !== 1 ? 's' : ''} (always allowed)`);
        } else {
          console.log('Address Allowlist: (inactive — all addresses allowed)');
        }
        console.log('');

        // Token allowlist
        if (status.allowlist.tokensActive) {
          console.log('Token Allowlist (active):');
          for (const tok of status.allowlist.tokens) {
            console.log(`  ${tok}`);
          }
        } else {
          console.log('Token Allowlist: (inactive — all tokens allowed)');
        }
        console.log('');

        // Warnings
        if (status.warnings.length > 0) {
          console.log('Warnings:');
          for (const w of status.warnings) {
            console.log(`  ${w}`);
          }
        }
      } catch (err: any) {
        output(failure('CONFIG_STATUS_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── config lock ────────────────────────────────────────────

  config
    .command('lock')
    .description('Lock security settings — prevents agents from changing permissions, limits, and allowlists via CLI')
    .action(async () => {
      try {
        if (!isPermitted('canSetPermissions')) {
          if (isJsonMode()) {
            output(success({ alreadyLocked: true, message: 'Settings are already locked.' }));
          } else {
            console.log('Settings are already locked.');
          }
          return;
        }

        const cfg = readConfig();
        const perms = cfg.permissions ?? {};
        const limits = cfg.limits ?? {};
        const allowlist = cfg.allowlist ?? {};

        if (!isJsonMode()) {
          console.log('Current security settings that will be locked:\n');

          // Permissions summary
          const permParts: string[] = [];
          const permKeys = ['canTransfer', 'canSwap', 'canStake', 'canLend', 'canBorrow',
            'canBurn', 'canExportWallet', 'canRemoveWallet'] as const;
          for (const k of permKeys) {
            permParts.push(`${k}=${(perms as any)[k] !== false ? '✓' : '✗'}`);
          }
          console.log(`Permissions: ${permParts.slice(0, 5).join(' ')}`);
          console.log(`             ${permParts.slice(5).join(' ')}`);
          console.log('');

          // Limits summary
          const limitParts: string[] = [];
          if (limits.maxTransactionUsd != null) limitParts.push(`maxTransactionUsd=$${fmtUsd(limits.maxTransactionUsd)}`);
          if (limits.maxDailyUsd != null) limitParts.push(`maxDailyUsd=$${fmtUsd(limits.maxDailyUsd)}`);
          console.log(`Limits:      ${limitParts.length > 0 ? limitParts.join('  ') : '(none)'}`);
          console.log('');

          // Allowlist summary
          const addrCount = allowlist.addresses?.length ?? 0;
          const tokCount = allowlist.tokens?.length ?? 0;
          const parts: string[] = [];
          if (addrCount > 0) parts.push(`${addrCount} address${addrCount !== 1 ? 'es' : ''}`);
          if (tokCount > 0) parts.push(`${tokCount} token${tokCount !== 1 ? 's' : ''} (${(allowlist.tokens ?? []).join(', ')})`);
          console.log(`Allowlist:   ${parts.length > 0 ? parts.join(', ') : '(none)'}`);
          console.log('');

          console.log('After locking, these can only be changed by a human editing:');
          console.log(`  ${getConfigPath()}`);
          console.log('');

          const answer = await readlineSync('Lock settings? This cannot be undone via CLI. (y/N) ');
          if (answer.toLowerCase() !== 'y') {
            console.log('Cancelled.');
            return;
          }
        }

        // Write canSetPermissions = false
        cfg.permissions = { ...cfg.permissions, canSetPermissions: false };
        writeConfig(cfg);

        if (isJsonMode()) {
          output(success({ locked: true, configPath: getConfigPath() }));
        } else {
          console.log('\nSettings locked. Permissions, limits, and allowlists can now only be changed by a human editing:');
          console.log(`  ${getConfigPath()}`);
        }
      } catch (err: any) {
        output(failure('CONFIG_LOCK_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
