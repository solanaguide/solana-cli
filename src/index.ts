import { Command } from 'commander';
import { setJsonMode, setVerboseMode } from './output/formatter.js';
import { setRpcOverride } from './core/rpc.js';
import { registerConfigCommand } from './commands/config.js';
import { registerWalletCommand } from './commands/wallet.js';
import { registerTokenCommand } from './commands/token.js';
import { registerStakeCommand } from './commands/stake.js';
import { registerLendCommand } from './commands/lend.js';
import { registerPortfolioCommand } from './commands/portfolio.js';
import { registerTxCommand } from './commands/tx.js';
import { registerNetworkCommand } from './commands/network.js';
import { closeDb } from './db/database.js';

const program = new Command();

program
  .name('sol')
  .description('Solana CLI for Humans and LLM Agents')
  .version('0.2.0')
  .option('--json', 'Output structured JSON')
  .option('--rpc <url>', 'Override RPC endpoint')
  .option('--verbose', 'Verbose output')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals();
    if (opts.json) setJsonMode(true);
    if (opts.verbose) setVerboseMode(true);
    if (opts.rpc) setRpcOverride(opts.rpc);
  });

// Register all command groups
registerConfigCommand(program);
registerWalletCommand(program);
registerTokenCommand(program);
registerStakeCommand(program);
registerLendCommand(program);
registerPortfolioCommand(program);
registerTxCommand(program);
registerNetworkCommand(program);

// Custom help: show subcommands grouped under each parent
program.configureHelp({
  formatHelp(cmd, helper) {
    const lines: string[] = [];
    lines.push(`${helper.commandDescription(cmd)}\n`);
    lines.push(`Usage: ${helper.commandUsage(cmd)}\n`);

    // Global options
    const opts = helper.visibleOptions(cmd);
    if (opts.length) {
      lines.push('Options:');
      const optWidth = Math.max(...opts.map(o => helper.optionTerm(o).length));
      for (const opt of opts) {
        const term = helper.optionTerm(opt).padEnd(optWidth + 2);
        lines.push(`  ${term}  ${helper.optionDescription(opt)}`);
      }
      lines.push('');
    }

    // Commands with subcommands
    lines.push('Commands:');
    for (const group of helper.visibleCommands(cmd)) {
      const children = group.commands;
      if (children.length === 0) {
        // Leaf command (e.g. portfolio, tx, network)
        const usage = group.usage().replace('[options] ', '').replace('[options]', '').trim();
        const term = usage ? `${group.name()} ${usage}` : group.name();
        lines.push(`  ${term.padEnd(38)}  ${group.description()}`);
      } else {
        lines.push(`  ${group.name()}`);
        for (const child of children) {
          const usage = child.usage().replace('[options] ', '').replace('[options]', '').trim();
          const term = usage ? `${child.name()} ${usage}` : child.name();
          lines.push(`    ${term.padEnd(36)}  ${child.description()}`);
        }
      }
    }

    return lines.join('\n') + '\n';
  },
});

// Graceful cleanup
process.on('exit', () => { closeDb(); });

program.parseAsync(process.argv).catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
