/**
 * Approved top-10 prize split in basis points of the epoch prize pool
 * (places 1..10; sums to 10000). Mirrors onchain PRIZE_TABLE_BPS exactly —
 * backend/test/economy.test.ts asserts the two stay identical.
 */
export const PRIZE_TABLE_BPS = [2500, 1800, 1400, 1100, 900, 700, 600, 500, 300, 200] as const;
