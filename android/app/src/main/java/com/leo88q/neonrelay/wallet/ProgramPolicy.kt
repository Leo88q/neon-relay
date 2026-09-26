package com.leo88q.neonrelay.wallet

/**
 * SW-2026-AGI (threats T75 / W81): which program ids this build is allowed to
 * talk to, enforced before anything is shown to the wallet for signature.
 *
 * The drainer pattern aimed at players is not a phishing link: a fake "AI bot"
 * tutorial walks the victim into pointing a perfectly honest client at a
 * attacker-deployed clone of the game program. The chain cannot tell the
 * difference (the clone does what its deployer wants), so the client must:
 * every transaction is compiled against a program id from the operator-set
 * allowlist, or it is refused before the wallet ever sees it.
 *
 * Fail-closed by construction: an empty allowlist rejects everything. The
 * operator sets the official ids at build/deployment time (never hardcoded in
 * the repository — no mainnet deployment exists yet, see UPSTREAM docs and
 * docs/DEVNET_RUNBOOK.md). Dev/test code opts in by configuring the allowlist
 * explicitly; there is no implicit "devnet bypass".
 */
object ProgramPolicy {

    @Volatile private var economyAllowlist: Set<String> = emptySet()
    @Volatile private var rewardsAllowlist: Set<String> = emptySet()

    /** Operator configuration (base58 program ids). Replaces the whole set. */
    fun configure(officialEconomyProgramIds: Collection<String>, officialRewardsProgramIds: Collection<String>) {
        economyAllowlist = officialEconomyProgramIds.toSet()
        rewardsAllowlist = officialRewardsProgramIds.toSet()
    }

    /** Test/dev isolation: back to the fail-closed empty state. */
    fun reset() {
        economyAllowlist = emptySet()
        rewardsAllowlist = emptySet()
    }

    fun isEconomyAllowed(programIdBase58: String): Boolean = programIdBase58 in economyAllowlist

    fun isRewardsAllowed(programIdBase58: String): Boolean = programIdBase58 in rewardsAllowlist

    /** Throws before any bytes reach the wallet when the program is not official. */
    fun requireEconomyAllowed(programId: ByteArray) {
        require(isEconomyAllowed(EconomyTxBuilder.base58Encode(programId))) {
            "SW-2026-AGI: economy program ${EconomyTxBuilder.base58Encode(programId)} is not in the official allowlist; " +
                "refusing to build a transaction (fake-program drainer defense)"
        }
    }

    fun requireRewardsAllowed(programId: ByteArray) {
        require(isRewardsAllowed(EconomyTxBuilder.base58Encode(programId))) {
            "SW-2026-AGI: rewards program ${EconomyTxBuilder.base58Encode(programId)} is not in the official allowlist; " +
                "refusing to build a transaction (fake-program drainer defense)"
        }
    }
}
