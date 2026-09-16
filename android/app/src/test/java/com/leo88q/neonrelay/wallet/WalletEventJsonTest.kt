package com.leo88q.neonrelay.wallet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
                "\"public_key_base64\":\"AAAA\",\"error_message\":null}",
            json,
        )
    }

    @Test
    fun `secrets cannot appear in the payload`() {
        // The serializer has no parameter for tokens or signatures; this test
        // pins the schema so a future field addition is a visible diff.
        val json = WalletEventJson.build(connected = false, errorMessage = "denied")
        assertFalse(json.contains("auth"))
        assertFalse(json.contains("signature"))
        assertFalse(json.contains("token"))
        assertEquals(4, json.split(':').size - 1)
    }

    @Test
    fun `labels are escaped`() {
        val json = WalletEventJson.build(connected = true, accountLabel = "a\"b\\c\nd")
        assertEquals(
            "{\"connected\":true,\"account_label\":\"a\\\"b\\\\c\\nd\"," +
                "\"public_key_base64\":null,\"error_message\":null}",
            json,
        )
    }
}
