package com.leo88q.neonrelay.wallet

/**
 * One-way channel from the Kotlin wallet layer into the native game code.
 *
 * Only the sanitized wallet summary (connected flag, account label, base64
 * public key, user-safe error text) is ever pushed; see
 * `src/neonrelay/wallet_bridge.h` for the contract. Auth tokens, signatures and
 * challenge payloads never cross this boundary.
 */
object NativeBridge {
    const val EVENT_DISCONNECTED = 0
    const val EVENT_CONNECTED = 1
    const val EVENT_ERROR = 2

    /** False when the native library is not present (e.g. JVM unit tests). */
    val available: Boolean by lazy {
        runCatching { System.loadLibrary("neonrelay") }.isSuccess
    }

    fun pushWalletEvent(type: Int, json: String) {
        if (!available) return
        nativePushWalletEvent(type, json)
    }

    /** Called from native code (JNI) when the in-game Wallet screen asks. */
    @JvmStatic
    fun requestWalletConnect() {
        WalletHolder.request(WalletHolder.Request.Connect)
        WalletBridgeIntents.start()
    }

    @JvmStatic
    fun requestWalletDisconnect() {
        WalletHolder.request(WalletHolder.Request.Disconnect)
        WalletBridgeIntents.start()
    }

    private external fun nativePushWalletEvent(type: Int, json: String)
}
