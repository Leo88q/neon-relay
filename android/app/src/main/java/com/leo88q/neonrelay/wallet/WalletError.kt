package com.leo88q.neonrelay.wallet

/**
 * Everything that can go wrong while talking to a wallet, as a closed set.
 * The UI maps these to strings; the native layer only receives [userMessage]
 * for [WalletError.OperationFailed]-style failures, never stack traces.
 */
sealed class WalletError(val userMessage: String, cause: Throwable? = null) :
    Exception(userMessage, cause) {

    /** No Mobile Wallet Adapter capable wallet app is installed. */
    class NoWalletAvailable :
        WalletError("No Solana wallet with Mobile Wallet Adapter support is installed.")

    /** The user closed the wallet UI without deciding. */
    class UserCancelled :
        WalletError("Wallet request cancelled.")

    /** The wallet (or its user) explicitly refused the request. */
    class UserDenied(detail: String? = null) :
        WalletError(detail ?: "The wallet denied the request.")

    /** The stored auth token is gone or invalid; a fresh authorization is needed. */
    class SessionExpired :
        WalletError("The wallet session expired. Connect again to continue.")

    /** The wallet answered with something the protocol contract forbids. */
    class ProtocolViolation(detail: String, cause: Throwable? = null) :
        WalletError("Wallet protocol error: $detail", cause)

    /** Anything else; `detail` is logged, `userMessage` is shown. */
    class OperationFailed(detail: String, cause: Throwable? = null) :
        WalletError("Wallet operation failed.", cause) {
        val detail: String = detail
    }
}
