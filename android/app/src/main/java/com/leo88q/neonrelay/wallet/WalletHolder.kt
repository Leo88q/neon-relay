package com.leo88q.neonrelay.wallet

import android.app.Application
import androidx.activity.ComponentActivity
import com.leo88q.neonrelay.BuildConfig
import com.solana.mobilewalletadapter.clientlib.Blockchain
import com.solana.mobilewalletadapter.clientlib.Solana
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Application-scoped owner of the wallet session.
 *
 * The native game activity is an SDL `NativeActivity` subclass and therefore
 * *not* a `ComponentActivity`, which the Mobile Wallet Adapter client library
 * requires for its activity-result launcher. Wallet work is therefore executed
 * by [WalletBridgeActivity], a short-lived transparent `ComponentActivity`,
 * while the session itself lives here so it survives both.
 *
 * A wallet is optional: nothing in this object is initialized unless the user
 * (or the in-game Wallet screen) explicitly asks for a wallet operation.
 */
object WalletHolder {

    sealed interface Request {
        data object Connect : Request
        data object Disconnect : Request
        data class Sign(val challenge: ByteArray) : Request
        /**
         * Economy flow (SKR entry payment / prize claim). The JSON carries
         * operator config from the game (program id, mint, rpc/backend urls)
         * plus action/kind/epoch; see docs/PLAY_ECONOMY.md and BL-17.
         */
        data class Economy(val json: String) : Request
    }

    private lateinit var application: Application

    fun init(app: Application) {
        if (!::application.isInitialized) application = app
    }

    val session: WalletSession by lazy {
        checkInitialized()
        WalletSession(AndroidWalletSessionStore(application))
    }

    val manager: WalletManager by lazy {
        checkInitialized()
        WalletManager(
            session = session,
            identityUri = BuildConfig.WALLET_IDENTITY_URI,
            identityName = "Neon Relay",
            cluster = cluster(),
        )
    }

    private val _pending = MutableStateFlow<Request?>(null)
    val pending: StateFlow<Request?> = _pending.asStateFlow()

    private val _inFlight = MutableStateFlow(false)
    val inFlight: StateFlow<Boolean> = _inFlight.asStateFlow()

    /** Entry point for the UI and for the native bridge (JNI). */
    fun request(request: Request) {
        checkInitialized()
        _pending.value = request
    }

    fun takeRequest(): Request? = _pending.getAndUpdate { null }

    fun markInFlight(value: Boolean) {
        _inFlight.value = value
    }

    /** Attach the MWA activity-result launcher; called by the bridge activity. */
    fun attach(activity: ComponentActivity) {
        checkInitialized()
        manager.attach(activity)
    }

    private fun checkInitialized() {
        check(::application.isInitialized) { "WalletHolder.init(application) must be called first" }
    }

    private fun cluster(): Blockchain = when (BuildConfig.REWARD_CLUSTER) {
        "mainnet" -> Solana.Mainnet
        "testnet" -> Solana.Testnet
        else -> Solana.Devnet
    }

    private fun <T> MutableStateFlow<T>.getAndUpdate(update: (T) -> T): T {
        while (true) {
            val current = value
            val next = update(current)
            if (compareAndSet(current, next)) return current
        }
    }
}
