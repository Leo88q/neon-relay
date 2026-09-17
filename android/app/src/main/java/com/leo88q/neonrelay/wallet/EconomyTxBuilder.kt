package com.leo88q.neonrelay.wallet

import java.math.BigInteger
import java.security.MessageDigest

/**
 * Pure Solana transaction builder for the neonrelay-economy program
 * (onchain/programs/neonrelay-economy, docs/PLAY_ECONOMY.md).
 *
 * Everything here is deterministic byte work — base58, PDA derivation with the
 * RFC 8032 on-curve test, associated-token addresses, Anchor instruction
 * payloads and legacy message compilation — so the wallet flow needs no
 * backend session: references and PDAs are recomputed on-device exactly as
 * backend/src/economy.ts does. No key material is ever stored: the signer
 * pubkey comes from the MWA authorization result and signing happens inside
 * the wallet app via signAndSendTransactions.
 *
 * Anchor discriminators (first 8 bytes of sha256("global:<ix>")), pinned by
 * backend test fixtures:
 *   pay_entry   = bb0a5a4353acc4cf
 *   claim_prize = 9de98b79f63eeaeb
 */
object EconomyTxBuilder {

    const val PAY_ENTRY_DISCRIMINATOR = "bb0a5a4353acc4cf"
    const val CLAIM_PRIZE_DISCRIMINATOR = "9de98b79f63eeaeb"

    val TOKEN_PROGRAM_ID = base58Decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    val ASSOCIATED_TOKEN_PROGRAM_ID = base58Decode("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    val SYSTEM_PROGRAM_ID = ByteArray(32)
    private val PDA_MARKER = "ProgramDerivedAddress".toByteArray(Charsets.UTF_8)
    const val CONFIG_SEED = "neonrelay_economy_config"
    const val ENTRY_SEED = "neonrelay_entry"
    const val PRIZES_SEED = "neonrelay_prizes"
    const val CLAIM_SEED = "neonrelay_prize_claim"

    // ---------------------------------------------------------------- base58

    private const val ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

    fun base58Encode(bytes: ByteArray): String {
        var n = BigInteger(1, bytes)
        val sb = StringBuilder()
        val fiftyEight = BigInteger.valueOf(58)
        while (n.signum() > 0) {
            val (q, r) = n.divideAndRemainder(fiftyEight)
            sb.append(ALPHABET[r.toInt()])
            n = q
        }
        for (b in bytes) {
            if (b.toInt() != 0) break
            sb.append('1')
        }
        return if (sb.isEmpty()) "1" else sb.toString()
    }

    fun base58Decode(s: String): ByteArray {
        var n = BigInteger.ZERO
        val fiftyEight = BigInteger.valueOf(58)
        for (c in s) {
            val v = ALPHABET.indexOf(c)
            require(v >= 0) { "invalid base58 character: $c" }
            n = n.multiply(fiftyEight).add(BigInteger.valueOf(v.toLong()))
        }
        val body = n.toByteArray().let {
            if (it.isNotEmpty() && it[0].toInt() == 0) it.copyOfRange(1, it.size) else it
        }
        var zeros = 0
        for (c in s) {
            if (c != '1') break
            zeros++
        }
        return ByteArray(zeros) + body
    }

    fun sha256(vararg parts: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        parts.forEach { md.update(it) }
        return md.digest()
    }

    // ---------------------------------------------------------------- curve

    private val P = BigInteger.TWO.pow(255).subtract(BigInteger.valueOf(19))
    private val D = P.subtract(BigInteger.valueOf(121665))
        .multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P)

    private fun modPow(b: BigInteger, e: BigInteger): BigInteger = b.modPow(e, P)

    /** RFC 8032 decompression success == the encoding is a curve point. */
    fun isOnCurveEncoded(enc: ByteArray): Boolean {
        if (enc.size != 32) return false
        val reversed = enc.reversedArray()
        val raw = BigInteger(1, reversed)
        val y = raw.and(BigInteger.TWO.pow(255).subtract(BigInteger.ONE))
        if (y >= P) return false
        val sign = raw.shiftRight(255).and(BigInteger.ONE)
        val y2 = y.multiply(y).mod(P)
        val u = y2.subtract(BigInteger.ONE).mod(P)
        val v = D.multiply(y2).add(BigInteger.ONE).mod(P)
        val v3 = v.multiply(v).mod(P).multiply(v).mod(P)
        val v7 = v3.multiply(v3).mod(P).multiply(v).mod(P)
        var x = u.multiply(v3).mod(P)
            .multiply(modPow(u.multiply(v7).mod(P), P.subtract(BigInteger.valueOf(5)).divide(BigInteger.valueOf(8)))).mod(P)
        val vx2 = v.multiply(x).mod(P).multiply(x).mod(P)
        x = when {
            vx2 == u -> x
            vx2 == P.subtract(u).mod(P) ->
                x.multiply(modPow(BigInteger.TWO, P.subtract(BigInteger.ONE).divide(BigInteger.valueOf(4)))).mod(P)
            else -> return false
        }
        if (x.signum() == 0 && sign.signum() == 1) return false
        return true
    }

