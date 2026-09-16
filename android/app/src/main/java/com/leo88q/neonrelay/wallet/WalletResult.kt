package com.leo88q.neonrelay.wallet

/** A wallet account the user authorized for this app. Contains no secrets. */
data class WalletAccount(
    /** Raw account public key (32 bytes for Solana ed25519 accounts). */
    val publicKey: ByteArray,
    /** User-chosen display label, if the wallet provided one. */
    val label: String?,
) {
    val publicKeyBase64: String get() = android.util.Base64.encodeToString(publicKey, android.util.Base64.NO_WRAP)

    override fun equals(other: Any?): Boolean =
        other is WalletAccount && publicKey.contentEquals(other.publicKey) && label == other.label

    override fun hashCode(): Int = publicKey.contentHashCode() * 31 + (label?.hashCode() ?: 0)
}

/** A signature produced by the wallet over a challenge we supplied. */
data class SignedChallenge(
    val challenge: ByteArray,
    val signature: ByteArray,
    val account: WalletAccount,
) {
    override fun equals(other: Any?): Boolean =
        other is SignedChallenge && challenge.contentEquals(other.challenge) &&
            signature.contentEquals(other.signature) && account == other.account

    override fun hashCode(): Int =
        challenge.contentHashCode() * 31 + signature.contentHashCode()
}

/** Result of a wallet operation. Failures carry a typed [WalletError]. */
sealed interface WalletResult<out T> {
    data class Success<T>(val value: T) : WalletResult<T>
    data class Failure(val error: WalletError) : WalletResult<Nothing>

    val succeeded: Boolean get() = this is Success

    fun <R> map(transform: (T) -> R): WalletResult<R> = when (this) {
        is Success -> Success(transform(value))
        is Failure -> this
    }
}
