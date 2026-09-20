package com.leo88q.neonrelay.wallet

import org.junit.Assert.*
import org.junit.Test

/**
 * Pure JVM tests for the rewards `claim` builder; no RPC, Android runtime
 * or private signing keys.
 *
 * Golden vectors are shared with onchain/test/rewards_claim.test.ts and
 * backend/test/rewards_pda.test.ts (program 2RaaXKUutemHtSZUsmnEv41ytWMka
 * XD6rcoziHGLRtmj, player 0x07 * 32, epoch 7): two independent
 * implementations, one truth.
 */
class RewardsTxBuilderTest {
    private val builder = RewardsTxBuilder
    private val tx = EconomyTxBuilder
    private val player = ByteArray(32) { 7 }
    private val program = tx.base58Decode("2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj")
    private val blockhash = ByteArray(32) { 9 }
    private val mint = ByteArray(32) { 3 }
    private val config = RewardsTxBuilder.RewardsConfig(mint, false, 12)

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

    private fun epochState(root: ByteArray, leafCount: Int) =
        RewardsTxBuilder.RewardsEpoch(7, root, leafCount)

    @Test fun pdaGoldensMatchBackendDerivation() {
        assertEquals(
            "44cc50e3b33d76d6062d779b385a853e3bf2c225d375322d6e65d94352075e7c",
            bytesToHex(builder.configAddress(program)),
        )
        assertEquals(
            "870396b6b6f2f3425637741b085f8ee58f5d911eab21a383eddb7b9cd9763afb",
            bytesToHex(builder.epochAddress(7, program)),
        )
        assertEquals(
            "9de9e925dae9005efdbc4870753598287060dcfc7063fc316ec67e79ca186387",
            bytesToHex(builder.claimAddress(7, player, program)),
        )
        assertEquals(
            "8aa581920e01b4d317deb42c7f49e80921069c3c5b78d2d0ae48600b0ae496f7",
            bytesToHex(builder.vaultAddress(program)),
        )
        invalid { builder.epochAddress(-1, program) }
        invalid { builder.claimAddress(7, ByteArray(31), program) }
    }

    private fun bytesToHex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    @Test fun merkleLeafAndIndexedFoldMatchProgramRule() {
        val leaves = listOf(
            builder.merkleLeaf(ByteArray(32) { 1 }, 100),
            builder.merkleLeaf(ByteArray(32) { 2 }, 250),
            builder.merkleLeaf(ByteArray(32) { 3 }, 400),
        )
        assertEquals("800c616f2fc929365fc4c4a1bda013523d9d691c4e5fd8bf41fb71ef2071966a", bytesToHex(leaves[1]))
        val proof = listOf(
            tx.hexToBytes("8d4ae284eb918c4af0acc58867b8ece221a13f63b2e76e3031ee4d576e18ac6e"),
            tx.hexToBytes("67c0382c46a2d79724ca3b7604b739279b6026d9fcd3cdbb72fa71d6fb90369d"),
        )
        val root = tx.hexToBytes("beabab895b91754cc53b68c5e9de7e4f59fd787f8cd72a43cde36dc211457493")
        assertTrue(builder.verifyProofIndexed(leaves[1], 1, proof, root))
        assertFalse(builder.verifyProofIndexed(leaves[1], 0, proof, root)) // wrong side folds
        assertFalse(builder.verifyProofIndexed(leaves[0], 1, proof, root)) // wrong leaf
        val tampered = proof.mapIndexed { i, p -> if (i == 0) p.copyOf().also { it[0] = (it[0] + 1).toByte() } else p }
        assertFalse(builder.verifyProofIndexed(leaves[1], 1, tampered, root))
        assertFalse(builder.verifyProofIndexed(leaves[1], 1, proof, root.copyOf().also { it[31] = 0 }))
        assertFalse(builder.verifyProofIndexed(ByteArray(31), 1, proof, root))
        assertFalse(builder.verifyProofIndexed(leaves[1], -1, proof, root))
        assertFalse(builder.verifyProofIndexed(leaves[1], 1, List(33) { ByteArray(32) }, root))
        invalid { builder.merkleLeaf(ByteArray(31), 1) }
        invalid { builder.merkleLeaf(player, 0) }
    }

