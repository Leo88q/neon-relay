package com.leo88q.neonrelay.wallet

import androidx.activity.ComponentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Thin, lifecycle-aware view over [WalletHolder] for Compose/XML UI (the
 * in-game Wallet screen, stage 10). State lives in the holder so the UI, the
 * bridge activity and the native layer all observe the same session.
 */
class WalletViewModel : ViewModel() {

    val snapshot: StateFlow<WalletSession.Snapshot> = WalletHolder.session.snapshot
    val inFlight: StateFlow<Boolean> = WalletHolder.inFlight

    fun attach(activity: ComponentActivity) = WalletHolder.attach(activity)

    fun connect() {
        WalletHolder.request(WalletHolder.Request.Connect)
        viewModelScope.launch { startBridgeIfNeeded() }
    }

    fun disconnect() {
        WalletHolder.request(WalletHolder.Request.Disconnect)
        viewModelScope.launch { startBridgeIfNeeded() }
    }

    fun signChallenge(challenge: ByteArray) {
        WalletHolder.request(WalletHolder.Request.Sign(challenge))
        viewModelScope.launch { startBridgeIfNeeded() }
    }

    fun forgetWallet() = WalletHolder.session.clear()

    private fun startBridgeIfNeeded() {
        // The bridge activity is started by the UI host through
        // WalletBridgeIntents.start(); kept here for headless callers/tests.
        WalletBridgeIntents.start()
    }
}
