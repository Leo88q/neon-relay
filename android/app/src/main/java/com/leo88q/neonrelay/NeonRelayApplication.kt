package com.leo88q.neonrelay

import android.app.Application
import com.leo88q.neonrelay.wallet.WalletBridgeIntents
import com.leo88q.neonrelay.wallet.WalletHolder

class NeonRelayApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        WalletHolder.init(this)
        WalletBridgeIntents.bind(this)
    }
}