    @Test fun exactDepthMatchesPaddedTreeRule() {
        assertEquals(0, builder.exactDepth(1))
        assertEquals(1, builder.exactDepth(2))
        assertEquals(2, builder.exactDepth(3))
        assertEquals(2, builder.exactDepth(4))
        assertEquals(4, builder.exactDepth(10))
        assertEquals(4, builder.exactDepth(16))
        assertEquals(5, builder.exactDepth(17))
        invalid { builder.exactDepth(0) }
    }

    @Test fun configRequiresExactLayoutAndDiscriminator() {
        val data = ByteArray(RewardsTxBuilder.CONFIG_SIZE)
        assertEquals(123, data.size)
        tx.hexToBytes("9b0caae01efacc82").copyInto(data)
        ByteArray(32) { 5 }.copyInto(data, 8) // authority (unchecked by the client)
        mint.copyInto(data, 40)
        data[72] = 0 // paused = false
        ByteBufferLe.u64(12).copyInto(data, 73) // epoch_count
        val parsed = builder.parseConfig(data)
        assertArrayEquals(mint, parsed.mint)
        assertFalse(parsed.paused)
        assertEquals(12L, parsed.epochCount)
        data[72] = 1
        assertTrue(builder.parseConfig(data).paused)
        invalid { builder.parseConfig(data.copyOf(122)) }
        invalid { builder.parseConfig(data.copyOf(124)) }
        invalid { builder.parseConfig(data.copyOf().also { it[0] = 0 }) }
        invalid { builder.parseConfig(data.copyOf().also { it[72] = 2 }) }
    }

    @Test fun epochStateRequiresMatchingIdAndLeafCount() {
        val data = ByteArray(RewardsTxBuilder.EPOCH_STATE_SIZE)
        assertEquals(61, data.size)
        tx.hexToBytes("bf3f8bed900cdfd2").copyInto(data)
        ByteBufferLe.u64(7).copyInto(data, 8) // id
        ByteArray(32) { 13 }.copyInto(data, 16) // root
        ByteBufferLe.u64(1_700_000_000).copyInto(data, 48) // published_at (unchecked)
        data[56] = 255.toByte() // bump (unchecked)
        (ByteBufferLe.u32(3)).copyInto(data, 57) // leaf_count
        val parsed = builder.parseEpochState(data, 7)
        assertEquals(7L, parsed.id)
        assertArrayEquals(ByteArray(32) { 13 }, parsed.root)
        assertEquals(3, parsed.leafCount)
        invalid { builder.parseEpochState(data, 8) } // id mismatch
        invalid { builder.parseEpochState(data.copyOf(60), 7) }
        invalid { builder.parseEpochState(data.copyOf().also { it[0] = 0 }, 7) }
        invalid { builder.parseEpochState(data.copyOf().also {
            ByteBufferLe.u32(0).copyInto(it, 57)
        }, 7) }
    }

    @Test fun claimDataMatchesGoldenEncoding() {
        val data = builder.claimData(7, 100, 0, listOf(ByteArray(32) { 11 }))
        assertEquals(
            "3ec6d6c1d59f6cd2070000000000000064000000000000000000000001000000" +
                "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
            bytesToHex(data),
        )
        invalid { builder.claimData(7, 0, 0, emptyList()) }
        invalid { builder.claimData(-1, 1, 0, emptyList()) }
        invalid { builder.claimData(7, 1, -1, emptyList()) }
        invalid { builder.claimData(7, 1, 0, List(33) { ByteArray(32) }) }
        invalid { builder.claimData(7, 1, 0, listOf(ByteArray(31))) }
    }