    fun findProgramAddress(seeds: List<ByteArray>, programId: ByteArray): Pair<ByteArray, Int> {
        for (bump in 255 downTo 0) {
            val parts = seeds + byteArrayOf(bump.toByte()) + programId + PDA_MARKER
            val candidate = sha256(*parts)
            if (!isOnCurveEncoded(candidate)) return candidate to bump
        }
        error("no valid PDA bump found")
    }

    fun configAddress(programId: ByteArray): ByteArray =
        findProgramAddress(listOf(CONFIG_SEED.toByteArray()), programId).first

    fun ticketAddress(reference: ByteArray, wallet: ByteArray, programId: ByteArray): ByteArray =
        findProgramAddress(listOf(ENTRY_SEED.toByteArray(), reference, wallet), programId).first

    fun prizesAddress(epoch: Long, programId: ByteArray): ByteArray {
        val le = ByteBufferLe.u64(epoch)
        return findProgramAddress(listOf(PRIZES_SEED.toByteArray(), le), programId).first
    }

    fun claimAddress(epoch: Long, wallet: ByteArray, programId: ByteArray): ByteArray {
        val le = ByteBufferLe.u64(epoch)
        return findProgramAddress(listOf(CLAIM_SEED.toByteArray(), le, wallet), programId).first
    }

    /** Associated token account PDA: [wallet, token program, mint]. */
    fun associatedTokenAddress(wallet: ByteArray, mint: ByteArray): ByteArray =
        findProgramAddress(listOf(wallet, TOKEN_PROGRAM_ID, mint), ASSOCIATED_TOKEN_PROGRAM_ID).first

    /** entryReference: SHA256(kind u8 || epoch u64le || extra u64le || wallet32). */
    fun entryReference(kind: Int, epoch: Long, wallet: ByteArray, extra: Long = 0L): ByteArray =
        sha256(byteArrayOf(kind.toByte()) + ByteBufferLe.u64(epoch) + ByteBufferLe.u64(extra) + wallet)

    // ---------------------------------------------------------------- config

    /** Borsh layout after the 8-byte discriminator (see backend economy.ts). */
    data class EconomyConfig(
        val mint: ByteArray,
        val treasuryAta: ByteArray,
        val vaultAta: ByteArray,
        val feeMatch: Long,
        val feeTournament: Long,
        val paused: Boolean,
    )

    fun parseConfig(data: ByteArray): EconomyConfig {
        require(data.size >= 8 + 128 + 2 + 16 + 2) { "economy config account too short" }
        val mint = data.copyOfRange(8 + 32, 8 + 64)
        val treasury = data.copyOfRange(8 + 64, 8 + 96)
        val vault = data.copyOfRange(8 + 96, 8 + 128)
        val rake = ByteBufferLe.u16(data, 8 + 128)
        val feeMatch = ByteBufferLe.u64At(data, 8 + 130)
        val feeTournament = ByteBufferLe.u64At(data, 8 + 138)
        val paused = data[8 + 146].toInt() != 0
        require(rake in 0..2000) { "implausible rake in config account" }
        return EconomyConfig(mint, treasury, vault, feeMatch, feeTournament, paused)
    }

    // ---------------------------------------------------------------- messages

    private data class AccountMeta(val key: ByteArray, val signer: Boolean, val writable: Boolean)

    private fun compileMessage(
        payer: ByteArray,
        metas: List<AccountMeta>,
        programId: ByteArray,
        data: ByteArray,
        ixAccountIndexes: IntArray,
        blockhash: ByteArray,
    ): ByteArray {
        // legacy message: header(3) + compact accounts + blockhash + compact ix
        val keys = mutableListOf<AccountMeta>()
        fun indexOf(meta: AccountMeta): Int {
            val existing = keys.indexOfFirst { it.key.contentEquals(meta.key) }
            if (existing >= 0) return existing
            keys.add(meta)
            return keys.size - 1
        }
        val indexes = ixAccountIndexes.map { metas[it] }
        indexes.forEach { indexOf(it) }
        // payer first, then writable signers, then readonly signers, then writables, then readonly
        keys.sortWith(
            compareByDescending<AccountMeta> { it.signer }
                .thenByDescending { it.writable }
        )
        if (keys.none { it.key.contentEquals(payer) }) {
            keys.add(0, AccountMeta(payer, true, true))
        }
        val signerCount = keys.count { it.signer }
        val readonlySigners = keys.count { it.signer && !it.writable }
        val readonlyNonSigners = keys.count { !it.signer && !it.writable }
        val out = java.io.ByteArrayOutputStream()
        out.write(byteArrayOf(signerCount.toByte(), readonlySigners.toByte(), readonlyNonSigners.toByte()))
        writeCompact(out, keys.size)
        keys.forEach { out.write(it.key) }
        out.write(blockhash)
        writeCompact(out, 1) // one instruction
        val programIndex = keys.indexOfFirst { it.key.contentEquals(programId) }
            .let { if (it >= 0) it else { keys.add(AccountMeta(programId, false, false)); keys.size - 1 } }
        val resolved = indexes.map { meta -> keys.indexOfFirst { it.key.contentEquals(meta.key) }.toByte() }
        writeCompact(out, resolved.size)
        resolved.forEach { out.write(it.toInt()) }
        writeCompact(out, data.size)
        out.write(data)
        return out.toByteArray()
    }

