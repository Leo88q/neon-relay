package com.leo88q.neonrelay.wallet

/**
 * Pure Solana transaction builder for the neonrelay-rewards `claim`
 * instruction (onchain/programs/neonrelay-rewards, DEVNET_RUNBOOK §7).
 *
 * The backend's claim-intent response (`POST /v1/rewards/claim-intent`) is
 * trusted for *amounts* but never for *correctness*: before any message is
 * built, [verifyClaim] replays the exact on-chain checks client-side —
 * paused flag, exact proof depth and leaf-index bound from the epoch's
 * leaf count (Tranche A rule), and the indexed Merkle fold against the
 * epoch root read over RPC. A claim that would fail on-chain is therefore
 * rejected before the wallet ever sees it, and [buildClaimMessage] refuses
 * to compile an unverified claim.
 *
 * Byte-level crypto (base58, PDA derivation, ATA derivation, legacy message
 * compilation) is shared with [EconomyTxBuilder]; only the rewards account
 * layouts, seeds and the `claim` payload live here. Anchor discriminators
 * (first 8 bytes of sha256), pinned by onchain/test/rewards_claim.test.ts:
 *   claim ix    = 3ec6d6c1d59f6cd2   ("global:claim")
 *   Config      = 9b0caae01efacc82   ("account:Config")
 *   EpochState  = bf3f8bed900cdfd2   ("account:EpochState")
 *
 * PDA seeds (note: the epoch id is big-endian u64 in seeds, little-endian
 * in the instruction payload — exactly as the program declares):
 *   config  = ["neonrelay_config"]
 *   epoch   = ["neonrelay_epoch", epoch_be64]
 *   claim   = ["neonrelay_claim", epoch_be64, player]
 *   vault   = ["neonrelay_vault"]
 */
object RewardsTxBuilder {

    const val CLAIM_DISCRIMINATOR = "3ec6d6c1d59f6cd2"
    const val CONFIG_DISCRIMINATOR = "9b0caae01efacc82"
    const val EPOCH_STATE_DISCRIMINATOR = "bf3f8bed900cdfd2"

    const val CONFIG_SEED = "neonrelay_config"
    const val EPOCH_SEED = "neonrelay_epoch"
    const val CLAIM_SEED = "neonrelay_claim"
    const val VAULT_SEED = "neonrelay_vault"

    const val MAX_PROOF_LEN = 32

    /** 8-byte discriminator + Borsh Config layout (see lib.rs). */
    const val CONFIG_SIZE = 8 + 32 + 32 + 1 + 8 + 1 + 1 + 32 + 8

    /** 8-byte discriminator + Borsh EpochState layout (see lib.rs). */
    const val EPOCH_STATE_SIZE = 8 + 8 + 32 + 8 + 1 + 4

    fun configAddress(programId: ByteArray): ByteArray =
        EconomyTxBuilder.findProgramAddress(listOf(CONFIG_SEED.toByteArray()), programId).first

    fun epochAddress(epoch: Long, programId: ByteArray): ByteArray {
        require(epoch >= 0) { "epoch must be non-negative" }
        return EconomyTxBuilder.findProgramAddress(
            listOf(EPOCH_SEED.toByteArray(), ByteBufferLe.u64be(epoch)), programId,
        ).first
    }

    fun claimAddress(epoch: Long, player: ByteArray, programId: ByteArray): ByteArray {
        require(epoch >= 0 && player.size == 32) { "invalid claim address inputs" }
        return EconomyTxBuilder.findProgramAddress(
            listOf(CLAIM_SEED.toByteArray(), ByteBufferLe.u64be(epoch), player), programId,
        ).first
    }

    fun vaultAddress(programId: ByteArray): ByteArray =
        EconomyTxBuilder.findProgramAddress(listOf(VAULT_SEED.toByteArray()), programId).first

    // ---------------------------------------------------------------- accounts

    /** Rewards Config subset the claim flow needs (mint, paused, epoch_count). */
    data class RewardsConfig(
        val mint: ByteArray,
        val paused: Boolean,
        val epochCount: Long,
    )

    fun parseConfig(data: ByteArray): RewardsConfig {
        require(data.size == CONFIG_SIZE) { "rewards config account has an unexpected size" }
        require(data.copyOfRange(0, 8).contentEquals(EconomyTxBuilder.hexToBytes(CONFIG_DISCRIMINATOR))) {
            "wrong rewards config discriminator"
        }
        require(data[8 + 64].toInt() in 0..1) { "invalid paused flag" }
        val mint = data.copyOfRange(8 + 32, 8 + 64)
        val paused = data[8 + 64].toInt() != 0
        val epochCount = ByteBufferLe.u64At(data, 8 + 65)
        require(epochCount >= 0) { "invalid epoch count" }
        return RewardsConfig(mint, paused, epochCount)
    }

    /** Rewards EpochState subset the claim flow needs (id, root, leaf_count). */
    data class RewardsEpoch(
        val id: Long,
        val root: ByteArray,
        val leafCount: Int,
    )

    fun parseEpochState(data: ByteArray, epoch: Long): RewardsEpoch {
        require(data.size == EPOCH_STATE_SIZE) { "rewards epoch account has an unexpected size" }
        require(data.copyOfRange(0, 8).contentEquals(EconomyTxBuilder.hexToBytes(EPOCH_STATE_DISCRIMINATOR))) {
            "wrong rewards epoch discriminator"
        }
        val id = ByteBufferLe.u64At(data, 8)
        require(id == epoch) { "epoch account id does not match the claim epoch" }
        val root = data.copyOfRange(16, 48)
        val leafCount = ByteBufferLe.u32At(data, 57)
        require(leafCount > 0) { "epoch has no leaves" }
        return RewardsEpoch(id, root, leafCount)
    }

