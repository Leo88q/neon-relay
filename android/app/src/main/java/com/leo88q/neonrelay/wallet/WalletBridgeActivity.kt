package com.leo88q.neonrelay.wallet

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * Invisible `ComponentActivity` that hosts the Mobile Wallet Adapter
 * activity-result launcher while a wallet operation is in flight.
 *
 * Lifecycle behaviour:
 *  - *rotation*: the activity-result API redelivers pending results after
 *    recreation; [WalletHolder.inFlight] stops us from starting an operation
 *    twice;
 *  - *process death*: the auth token and account are restored from
 *    [WalletSession], so the next operation reauthorizes transparently;
 *  - *cancellation*: the wallet UI closing without a decision maps to
 *    [WalletError.UserCancelled] and simply finishes this activity;
 *  - *no wallet installed*: [WalletError.NoWalletAvailable] is reported and the
 *    game keeps running without a wallet.
 */
class WalletBridgeActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WalletHolder.attach(this)
        if (savedInstanceState == null) {
            lifecycleScope.launch { pump() }
        } else {
            // recreated mid-operation: the launcher result will resume the flow
            lifecycleScope.launch {
                if (!WalletHolder.inFlight.value) pump()
            }
        }
    }

    private suspend fun pump() {
        val request = WalletHolder.takeRequest() ?: run { finish(); return }
        WalletHolder.markInFlight(true)
        val manager = WalletHolder.manager
        when (request) {
            is WalletHolder.Request.Connect -> manager.connect()
            is WalletHolder.Request.Disconnect -> manager.disconnect()
            is WalletHolder.Request.Sign -> manager.signChallenge(request.challenge)
        }
        WalletHolder.markInFlight(false)
        finish()
    }
}