    private fun writeCompact(out: java.io.ByteArrayOutputStream, value: Int) {
        var v = value
        while (true) {
            val byte = (v and 0x7f)
            v = v ushr 7
            if (v != 0) out.write(byte or 0x80) else {
                out.write(byte)
                return
            }
        }
    }

    fun payEntryData(reference: ByteArray, kind: Int): ByteArray =
        hexToBytes(PAY_ENTRY_DISCRIMINATOR) + reference + byteArrayOf(kind.toByte())

    fun claimPrizeData(epoch: Long, amount: Long, leafIndex: Int, proof: List<ByteArray>): ByteArray {
        var out = hexToBytes(CLAIM_PRIZE_DISCRIMINATOR) + ByteBufferLe.u64(epoch) + ByteBufferLe.u64(amount) +
            ByteBufferLe.u32(leafIndex) + ByteBufferLe.u32(proof.size)
        proof.forEach { out = out + it }
        return out
    }

    /** Message for pay_entry(reference, kind): player pays fee, split on-chain. */
    fun buildPayEntryMessage(
        player: ByteArray,
        config: EconomyConfig,
        programId: ByteArray,
        reference: ByteArray,
        kind: Int,
        blockhash: ByteArray,
    ): ByteArray {
        val playerAta = associatedTokenAddress(player, config.mint)
        val metas = listOf(
            AccountMeta(player, signer = true, writable = true),
            AccountMeta(playerAta, signer = false, writable = true),
            AccountMeta(configAddress(programId), signer = false, writable = false),
            AccountMeta(config.vaultAta, signer = false, writable = true),
            AccountMeta(config.treasuryAta, signer = false, writable = true),
            AccountMeta(ticketAddress(reference, player, programId), signer = false, writable = true),
            AccountMeta(TOKEN_PROGRAM_ID, signer = false, writable = false),
            AccountMeta(SYSTEM_PROGRAM_ID, signer = false, writable = false),
        )
        return compileMessage(player, metas, programId, payEntryData(reference, kind), IntArray(8) { it }, blockhash)
    }

    /** Message for claim_prize(epoch, amount, leaf_index, proof). */
    fun buildClaimPrizeMessage(
        player: ByteArray,
        config: EconomyConfig,
        programId: ByteArray,
        epoch: Long,
        amount: Long,
        leafIndex: Int,
        proof: List<ByteArray>,
        blockhash: ByteArray,
    ): ByteArray {
        val playerAta = associatedTokenAddress(player, config.mint)
        val metas = listOf(
            AccountMeta(player, signer = true, writable = true),
            AccountMeta(playerAta, signer = false, writable = true),
            AccountMeta(configAddress(programId), signer = false, writable = false),
            AccountMeta(config.vaultAta, signer = false, writable = true),
            AccountMeta(prizesAddress(epoch, programId), signer = false, writable = false),
            AccountMeta(claimAddress(epoch, player, programId), signer = false, writable = true),
            AccountMeta(TOKEN_PROGRAM_ID, signer = false, writable = false),
            AccountMeta(SYSTEM_PROGRAM_ID, signer = false, writable = false),
        )
        return compileMessage(
            player, metas, programId,
            claimPrizeData(epoch, amount, leafIndex, proof), IntArray(8) { it }, blockhash,
        )
    }

    fun hexToBytes(hex: String): ByteArray =
        hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}

/** Little-endian integer helpers (Borsh). */
object ByteBufferLe {
    fun u64(value: Long): ByteArray =
        ByteArray(8) { i -> ((value ushr (8 * i)) and 0xff).toByte() }

    fun u32(value: Int): ByteArray =
        ByteArray(4) { i -> ((value ushr (8 * i)) and 0xff).toByte() }

    fun u16(data: ByteArray, offset: Int): Int =
        (data[offset].toInt() and 0xff) or ((data[offset + 1].toInt() and 0xff) shl 8)

    fun u64At(data: ByteArray, offset: Int): Long {
        var v = 0L
        for (i in 7 downTo 0) v = (v shl 8) or (data[offset + i].toLong() and 0xff)
        return v
    }
}
