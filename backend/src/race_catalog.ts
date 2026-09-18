/** Read-only dual-currency lobby policy. Never constructs payment transactions. */
import type { Config } from "./config.ts";
import { PRIZE_TABLE_BPS } from "./prize_table.ts";

export const CURRENCIES = ["SKR", "POTATO"] as const;
export type RaceCurrency = typeof CURRENCIES[number];
export const RAKE_BPS = 1000;
export const MAX_RAKE_BPS = 2000;
const U64_MAX = (1n << 64n) - 1n;

// Fees are whole-token decimal strings, NOT micro/base units. Mint decimals
// must be checked against chain state before any payment can be constructed.
export const RACE_TIERS = Object.freeze([
  Object.freeze({ id: "micro-sprint", name: "Micro Sprint", minPlayers: 10, maxPlayers: 10, entryTokens: "50", legendaryOnly: false }),
  Object.freeze({ id: "neon-dash", name: "Neon Dash", minPlayers: 20, maxPlayers: 20, entryTokens: "100", legendaryOnly: false }),
  Object.freeze({ id: "chromatic-cup", name: "Chromatic Cup", minPlayers: 50, maxPlayers: 50, entryTokens: "500", legendaryOnly: false }),
  Object.freeze({ id: "grand-prix", name: "Grand Prix", minPlayers: 100, maxPlayers: null, entryTokens: "2000", legendaryOnly: false }),
  // Capacity and funding of the freeroll must be supplied by its organizer.
  Object.freeze({ id: "legend-freeroll", name: "Legend Freeroll", minPlayers: null, maxPlayers: null, entryTokens: "0", legendaryOnly: true }),
]);

export function parseRaceCurrency(value: string): RaceCurrency {
  if (value !== "SKR" && value !== "POTATO") throw new Error("currency must be SKR or POTATO");
  return value;
}

export function raceLobby(config: Config, currency?: RaceCurrency) {
  const currencies = currency ? [currency] : CURRENCIES;
  return {
    version: 2,
    mode: "catalog-only",
    paymentsEnabled: false,
    disabledReason: "dual-mint-settlement-not-deployed",
    rakeBps: RAKE_BPS,
    maxRakeBps: MAX_RAKE_BPS,
    prizeTableBps: [...PRIZE_TABLE_BPS],
    rankedEntryRequired: true,
    categories: currencies.map((symbol) => {
      const mint = symbol === "SKR" ? config.skrMint : config.potatoMint;
      return {
        currency: symbol, mint, configured: mint !== null,
        // Presence of an address does not establish token authenticity or decimals.
        mintVerified: false,
        races: RACE_TIERS.map((tier) => ({ ...tier, joinEnabled: false })),
      };
    }),
  };
}

function u64(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) throw new RangeError("amount outside u64");
}

/** Exact base-unit split; fractional rake is rounded down, remainder to pool. */
export function splitEntryPool(entryBaseUnits: bigint, players: number, rakeBps = RAKE_BPS) {
  u64(entryBaseUnits);
  if (!Number.isSafeInteger(players) || players <= 0) throw new RangeError("invalid player count");
  if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > MAX_RAKE_BPS) throw new RangeError("invalid rake");
  const gross = entryBaseUnits * BigInt(players);
  u64(gross);
  // On-chain pay_entry applies rounding to each ticket, not the aggregate.
  const rake = (entryBaseUnits * BigInt(rakeBps) / 10_000n) * BigInt(players);
  return { gross, rake, prizePool: gross - rake };
}

/** Preview for exactly ten places. Leftover base units go to highest remainders,
 * tie-break by rank. Never creates or publishes a prize epoch. */
export function topTenShares(prizePool: bigint): bigint[] {
  u64(prizePool);
  const weighted = PRIZE_TABLE_BPS.map((bps) => prizePool * BigInt(bps));
  const shares = weighted.map((amount) => amount / 10_000n);
  const order = weighted.map((amount, index) => ({ index, remainder: amount % 10_000n }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  const leftover = prizePool - shares.reduce((sum, amount) => sum + amount, 0n);
  for (let i = 0; i < Number(leftover); i++) {
    const rank = order[i]!.index;
    shares[rank] = shares[rank]! + 1n;
  }
  return shares;
}