    // ------------------------------------------------------------------- merkle

    /** Program's leaf rule: sha256(wallet32 || amount_be64). */
    fun merkleLeaf(wallet: ByteArray, amount: Long): ByteArray {
        require(wallet.size == 32 && amount > 0) { "invalid leaf inputs" }
        return EconomyTxBuilder.sha256(wallet + ByteBufferLe.u64be(amount))
    }

    /**
     * Program's indexed fold: even index ⇒ current on the left, then the
     * index shifts right. Returns false (never throws) on any mismatch so
     * callers can distinguish "bad proof" from malformed input.
     */
    fun verifyProofIndexed(leaf: ByteArray, leafIndex: Int, proof: List<ByteArray>, root: ByteArray): Boolean {
        if (leaf.size != 32 || root.size != 32 || leafIndex < 0) return false
        if (proof.size > MAX_PROOF_LEN || proof.any { it.size != 32 }) return false
        var current = leaf
        var index = leafIndex
        for (sibling in proof) {
            current = if (index and 1 == 0) {
                EconomyTxBuilder.sha256(current + sibling)
            } else {
                EconomyTxBuilder.sha256(sibling + current)
            }
            index = index ushr 1
        }
        return current.contentEquals(root)
    }

    /** Padded-tree depth the program derives: trailing zeros of next_pow2(n). */
    fun exactDepth(leafCount: Int): Int {
        require(leafCount > 0) { "leaf count must be positive" }
        var slots = 1
        var depth = 0
        while (slots < leafCount) {
            slots = slots shl 1
            depth++
        }
        return depth
    }

    /**
     * Client-side replay of every `claim` precondition that depends only on
     * chain state plus the intent: paused flag, exact depth, index bound and
     * the Merkle fold against the epoch root. Throws on the first failure.
     */
    fun verifyClaim(
        player: ByteArray,
        config: RewardsConfig,
        epochState: RewardsEpoch,
        epoch: Long,
        amount: Long,
        leafIndex: Int,
        proof: List<ByteArray>,
    ) {
        require(player.size == 32) { "player must be 32 bytes" }
        require(!config.paused) { "rewards program is paused" }
        require(epochState.id == epoch) { "epoch state does not match the claim epoch" }
        require(amount > 0) { "claim amount must be greater than zero" }
        require(leafIndex >= 0 && leafIndex < epochState.leafCount) { "leaf index out of range" }
        require(proof.size == exactDepth(epochState.leafCount)) {
            "proof length does not match the epoch depth"
        }
        val leaf = merkleLeaf(player, amount)
        require(verifyProofIndexed(leaf, leafIndex, proof, epochState.root)) {
            "proof does not verify against the epoch root"
        }
    }

    // ------------------------------------------------------------------- claim

    /** Borsh payload: discriminator + u64 epoch + u64 amount + u32 index + vec proof. */
    fun claimData(epoch: Long, amount: Long, leafIndex: Int, proof: List<ByteArray>): ByteArray {
        require(epoch >= 0 && amount > 0 && leafIndex >= 0) { "invalid claim integers" }
        require(proof.size <= MAX_PROOF_LEN && proof.all { it.size == 32 }) { "invalid proof" }
        var out = EconomyTxBuilder.hexToBytes(CLAIM_DISCRIMINATOR) + ByteBufferLe.u64(epoch) +
            ByteBufferLe.u64(amount) + ByteBufferLe.u32(leafIndex) + ByteBufferLe.u32(proof.size)
        proof.forEach { out = out + it }
        return out
    }

    /**
     * Message for claim(epoch, amount, leaf_index, proof). Accounts in exact
     * program order: config, epoch, claim record (created, player pays),
     * player (signs), player ATA, mint, vault, token and system programs.
     * The claim is fully verified before compilation — see [verifyClaim].
     */
    fun buildClaimMessage(
        player: ByteArray,
        config: RewardsConfig,
        epochState: RewardsEpoch,
        programId: ByteArray,
        epoch: Long,
        amount: Long,
        leafIndex: Int,
        proof: List<ByteArray>,
        blockhash: ByteArray,
    ): ByteArray {
        verifyClaim(player, config, epochState, epoch, amount, leafIndex, proof)
        val playerAta = EconomyTxBuilder.associatedTokenAddress(player, config.mint)
        val metas = listOf(
            EconomyTxBuilder.AccountMeta(configAddress(programId), signer = false, writable = false),
            EconomyTxBuilder.AccountMeta(epochAddress(epoch, programId), signer = false, writable = false),
            EconomyTxBuilder.AccountMeta(claimAddress(epoch, player, programId), signer = false, writable = true),
            EconomyTxBuilder.AccountMeta(player, signer = true, writable = true),
            EconomyTxBuilder.AccountMeta(playerAta, signer = false, writable = true),
            EconomyTxBuilder.AccountMeta(config.mint, signer = false, writable = false),
            EconomyTxBuilder.AccountMeta(vaultAddress(programId), signer = false, writable = true),
            EconomyTxBuilder.AccountMeta(EconomyTxBuilder.TOKEN_PROGRAM_ID, signer = false, writable = false),
            EconomyTxBuilder.AccountMeta(EconomyTxBuilder.SYSTEM_PROGRAM_ID, signer = false, writable = false),
        )
        return EconomyTxBuilder.compileMessage(
            player, metas, programId,
            claimData(epoch, amount, leafIndex, proof), IntArray(9) { it }, blockhash,
        )
    }
}
