package com.leo88q.neonrelay.wallet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WalletEventJsonTest {
    @Test
    fun `schema is closed and complete`() {
        val json = WalletEventJson.build(
            connected = true,
            accountLabel = "main account",
            publicKeyBase64 = "AAAA",
            errorMessage = null,
        )
        assertEquals(
            "{\"connected\":true,\"account_label\":\"main account\"," +
                "\"public_key_base64\":\"AAAA\",\"error_message\":null," +
                "\"transaction_signature\":null}",
            json,
        )
    }

    @Test
    fun `auth secrets cannot appear in the payload`() {
        // The serializer has no parameter for auth material; this test pins
        // the schema so a future field addition is a visible diff. Only the
        // public transaction signature (needed for claim confirmations) may
        // cross besides the account summary.
        val json = WalletEventJson.build(connected = false, errorMessage = "denied")
        assertFalse(json.contains("auth"))
        assertFalse(json.contains("token"))
        assertFalse(json.contains("challenge"))
        assertFalse(json.contains("signedPayloads"))
        assertEquals(5, json.split(':').size - 1)
    }

    @Test
    fun `transaction signature crosses when provided`() {
        val json = WalletEventJson.build(connected = true, transactionSignature = "5igkAz4MGBm8q9Jd")
        assertTrue(json.contains("\"transaction_signature\":\"5igkAz4MGBm8q9Jd\""))
    }

    @Test
    fun `labels are escaped`() {
        val json = WalletEventJson.build(connected = true, accountLabel = "a\"b\\c\nd")
        assertEquals(
            "{\"connected\":true,\"account_label\":\"a\\\"b\\\\c\\nd\"," +
                "\"public_key_base64\":null,\"error_message\":null," +
                "\"transaction_signature\":null}",
            json,
        )
    }
}
