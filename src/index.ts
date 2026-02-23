import { Command } from 'commander';
import { setJsonMode, setVerboseMode } from './output/formatter.js';
import { setRpcOverride } from './core/rpc.js';
import { registerConfigCommand } from './commands/config.js';
import { registerWalletCommand } from './commands/wallet.js';
import { registerTokenCommand } from './commands/token.js';
import { registerStakeCommand } from './commands/stake.js';
import { registerLendCommand } from './commands/lend.js';
import { registerLpCommand } from './commands/lp.js';
import { registerPortfolioCommand } from './commands/portfolio.js';
import { registerTxCommand } from './commands/tx.js';
import { registerNetworkCommand } from './commands/network.js';
import { closeDb } from './db/database.js';

const program = new Command();

program
  .name('sol')
  .description('Solana CLI for Humans and LLM Agents')
  .version('0.1.0')
  .option('--json', 'Output structured JSON')
  .option('--rpc <url>', 'Override RPC endpoint')
  .option('--wallet <name>', 'Override default wallet')
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
registerLpCommand(program);
registerPortfolioCommand(program);
registerTxCommand(program);
registerNetworkCommand(program);

// Graceful cleanup
process.on('exit', () => { closeDb(); });

program.parseAsync(process.argv).catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
