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
    const val EVENT_ECONOMY = 3

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

    /**
     * Economy flows (SKR entry payments / prize claims, docs/PLAY_ECONOMY.md).
     * The MWA transaction builder lands in stage 17 (BL-17); until then the
     * request is logged and surfaced as a user-safe wallet error event.
     */
    @JvmStatic
    fun requestEconomy(json: String) {
        android.util.Log.i("NeonRelayEconomy", "economy request: $json")
        WalletHolder.request(WalletHolder.Request.Economy(json))
        WalletBridgeIntents.start()
    }

    @JvmStatic
    fun requestWalletDisconnect() {
        WalletHolder.request(WalletHolder.Request.Disconnect)
        WalletBridgeIntents.start()
    }

    /**
     * Cache the JavaVM and a global ref to this class inside the native shim.
     * SDL2 owns this library's JNI_OnLoad, so the shim cannot cache there;
     * this must run on a Java thread (native-attached threads cannot resolve
     * app classes via FindClass). Called from ClientActivity.onCreate().
     */
    @JvmStatic
    fun warmUp() {
        if (available) nativeWarmUp()
    }

    private external fun nativePushWalletEvent(type: Int, json: String)
    private external fun nativeWarmUp()
}
