import { table } from './table.js';
import type { PortfolioReport, CompareResult } from '../core/portfolio-service.js';

const BAR_WIDTH = 30;
const FILL_BAR_WIDTH = 8;

// ── Section builder ──────────────────────────────────────

interface Section {
  title: string;
  body: string;
  footnote?: string;
}

function sectionHeader(title: string, width: number): string {
  const fill = Math.max(0, width - title.length - 4);
  return `── ${title} ${'─'.repeat(fill)}`;
}

function panelWidth(sections: Section[]): number {
  let max = 56; // minimum
  for (const s of sections) {
    for (const line of s.body.split('\n')) {
      if (line.length > max) max = line.length;
    }
    if (s.footnote) {
      for (const line of s.footnote.split('\n')) {
        if (line.length > max) max = line.length;
      }
    }
  }
  return max;
}

// ── Portfolio ─────────────────────────────────────────────

export function renderPortfolio(report: PortfolioReport): string {
  const sections: Section[] = [];
  const walletCount = report.wallets.length;
  const walletLabel = walletCount === 1 ? '1 wallet' : `${walletCount} wallets`;

  // ── Tokens ──
  const tokenPositions = report.positions.filter(p => p.type === 'token' && p.amount > 0);
  if (tokenPositions.length > 0) {
    const grouped = new Map<string, { symbol: string; amount: number; valueUsd: number | null }>();
    for (const p of tokenPositions) {
      const existing = grouped.get(p.symbol);
      if (existing) {
        existing.amount += p.amount;
        if (p.valueUsd != null) existing.valueUsd = (existing.valueUsd ?? 0) + p.valueUsd;
      } else {
        grouped.set(p.symbol, { symbol: p.symbol, amount: p.amount, valueUsd: p.valueUsd });
      }
    }
    const rows = [...grouped.values()].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

    sections.push({
      title: 'Tokens',
      body: table(
        rows.map(r => ({
          token: r.symbol,
          balance: fmtAmount(r.amount),
          value: r.valueUsd != null ? `$${fmt(r.valueUsd)}` : '—',
          pct: r.valueUsd != null && report.totalValueUsd > 0
            ? `${((r.valueUsd / report.totalValueUsd) * 100).toFixed(1)}%`
            : '',
        })),
        [
          { key: 'token', header: 'Token' },
          { key: 'balance', header: 'Balance', align: 'right' },
          { key: 'value', header: 'Value', align: 'right' },
          { key: 'pct', header: '%', align: 'right' },
        ],
      ),
    });
  }

  // ── Staking ──
  const stakePositions = report.positions.filter(p => p.type === 'stake');
  if (stakePositions.length > 0) {
    let footnote: string | undefined;
    if (report.claimableMev > 0) {
      footnote = `  * ${fmtAmount(report.claimableMev)} SOL claimable MEV — sol stake claim-mev`;
    }
    sections.push({
      title: 'Staking',
      body: table(
        stakePositions.map(p => {
          const addr = String(p.extra?.stakeAccount ?? '');
          const short = addr.length > 12 ? `${addr.slice(0, 4)}..${addr.slice(-5)}` : addr;
          const validator = String(p.extra?.validator ?? '—');
          const validatorShort = validator.length > 12 ? `${validator.slice(0, 6)}..${validator.slice(-4)}` : validator;
          const excess = p.extra?.claimableExcess as number ?? 0;
          return {
            account: short,
            staked: `${fmtAmount(p.amount)} SOL`,
            validator: validatorShort,
            mev: excess > 0 ? `${fmtAmount(excess)} SOL *` : '—',
          };
        }),
        [
          { key: 'account', header: 'Account' },
          { key: 'staked', header: 'Staked', align: 'right' },
          { key: 'validator', header: 'Validator' },
          { key: 'mev', header: 'MEV', align: 'right' },
        ],
      ),
      footnote,
    });
  }

  // ── Lending ──
  const lendPositions = report.positions.filter(p => p.type === 'lend');
  if (lendPositions.length > 0) {
    const deposits = lendPositions.filter(p => p.extra?.side === 'deposit');
    const borrows = lendPositions.filter(p => p.extra?.side === 'borrow');
    const allLendRows = [
      ...deposits.map(p => ({
        type: 'Deposit',
        token: p.symbol,
        amount: fmtAmount(p.amount),
        value: p.valueUsd != null ? `$${fmt(p.valueUsd)}` : '—',
        apy: p.extra?.apy != null ? `${((p.extra.apy as number) * 100).toFixed(2)}%` : '—',
      })),
      ...borrows.map(p => ({
        type: 'Borrow',
        token: p.symbol,
        amount: fmtAmount(p.amount),
        value: p.valueUsd != null ? `-$${fmt(Math.abs(p.valueUsd))}` : '—',
        apy: p.extra?.apy != null ? `${((p.extra.apy as number) * 100).toFixed(2)}%` : '—',
      })),
    ];

    const footnotes: string[] = [];
    const depositTotal = deposits.reduce((s, p) => s + (p.valueUsd ?? 0), 0);
    const borrowTotal = borrows.reduce((s, p) => s + Math.abs(p.valueUsd ?? 0), 0);
    if (deposits.length > 0 && borrows.length > 0) {
      footnotes.push(`  Net: $${fmt(depositTotal - borrowTotal)}`);
    }
    const healthFactors = borrows.map(p => p.extra?.healthFactor as number).filter(h => h != null && h > 0);
    if (healthFactors.length > 0) {
      const minHealth = Math.min(...healthFactors);
      if (minHealth < 1.1) {
        footnotes.push(`  ⚠ Health factor ${minHealth.toFixed(2)} — consider repaying or adding collateral`);
      }
    }

    sections.push({
      title: 'Lending',
      body: table(allLendRows, [
        { key: 'type', header: 'Type' },
        { key: 'token', header: 'Token' },
        { key: 'amount', header: 'Amount', align: 'right' },
        { key: 'value', header: 'Value', align: 'right' },
        { key: 'apy', header: 'APY', align: 'right' },
      ]),
      footnote: footnotes.length > 0 ? footnotes.join('\n') : undefined,
    });
  }

  // ── Open Orders ──
  const orderPositions = report.positions.filter(p => p.type === 'order');
  if (orderPositions.length > 0) {
    sections.push({
      title: 'Open Orders',
      body: table(
        orderPositions.map(p => {
          const orderType = String(p.extra?.orderType ?? '').toUpperCase();
          const outputSymbol = String(p.extra?.outputSymbol ?? '?');
          const orderKey = String(p.extra?.orderKey ?? '');
          const shortKey = orderKey.length > 12 ? `${orderKey.slice(0, 6)}..${orderKey.slice(-4)}` : orderKey;
          const fillPct = p.extra?.fillPct as number ?? 0;
          return {
            type: orderType,
            pair: `${p.symbol} → ${outputSymbol}`,
            remaining: fmtAmount(p.amount) + ' ' + p.symbol,
            value: p.valueUsd != null ? `$${fmt(p.valueUsd)}` : '—',
            filled: miniBar(fillPct),
            key: shortKey,
          };
        }),
        [
          { key: 'type', header: 'Type' },
          { key: 'pair', header: 'Pair' },
          { key: 'remaining', header: 'Remaining', align: 'right' },
          { key: 'value', header: 'Value', align: 'right' },
          { key: 'filled', header: 'Filled', align: 'right' },
          { key: 'key', header: 'Key' },
        ],
      ),
    });
  }

  // ── Predictions ──
  const predictPositions = report.positions.filter(p => p.type === 'predict');
  if (predictPositions.length > 0) {
    const claimableCount = predictPositions.filter(p => p.extra?.claimable).length;
    sections.push({
      title: 'Predictions',
      body: table(
        predictPositions.map(p => {
          const title = String(p.extra?.marketTitle || p.extra?.eventTitle || '');
          const shortTitle = title.length > 35 ? title.slice(0, 34) + '\u2026' : title;
          const cost = p.extra?.costBasis as number ?? 0;
          const pnl = p.extra?.unrealizedPnl as number ?? null;
          const pnlStr = pnl != null ? `${pnl >= 0 ? '+' : ''}$${fmt(pnl)}` : '—';
          const claimable = p.extra?.claimable as boolean ?? false;
          return {
            market: shortTitle,
            side: p.symbol,
            contracts: fmtAmount(p.amount),
            cost: `$${fmt(cost)}`,
            value: p.valueUsd != null ? `$${fmt(p.valueUsd)}` : '—',
            pnl: pnlStr,
            status: claimable ? 'claimable' : 'open',
          };
        }),
        [
          { key: 'market', header: 'Market' },
          { key: 'side', header: 'Side' },
          { key: 'contracts', header: 'Contracts', align: 'right' },
          { key: 'cost', header: 'Cost', align: 'right' },
          { key: 'value', header: 'Value', align: 'right' },
          { key: 'pnl', header: 'P&L', align: 'right' },
          { key: 'status', header: 'Status' },
        ],
      ),
      footnote: claimableCount > 0
        ? `  ${claimableCount} claimable — sol predict positions`
        : undefined,
    });
  }

  // ── Allocation ──
  if (report.allocation.length > 0) {
    const maxSymLen = Math.max(...report.allocation.map(a => a.symbol.length), 4);
    const allocLines = report.allocation.map(a => {
      const filled = Math.round((a.pct / 100) * BAR_WIDTH);
      const empty = BAR_WIDTH - filled;
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
      const pctStr = `${a.pct.toFixed(1)}%`.padStart(6);
      return `${a.symbol.padEnd(maxSymLen)}  ${bar} ${pctStr}`;
    });
    sections.push({ title: 'Allocation', body: allocLines.join('\n') });
  }

  // ── Wallets (only if multiple) ──
  if (report.wallets.length > 1) {
    const walletTotals = new Map<string, number>();
    for (const p of report.positions) {
      if (p.valueUsd != null) {
        walletTotals.set(p.wallet, (walletTotals.get(p.wallet) ?? 0) + p.valueUsd);
      }
    }
    const walletRows = [...walletTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({
        wallet: name,
        value: `$${fmt(value)}`,
        pct: report.totalValueUsd > 0
          ? `${((value / report.totalValueUsd) * 100).toFixed(1)}%`
          : '',
      }));
    sections.push({
      title: 'Wallets',
      body: table(walletRows, [
        { key: 'wallet', header: 'Wallet' },
        { key: 'value', header: 'Value', align: 'right' },
        { key: 'pct', header: '%', align: 'right' },
      ]),
    });
  }

  // ── Render ──────────────────────────────────────────────

  const width = panelWidth(sections);
  const lines: string[] = [];

  // Header
  const titleStr = 'Portfolio';
  const subtitle = `${walletLabel} \u00b7 $${fmt(report.totalValueUsd)}`;
  const gap = Math.max(2, width - titleStr.length - subtitle.length);
  lines.push(`${titleStr}${' '.repeat(gap)}${subtitle}`);
  lines.push('\u2500'.repeat(width));

  // Sections
  for (const section of sections) {
    lines.push('');
    lines.push(sectionHeader(section.title, width));
    lines.push(section.body);
    if (section.footnote) lines.push(section.footnote);
  }

  // Footer
  lines.push('');
  lines.push('\u2500'.repeat(width));

  const footerParts: string[] = [`$${fmt(report.totalValueUsd)} total`];
  if (report.lastSnapshot) {
    footerParts.push(`snapshot ${report.lastSnapshot.ago}`);
  }
  lines.push(footerParts.join(' \u00b7 '));

  // Signposts
  const hints: string[] = [];
  if (!report.lastSnapshot) {
    hints.push('sol portfolio snapshot — save current state');
  } else {
    hints.push('sol portfolio compare — see changes');
  }
  if (hints.length > 0) lines.push(hints.join('  '));

  return lines.join('\n');
}