    @Test fun claimMessagePreservesProgramAccountOrder() {
        val root = tx.hexToBytes("beabab895b91754cc53b68c5e9de7e4f59fd787f8cd72a43cde36dc211457493")
        val proof = listOf(
            tx.hexToBytes("8d4ae284eb918c4af0acc58867b8ece221a13f63b2e76e3031ee4d576e18ac6e"),
            tx.hexToBytes("67c0382c46a2d79724ca3b7604b739279b6026d9fcd3cdbb72fa71d6fb90369d"),
        )
        // The golden tree's index-1 leaf belongs to wallet 0x02 * 32 / 250.
        val wallet = ByteArray(32) { 2 }
        val expected = listOf(
            builder.configAddress(program),
            builder.epochAddress(7, program),
            builder.claimAddress(7, wallet, program),
            wallet,
            tx.associatedTokenAddress(wallet, mint),
            mint,
            builder.vaultAddress(program),
            tx.TOKEN_PROGRAM_ID,
            tx.SYSTEM_PROGRAM_ID,
        )
        val message = builder.buildClaimMessage(
            wallet, config, epochState(root, 3), program, 7, 250, 1, proof, blockhash,
        )
        val r = Reader(message)
        assertEquals(1, r.byte()) // one signer
        assertEquals(0, r.byte()) // no readonly signers
        assertEquals(6, r.byte()) // config, epoch, mint, token, system, program
        val keys = List(r.compact()) { r.take(32) }
        assertEquals(10, keys.size)
        assertArrayEquals(wallet, keys.first())
        assertEquals(keys.size, keys.map { it.toList() }.toSet().size)
        assertArrayEquals(blockhash, r.take(32))
        assertEquals(1, r.compact())
        assertArrayEquals(program, keys[r.byte()])
        val indexes = List(r.compact()) { r.byte() }
        assertEquals(9, indexes.size)
        indexes.forEachIndexed { i, index -> assertArrayEquals(expected[i], keys[index]) }
        assertArrayEquals(builder.claimData(7, 250, 1, proof), r.take(r.compact()))
        assertEquals(message.size, r.pos) // no missing/trailing message fields
        val txBytes = tx.unsignedTransaction(message)
        assertEquals(1, txBytes[0].toInt())
        assertArrayEquals(ByteArray(64), txBytes.copyOfRange(1, 65))
        assertArrayEquals(message, txBytes.copyOfRange(65, txBytes.size))
    }

    @Test fun unverifiableClaimsAreRejectedBeforeCompilation() {
        val root = tx.hexToBytes("beabab895b91754cc53b68c5e9de7e4f59fd787f8cd72a43cde36dc211457493")
        val proof = listOf(
            tx.hexToBytes("8d4ae284eb918c4af0acc58867b8ece221a13f63b2e76e3031ee4d576e18ac6e"),
            tx.hexToBytes("67c0382c46a2d79724ca3b7604b739279b6026d9fcd3cdbb72fa71d6fb90369d"),
        )
        val wallet = ByteArray(32) { 2 }
        val build = { p: List<ByteArray>, leaf: Int, state: RewardsTxBuilder.RewardsEpoch,
            cfg: RewardsTxBuilder.RewardsConfig, amount: Long ->
            builder.buildClaimMessage(wallet, cfg, state, program, 7, amount, leaf, p, blockhash)
        }
        invalid { build(proof.drop(1), 1, epochState(root, 3), config, 250) } // short proof
        invalid { build(proof, 3, epochState(root, 3), config, 250) } // index out of range
        invalid { build(proof, 1, epochState(root, 3), config, 251) } // wrong amount
        invalid { build(proof, 1, epochState(root, 3), config.copy(paused = true), 250) } // paused
        invalid { build(proof, 1, epochState(root, 5), config, 250) } // depth 3 expected, 2 given
        invalid { build(proof, 1, epochState(ByteArray(32) { 9 }, 3), config, 250) } // wrong root
    }
}
