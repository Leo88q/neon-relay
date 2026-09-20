package com.leo88q.neonrelay.wallet

/**
 * Builds the sanitized event payload for the native wallet bridge.
 *
 * Deliberately a near-closed schema: connected, account_label,
 * public_key_base64, error_message, and transaction_signature. Auth
 * material (MWA auth tokens, challenge bytes, message signatures) has no
 * parameter here and can never cross — that is the point. The one
 * exception is transaction_signature: a *transaction* signature is public
 * chain data (anyone can read it on Solana), not a secret, and the game
 * needs it to post claim confirmations
 * (`POST /v1/rewards/claim-confirmation`). See
 * `src/neonrelay/wallet_bridge.h`.
 */
object WalletEventJson {
    fun build(
        connected: Boolean,
        accountLabel: String? = null,
        publicKeyBase64: String? = null,
        errorMessage: String? = null,
        transactionSignature: String? = null,
    ): String = buildString {
        append('{')
        append("\"connected\":").append(connected)
        append(",\"account_label\":").append(stringOrNull(accountLabel))
        append(",\"public_key_base64\":").append(stringOrNull(publicKeyBase64))
        append(",\"error_message\":").append(stringOrNull(errorMessage))
        append(",\"transaction_signature\":").append(stringOrNull(transactionSignature))
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