// ── Compare ───────────────────────────────────────────────

export function renderCompare(result: CompareResult, label: string): string {
  const lines: string[] = [];

  lines.push(`${label}\n`);

  if (result.diffs.length === 0) {
    lines.push('No significant changes.');
  } else {
    lines.push(table(
      result.diffs.map(d => ({
        wallet: d.wallet,
        symbol: d.symbol,
        before: `$${fmt(d.valueBefore)}`,
        after: `$${fmt(d.valueAfter)}`,
        change: `${d.change >= 0 ? '+' : ''}$${fmt(d.change)}`,
        pct: d.changePct != null ? `${d.changePct >= 0 ? '+' : ''}${d.changePct.toFixed(1)}%` : '—',
      })),
      [
        { key: 'wallet', header: 'Wallet' },
        { key: 'symbol', header: 'Token' },
        { key: 'before', header: 'Before', align: 'right' },
        { key: 'after', header: 'After', align: 'right' },
        { key: 'change', header: 'Change', align: 'right' },
        { key: 'pct', header: '%', align: 'right' },
      ],
    ));
  }

  const sign = result.totalChange >= 0 ? '+' : '';
  const pctStr = result.totalChangePct != null
    ? ` (${sign}${result.totalChangePct.toFixed(1)}%)`
    : '';
  lines.push(`\nTotal: $${fmt(result.totalBefore)} \u2192 $${fmt(result.totalAfter)} (${sign}$${fmt(result.totalChange)})${pctStr}`);

  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────

function fmt(n: number): string {
  return n.toFixed(2);
}

function fmtAmount(n: number): string {
  if (n >= 1_000_000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toFixed(9);
}

function miniBar(pct: number): string {
  const filled = Math.round((pct / 100) * FILL_BAR_WIDTH);
  const empty = FILL_BAR_WIDTH - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  return `${bar} ${pct.toFixed(0)}%`;
}
