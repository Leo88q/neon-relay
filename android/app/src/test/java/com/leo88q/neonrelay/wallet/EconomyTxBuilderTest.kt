package com.leo88q.neonrelay.wallet

import org.junit.Assert.*
import org.junit.Test

/** Pure JVM tests; no RPC, Android runtime or private signing keys. */
class EconomyTxBuilderTest {
    private val builder = EconomyTxBuilder
    private val player = ByteArray(32) { 7 }
    private val program = builder.base58Decode("FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9")
    private val blockhash = ByteArray(32) { 9 }
    private val config = EconomyTxBuilder.EconomyConfig(
        ByteArray(32) { 3 }, ByteArray(32) { 4 }, ByteArray(32) { 5 }, 50, 100, false,
    )

    private class Reader(private val bytes: ByteArray) {
        var pos = 0
        fun byte(): Int = bytes[pos++].toInt() and 255
        fun take(size: Int): ByteArray = bytes.copyOfRange(pos, pos + size).also { pos += size }
        fun compact(): Int {
            var value = 0
            var shift = 0
            do {
                val b = byte()
                value = value or ((b and 127) shl shift)
                shift += 7
            } while (b and 128 != 0)
            return value
        }
    }

    private fun invalid(block: () -> Unit) {
        try {
            block()
            fail("expected rejection")
        } catch (_: IllegalArgumentException) { }
    }

    @Test fun base58MatchesKnownPublicAddresses() {
        for (text in listOf("11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9")) {
            val raw = builder.base58Decode(text)
            assertEquals(32, raw.size)
            assertEquals(text, builder.base58Encode(raw))
        }
        assertEquals("", builder.base58Encode(byteArrayOf()))
        assertArrayEquals(byteArrayOf(0, 0, 9), builder.base58Decode("11A"))
        assertEquals("11A", builder.base58Encode(byteArrayOf(0, 0, 9)))
        invalid { builder.base58Decode("0OIl") }
    }

    private fun checkMessage(message: ByteArray, expectedAccounts: List<ByteArray>, expectedData: ByteArray) {
        val r = Reader(message)
        assertEquals(1, r.byte())
        assertEquals(0, r.byte())
        assertEquals(4, r.byte()) // config, token, system and program
        val keys = List(r.compact()) { r.take(32) }
        assertEquals(9, keys.size)
        assertArrayEquals(player, keys.first())
        assertEquals(keys.size, keys.map { it.toList() }.toSet().size)
        assertArrayEquals(blockhash, r.take(32))
        assertEquals(1, r.compact())
        assertArrayEquals(program, keys[r.byte()])
        val indexes = List(r.compact()) { r.byte() }
        assertEquals(8, indexes.size)
        indexes.forEachIndexed { i, index -> assertArrayEquals(expectedAccounts[i], keys[index]) }
        assertArrayEquals(expectedData, r.take(r.compact()))
        assertEquals(message.size, r.pos) // no missing/trailing message fields
        val tx = builder.unsignedTransaction(message)
        assertEquals(1, tx[0].toInt())
        assertArrayEquals(ByteArray(64), tx.copyOfRange(1, 65))
        assertArrayEquals(message, tx.copyOfRange(65, tx.size))
    }

    @Test fun referenceAndPdaMatchBackendGoldenVector() {
        val reference = builder.entryReference(0, 7, player, 42)
        assertArrayEquals(builder.hexToBytes("3a3af01a1ec0caa5611de67f03d68f493ba86ac94f732d1712ecc006ce274067"), reference)
        assertArrayEquals(builder.hexToBytes("398b4a9e392f105b2de81ea17dc5b3d827e84bd3a86f89617f44d262a4ac0b5a"),
            builder.ticketAddress(reference, player, program))
    }

    @Test fun payMessageHasProgramIndexAndValidTransactionEnvelope() {
        val reference = builder.entryReference(0, 7, player, 42)
        val expected = listOf(player, builder.associatedTokenAddress(player, config.mint),
            builder.configAddress(program), config.vaultAta, config.treasuryAta,
            builder.ticketAddress(reference, player, program), builder.TOKEN_PROGRAM_ID, builder.SYSTEM_PROGRAM_ID)
        checkMessage(builder.buildPayEntryMessage(player, config, program, reference, 0, blockhash),
            expected, builder.hexToBytes("bb0a5a4353acc4cf") + reference + byteArrayOf(0))
    }

    @Test fun claimMessagePreservesAccountOrderAndProofPayload() {
        val expected = listOf(player, builder.associatedTokenAddress(player, config.mint),
            builder.configAddress(program), config.vaultAta, builder.prizesAddress(7, program),
            builder.claimAddress(7, player, program), builder.TOKEN_PROGRAM_ID, builder.SYSTEM_PROGRAM_ID)
        val proof = listOf(ByteArray(32) { 11 })
        val data = builder.hexToBytes("9de98b79f63eeaeb") + ByteBufferLe.u64(7) +
            ByteBufferLe.u64(100) + ByteBufferLe.u32(0) + ByteBufferLe.u32(1) + proof[0]
        checkMessage(builder.buildClaimPrizeMessage(player, config, program, 7, 100, 0, proof, blockhash), expected, data)
    }

