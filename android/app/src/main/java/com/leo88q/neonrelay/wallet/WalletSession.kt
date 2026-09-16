package com.leo88q.neonrelay.wallet

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Persistence for the wallet session.
 *
 * The MWA auth token is a bearer credential for the wallet association (it is
 * *not* a private key and never leaves this device). It is stored in
 * EncryptedSharedPreferences when the Android Keystore cooperates; if it does
 * not, we degrade to *not persisting the token at all* instead of storing it in
 * plain text. Public account data (label + public key) is not sensitive and is
 * always persisted so the UI can show the bound account after process death.
 */
interface WalletSessionStore {
    var authToken: String?
    var accountPublicKey: ByteArray?
    var accountLabel: String?
    fun clear()
}

class AndroidWalletSessionStore(context: Context) : WalletSessionStore {
    private val prefs: SharedPreferences = openPrefs(context)
    private val encrypted: Boolean = prefs.javaClass.name.contains("Encrypted", true)

    override var authToken: String?
        get() = if (encrypted) prefs.getString(KEY_TOKEN, null) else null
        set(value) {
            if (!encrypted) return // never persist the token unencrypted
            prefs.edit().apply {
                if (value == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, value)
            }.apply()
        }

    override var accountPublicKey: ByteArray?
        get() = prefs.getString(KEY_PUBKEY, null)?.let { Base64.decode(it, Base64.NO_WRAP) }
        set(value) = prefs.edit().apply {
            if (value == null) remove(KEY_PUBKEY)
            else putString(KEY_PUBKEY, Base64.encodeToString(value, Base64.NO_WRAP))
        }.apply()

    override var accountLabel: String?
        get() = prefs.getString(KEY_LABEL, null)
        set(value) = prefs.edit().apply {
            if (value == null) remove(KEY_LABEL) else putString(KEY_LABEL, value)
        }.apply()

    override fun clear() {
        prefs.edit().clear().apply()
    }

    private companion object {
        const val KEY_TOKEN = "mwa_auth_token"
        const val KEY_PUBKEY = "wallet_account_pubkey"
        const val KEY_LABEL = "wallet_account_label"
        const val PREFS = "neonrelay_wallet"

        fun openPrefs(context: Context): SharedPreferences = try {
            val masterKey = Class.forName("androidx.security.crypto.MasterKey\$Builder")
                .getConstructor(Context::class.java)
                .newInstance(context)
            val builder = Class.forName("androidx.security.crypto.MasterKey\$Builder")
                .getMethod("setKeyScheme", Class.forName("androidx.security.crypto.MasterKey\$KeyScheme"))
                .invoke(masterKey, Class.forName("androidx.security.crypto.MasterKey\$KeyScheme")
                    .getField("AES256_GCM").get(null))
            Class.forName("androidx.security.crypto.EncryptedSharedPreferences")
                .getMethod(
                    "create",
                    Context::class.java, String::class.java,
                    Class.forName("androidx.security.crypto.MasterKey"),
                    Class.forName("androidx.security.crypto.EncryptedSharedPreferences\$PrefKeyEncryptionScheme"),
                    Class.forName("androidx.security.crypto.EncryptedSharedPreferences\$PrefValueEncryptionScheme"),
                )
                .invoke(
                    null, context, PREFS, builder,
                    Class.forName("androidx.security.crypto.EncryptedSharedPreferences\$PrefKeyEncryptionScheme")
                        .getField("AES256_SIV").get(null),
                    Class.forName("androidx.security.crypto.EncryptedSharedPreferences\$PrefValueEncryptionScheme")
                        .getField("AES256_GCM").get(null),
                ) as SharedPreferences
        } catch (t: Throwable) {
            Log.w("NeonRelayWallet", "EncryptedSharedPreferences unavailable; auth token will not be persisted", t)
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        }
    }
}

/** In-memory store used by the JVM unit tests. */
class InMemoryWalletSessionStore : WalletSessionStore {
    override var authToken: String? = null
    override var accountPublicKey: ByteArray? = null
    override var accountLabel: String? = null
    override fun clear() {
        authToken = null
        accountPublicKey = null
        accountLabel = null
    }
}

/**
 * Observable session state. Survives rotation because it lives in a
 * [WalletViewModel]; survives process death through [WalletSessionStore].
 */
class WalletSession(private val store: WalletSessionStore) {
    enum class State { DISCONNECTED, CONNECTING, CONNECTED, ERROR }

    data class Snapshot(
        val state: State = State.DISCONNECTED,
        val account: WalletAccount? = null,
        val message: String? = null,
    )

    private val _snapshot = MutableStateFlow(restore())
    val snapshot: StateFlow<Snapshot> = _snapshot.asStateFlow()

    var authToken: String?
        get() = store.authToken
        set(value) {
            store.authToken = value
        }

    fun update(state: State, account: WalletAccount? = null, message: String? = null) {
        _snapshot.value = Snapshot(state, account ?: _snapshot.value.account, message)
        if (account != null) {
            store.accountPublicKey = account.publicKey
            store.accountLabel = account.label
        }
        if (state == State.DISCONNECTED) {
            store.authToken = null
        }
    }

    fun clear() {
        store.clear()
        _snapshot.value = Snapshot()
    }

    private fun restore(): Snapshot {
        val key = store.accountPublicKey ?: return Snapshot()
        return Snapshot(State.DISCONNECTED, WalletAccount(key, store.accountLabel))
    }
}
