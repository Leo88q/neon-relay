package com.leo88q.neonrelay.wallet

import android.content.Context
import android.content.Intent

/** Starts the invisible bridge activity; safe to call repeatedly. */
object WalletBridgeIntents {
    private var appContext: Context? = null

    fun bind(context: Context) {
        appContext = context.applicationContext
    }

    fun start() {
        val context = appContext ?: return
        context.startActivity(
            Intent(context, WalletBridgeActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
        )
    }
}