    @Test fun malformedInputsAreRejectedBeforeSigning() {
        invalid { builder.payEntryData(ByteArray(31), 0) }
        invalid { builder.payEntryData(ByteArray(32), 2) }
        invalid { builder.claimPrizeData(0, 0, 0, emptyList()) }
        invalid { builder.claimPrizeData(-1, 1, 0, emptyList()) }
        invalid { builder.claimPrizeData(0, 1, -1, emptyList()) }
        invalid { builder.claimPrizeData(0, 1, 0, List(33) { ByteArray(32) }) }
        invalid { builder.claimPrizeData(0, 1, 0, listOf(ByteArray(31))) }
        invalid { builder.hexToBytes("abc") }
        invalid { builder.hexToBytes("zz") }
        invalid { builder.findProgramAddress(listOf(ByteArray(33)), program) }
        invalid { builder.buildPayEntryMessage(player, config, program, ByteArray(32), 0, ByteArray(31)) }
        invalid { builder.unsignedTransaction(byteArrayOf(2, 0, 0)) }
        invalid { builder.unsignedTransaction(byteArrayOf(1, 0, 0) + ByteArray(1232)) }
    }

    @Test fun configRequiresExactLayoutAndDiscriminator() {
        val data = ByteArray(156)
        builder.hexToBytes("d9cc7f2f97dfa4b6").copyInto(data)
        config.mint.copyInto(data, 40)
        config.treasuryAta.copyInto(data, 72)
        config.vaultAta.copyInto(data, 104)
        data[136] = 0xe8.toByte() // 1000 bps
        data[137] = 3
        ByteBufferLe.u64(50).copyInto(data, 138)
        ByteBufferLe.u64(100).copyInto(data, 146)
        val parsed = builder.parseConfig(data)
        assertArrayEquals(config.mint, parsed.mint)
        assertEquals(50L, parsed.feeMatch)
        assertFalse(parsed.paused)
        invalid { builder.parseConfig(data.copyOf(155)) }
        invalid { builder.parseConfig(data.copyOf(157)) }
        invalid { builder.parseConfig(data.copyOf().also { it[0] = 0 }) }
        invalid { builder.parseConfig(data.copyOf().also { it[154] = 2 }) }
        invalid { builder.parseConfig(data.copyOf().also { it[153] = 0x80.toByte() }) }

        val data204 = ByteArray(204)
        data.copyInto(data204)
        val parsed204 = builder.parseConfig(data204)
        assertArrayEquals(config.mint, parsed204.mint)
        assertEquals(50L, parsed204.feeMatch)
        assertFalse(parsed204.paused)
        invalid { builder.parseConfig(data204.copyOf(203)) }
        invalid { builder.parseConfig(data204.copyOf(205)) }
    }

    // ------------------------------------------------- SW-2026-AGI (82/T75)

    @Test fun systemProgramIsNeverAValidInstructionProgram() {
        // Durable-nonce advance (System Program, ix 4) and raw lamport moves
        // must be unbuildable from the game transaction path.
        val metas = listOf(
            EconomyTxBuilder.AccountMeta(player, signer = true, writable = true),
            EconomyTxBuilder.AccountMeta(ByteArray(32) { 1 }, signer = false, writable = true),
        )
        invalid {
            builder.compileMessage(
                player, metas, builder.SYSTEM_PROGRAM_ID,
                builder.hexToBytes("0400000000000000"), intArrayOf(0, 1), blockhash,
            )
        }
        // The audited program id still compiles.
        val message = builder.compileMessage(
            player, metas, program,
            builder.payEntryData(ByteArray(32) { 2 }, 0), intArrayOf(0, 1), blockhash,
        )
        assertEquals(1, message[0].toInt())
    }

    @Test fun programPolicyIsFailClosedAndAllowlistDriven() {
        ProgramPolicy.reset()
        // Empty allowlist: everything is refused, including a plausible id.
        invalid { ProgramPolicy.requireEconomyAllowed(program) }
        ProgramPolicy.configure(
            listOf(builder.base58Encode(program)),
            listOf("Reward11111111111111111111111111111111111111"),
        )
        ProgramPolicy.requireEconomyAllowed(program)
        ProgramPolicy.requireRewardsAllowed(builder.base58Decode("Reward11111111111111111111111111111111111111"))
        invalid { ProgramPolicy.requireEconomyAllowed(builder.base58Decode("Ev1l11111111111111111111111111111111111111")) }
        invalid { ProgramPolicy.requireRewardsAllowed(program) }
        ProgramPolicy.reset()
        invalid { ProgramPolicy.requireEconomyAllowed(program) }
    }
}
