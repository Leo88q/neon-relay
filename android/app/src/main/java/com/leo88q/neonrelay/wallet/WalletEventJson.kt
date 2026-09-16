package com.leo88q.neonrelay.wallet

/**
 * Builds the sanitized event payload for the native wallet bridge.
 *
 * Deliberately a closed schema: connected, account_label, public_key_base64 and
 * error_message. Anything else the wallet returns (auth tokens, signatures,
 * challenge bytes) cannot be serialized here, which is the point: the native
 * game code must never receive wallet secrets. See
 * `src/neonrelay/wallet_bridge.h`.
 */
object WalletEventJson {
    fun build(
        connected: Boolean,
        accountLabel: String? = null,
        publicKeyBase64: String? = null,
        errorMessage: String? = null,
    ): String = buildString {
        append('{')
        append("\"connected\":").append(connected)
        append(",\"account_label\":").append(stringOrNull(accountLabel))
        append(",\"public_key_base64\":").append(stringOrNull(publicKeyBase64))
        append(",\"error_message\":").append(stringOrNull(errorMessage))
        append('}')
    }

    private fun stringOrNull(value: String?): String =
        value?.let { "\"${escape(it)}\"" } ?: "null"

    private fun escape(value: String): String = buildString(value.length + 8) {
        for (c in value) {
            when (c) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (c.code < 0x20) append("\\u%04x".format(c.code)) else append(c)
            }
        }
    }
}
