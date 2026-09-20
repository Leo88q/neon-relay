package com.leo88q.neonrelay.wallet

import android.net.Uri
import androidx.activity.ComponentActivity
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.Blockchain
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.Solana
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient.AuthorizationResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The only class that talks to the Mobile Wallet Adapter.
 *
 * Responsibilities:
 *  - associate with a wallet app and (re)authorize,
 *  - sign reward-backend challenges (`signMessages`),
 *  - keep [WalletSession] up to date,
 *  - push a *sanitized* event to the native game code via [NativeBridge].
 *
 * Wallet optionality: nothing here is required to play. The game runs fully
 * without a wallet; [attach] may never be called and every entry point returns
 * a [WalletResult.Failure] instead of throwing.
 */
class WalletManager(
    private val session: WalletSession,
    identityUri: String,
    identityName: String,
    iconUri: String = identityUri,
    private val cluster: Blockchain = Solana.Devnet,
) {
    private val adapter = MobileWalletAdapter(
        ConnectionIdentity(
            identityUri = Uri.parse(identityUri),
            iconUri = Uri.parse(iconUri),
            identityName = identityName,
        )
    ).apply { blockchain = cluster }

    private var sender: ActivityResultSender? = null
    private val mutex = Mutex()

    /** Must be called from the hosting activity's onCreate (registers a launcher). */
    fun attach(activity: ComponentActivity) {
        sender = ActivityResultSender(activity)
        // A token persisted before process death is reusable via reauthorize.
        adapter.authToken = session.authToken
    }

    val attached: Boolean get() = sender != null

    /** Authorize (or reauthorize) and remember the account. Playing never requires this. */
    suspend fun connect(): WalletResult<WalletAccount> = mutex.withLock {
        val activitySender = sender ?: return WalletResult.Failure(
            WalletError.OperationFailed("wallet manager is not attached to an activity")
        )
        session.update(WalletSession.State.CONNECTING)
        val result = runCatching {
            adapter.transact(activitySender) { auth: AuthorizationResult ->
                adopt(auth)
                WalletAccount(auth.accounts[0].publicKey, auth.accounts[0].accountLabel)
            }.asWalletResult()
        }.getOrElse { WalletResult.Failure(it.toWalletError()) }
        return when (result) {
            is WalletResult.Success -> {
                session.update(WalletSession.State.CONNECTED, result.value)
                pushEvent(NativeBridge.EVENT_CONNECTED, connected = true, account = result.value)
                result
            }
            is WalletResult.Failure -> {
                session.update(WalletSession.State.ERROR, message = result.error.userMessage)
                pushEvent(NativeBridge.EVENT_ERROR, connected = false, message = result.error.userMessage)
                result
            }
        }
    }

    /**
     * Ask the wallet to sign a challenge produced by the reward backend
     * (see docs/WALLET_AUTH.md). The raw challenge and the signature never
     * reach the native game code.
     */
    suspend fun signChallenge(challenge: ByteArray): WalletResult<SignedChallenge> = mutex.withLock {
        val activitySender = sender ?: return WalletResult.Failure(
            WalletError.OperationFailed("wallet manager is not attached to an activity")
        )
        val result = runCatching {
            adapter.transact(activitySender) { auth: AuthorizationResult ->
                adopt(auth)
                val account = WalletAccount(auth.accounts[0].publicKey, auth.accounts[0].accountLabel)
                val signed = signMessages(arrayOf(challenge), arrayOf(account.publicKey))
                SignedChallenge(challenge, signed.signedPayloads[0], account)
            }.asWalletResult()
        }.getOrElse { WalletResult.Failure(it.toWalletError()) }
        return when (result) {
            is WalletResult.Success -> {
                session.update(WalletSession.State.CONNECTED, result.value.account)
                result
            }
            is WalletResult.Failure -> {
                session.update(WalletSession.State.ERROR, message = result.error.userMessage)
                pushEvent(NativeBridge.EVENT_ERROR, connected = false, message = result.error.userMessage)
                result
            }
        }
    }

    /**
     * Run an economy flow (docs/PLAY_ECONOMY.md, stage 17): build the
     * pay_entry / claim_prize transaction fully on-device with
     * [EconomyTxBuilder] (PDAs, references and Borsh payloads recomputed
     * exactly as backend/src/economy.ts), fetch the config account and a
     * fresh blockhash over public RPC, and let the wallet app sign AND send
     * via signAndSendTransactions. For claims the Merkle proof comes from
     * the backend's public proof route. No keys or seeds touch this object.
     */
    suspend fun runEconomy(requestJson: String): WalletResult<String> = mutex.withLock {
        val activitySender = sender ?: return WalletResult.Failure(
            WalletError.OperationFailed("wallet manager is not attached to an activity")
        )
        val request = runCatching { org.json.JSONObject(requestJson) }.getOrElse {
            return WalletResult.Failure(WalletError.OperationFailed("economy request is not valid JSON"))
        }
        val action = request.optString("action", "")
        val kind = request.optInt("kind", 0)
        val epoch = request.optLong("epoch", 0L)
        val programId = request.optString("programId", "")
        val rpcUrl = request.optString("rpcUrl", "https://api.devnet.solana.com")
        val backendUrl = request.optString("backendUrl", "")
        if (programId.isEmpty()) {
            return WalletResult.Failure(WalletError.OperationFailed("economy program id is not configured"))
        }
        val programIdBytes = runCatching { EconomyTxBuilder.base58Decode(programId) }.getOrElse {
            return WalletResult.Failure(WalletError.OperationFailed("economy program id is not valid base58"))
        }
        val result = runCatching {
            adapter.transact(activitySender) { auth: AuthorizationResult ->
                adopt(auth)
                val account = auth.accounts[0]
                val player = account.publicKey
                val configData = rpc(rpcUrl, "getAccountInfo", org.json.JSONArray().apply {
                    put(EconomyTxBuilder.base58Encode(EconomyTxBuilder.configAddress(programIdBytes)))
                    put(org.json.JSONObject().put("encoding", "base64"))
                })
                val configAccount = configData.getJSONObject("value")
                require(configAccount.getString("owner") == programId && !configAccount.getBoolean("executable")) { "invalid economy config owner" }
                require(configAccount.getJSONArray("data").getString(1) == "base64") { "invalid account encoding" }
                val config = EconomyTxBuilder.parseConfig(
                    android.util.Base64.decode(
                        configData.getJSONObject("value").getJSONArray("data").getString(0),
                        android.util.Base64.DEFAULT,
                    ),
                )
                require(!config.paused) { "economy program is paused" }
                val blockhash = EconomyTxBuilder.base58Decode(
                    rpc(rpcUrl, "getLatestBlockhash", org.json.JSONArray())
                        .getJSONObject("value").getString("blockhash"),
                )
                val resolvedEpoch = if (epoch > 0) epoch else httpGetJson("$backendUrl/v1/economy/current-epoch").getLong("epoch")
                val message = when (action) {
                    "pay_entry" -> EconomyTxBuilder.buildPayEntryMessage(
                        player, config, programIdBytes,
                        EconomyTxBuilder.entryReference(kind, resolvedEpoch, player), kind, blockhash,
                    )
                    "claim" -> {
                        require(backendUrl.isNotEmpty()) { "backend url is not configured" }
                        val proofJson = httpGetJson(
                            "$backendUrl/v1/economy/proof?epoch=$resolvedEpoch" +
                                "&wallet=${EconomyTxBuilder.base58Encode(player)}",
                        )
                        val proof = mutableListOf<ByteArray>()
                        val arr = proofJson.getJSONArray("proof")
                        for (i in 0 until arr.length()) proof.add(EconomyTxBuilder.hexToBytes(arr.getString(i)))
                        EconomyTxBuilder.buildClaimPrizeMessage(
                            player, config, programIdBytes, resolvedEpoch,
                            proofJson.getLong("amountMicro"), proofJson.getInt("leafIndex"), proof, blockhash,
                        )
                    }
                    else -> throw IllegalArgumentException("unknown economy action: $action")
                }
                // clientlib-ktx 2.x: one argument (transactions); signatures come
                // back as raw bytes, base58-encoded for transport and audit.
                val sent = signAndSendTransactions(arrayOf(EconomyTxBuilder.unsignedTransaction(message)))
                val walletSignature = sent.signatures.firstOrNull()
                    ?: throw IllegalStateException("wallet returned no transaction signature")
                EconomyTxBuilder.base58Encode(walletSignature)
            }.asWalletResult()
        }.getOrElse { WalletResult.Failure(it.toWalletError()) }
        return when (result) {
            is WalletResult.Success -> {
                pushEvent(NativeBridge.EVENT_ECONOMY, connected = true, message = "economy transaction sent")
                result
            }
            is WalletResult.Failure -> {
                session.update(WalletSession.State.ERROR, message = result.error.userMessage)
                pushEvent(NativeBridge.EVENT_ECONOMY, connected = false, message = result.error.userMessage)
                result
            }
        }
    }

    /**
     * Run a rewards claim (docs/DEVNET_RUNBOOK.md §7). The game fetched a
     * claim intent over its own authenticated backend channel and passes the
     * chain-relevant fields — no session token crosses JNI:
     * {"programId","rpcUrl","epoch","amountMicro","leafIndex","proof":[hex]}.
     *
     * Reads the rewards config + epoch over public RPC, replays every
     * on-chain precondition client-side (RewardsTxBuilder.verifyClaim),
     * best-effort checks the claim record does not exist yet (the program's
     * `init` is the real no-double-claim guard), and lets the wallet app
     * sign AND send via signAndSendTransactions. Returns the base58
     * transaction signature so the game can post claim-confirmation.
     */
    suspend fun runRewardsClaim(requestJson: String): WalletResult<String> = mutex.withLock {
        val activitySender = sender ?: return WalletResult.Failure(
            WalletError.OperationFailed("wallet manager is not attached to an activity")
        )
        val request = runCatching { org.json.JSONObject(requestJson) }.getOrElse {
            return WalletResult.Failure(WalletError.OperationFailed("rewards claim request is not valid JSON"))
        }
        val programId = request.optString("programId", "")
        val rpcUrl = request.optString("rpcUrl", "https://api.devnet.solana.com")
        val epoch = request.optLong("epoch", -1L)
        val amountMicro = request.optLong("amountMicro", 0L)
        val leafIndex = request.optInt("leafIndex", -1)
        if (programId.isEmpty()) {
            return WalletResult.Failure(WalletError.OperationFailed("rewards program id is not configured"))
        }
        val programIdBytes = runCatching { EconomyTxBuilder.base58Decode(programId) }.getOrElse {
            return WalletResult.Failure(WalletError.OperationFailed("rewards program id is not valid base58"))
        }
        if (programIdBytes.size != 32) {
            return WalletResult.Failure(WalletError.OperationFailed("rewards program id must be 32 bytes"))
        }
        if (epoch < 0 || amountMicro <= 0 || leafIndex < 0) {
            return WalletResult.Failure(WalletError.OperationFailed("claim epoch/amount/index are invalid"))
        }
        val proofJson = request.optJSONArray("proof")
            ?: return WalletResult.Failure(WalletError.OperationFailed("claim proof is missing"))
        val result = runCatching {
            adapter.transact(activitySender) { auth: AuthorizationResult ->
                adopt(auth)
                val player = auth.accounts[0].publicKey
                require(player.size == 32) { "wallet account is not a 32-byte public key" }
                val proof = mutableListOf<ByteArray>()
                for (i in 0 until proofJson.length()) proof.add(EconomyTxBuilder.hexToBytes(proofJson.getString(i)))
                val configData = rpc(rpcUrl, "getAccountInfo", org.json.JSONArray().apply {
                    put(EconomyTxBuilder.base58Encode(RewardsTxBuilder.configAddress(programIdBytes)))
                    put(org.json.JSONObject().put("encoding", "base64"))
                })
                require(!configData.isNull("value")) { "rewards config account not found" }
                val configAccount = configData.getJSONObject("value")
                require(configAccount.getString("owner") == programId && !configAccount.getBoolean("executable")) { "invalid rewards config owner" }
                require(configAccount.getJSONArray("data").getString(1) == "base64") { "invalid account encoding" }
                val config = RewardsTxBuilder.parseConfig(
                    android.util.Base64.decode(configAccount.getJSONArray("data").getString(0), android.util.Base64.DEFAULT),
                )
                require(!config.paused) { "rewards program is paused" }
                val epochData = rpc(rpcUrl, "getAccountInfo", org.json.JSONArray().apply {
                    put(EconomyTxBuilder.base58Encode(RewardsTxBuilder.epochAddress(epoch, programIdBytes)))
                    put(org.json.JSONObject().put("encoding", "base64"))
                })
                require(!epochData.isNull("value")) { "epoch $epoch is not published on-chain" }
                val epochAccount = epochData.getJSONObject("value")
                require(epochAccount.getString("owner") == programId && !epochAccount.getBoolean("executable")) { "invalid epoch account owner" }
                val epochState = RewardsTxBuilder.parseEpochState(
                    android.util.Base64.decode(epochAccount.getJSONArray("data").getString(0), android.util.Base64.DEFAULT),
                    epoch,
                )
                val claimData = rpc(rpcUrl, "getAccountInfo", org.json.JSONArray().apply {
                    put(EconomyTxBuilder.base58Encode(RewardsTxBuilder.claimAddress(epoch, player, programIdBytes)))
                    put(org.json.JSONObject().put("encoding", "base64"))
                })
                require(claimData.isNull("value")) { "epoch $epoch is already claimed by this wallet" }
                // Full client-side replay of the on-chain preconditions; throws
                // before any blockhash is spent when the claim cannot succeed.
                RewardsTxBuilder.verifyClaim(player, config, epochState, epoch, amountMicro, leafIndex, proof)
                val blockhash = EconomyTxBuilder.base58Decode(
                    rpc(rpcUrl, "getLatestBlockhash", org.json.JSONArray())
                        .getJSONObject("value").getString("blockhash"),
                )
                val message = RewardsTxBuilder.buildClaimMessage(
                    player, config, epochState, programIdBytes, epoch, amountMicro, leafIndex, proof, blockhash,
                )
                val sent = signAndSendTransactions(arrayOf(EconomyTxBuilder.unsignedTransaction(message)))
                val walletSignature = sent.signatures.firstOrNull()
                    ?: throw IllegalStateException("wallet returned no transaction signature")
                EconomyTxBuilder.base58Encode(walletSignature)
            }.asWalletResult()
        }.getOrElse { WalletResult.Failure(it.toWalletError()) }
        return when (result) {
            is WalletResult.Success -> {
                pushEvent(NativeBridge.EVENT_REWARDS_CLAIM, connected = true,
                    transactionSignature = result.value)
                result
            }
            is WalletResult.Failure -> {
                session.update(WalletSession.State.ERROR, message = result.error.userMessage)
                pushEvent(NativeBridge.EVENT_REWARDS_CLAIM, connected = false, message = result.error.userMessage)
                result
            }
        }
    }

    /** Minimal JSON-RPC over public RPC (IO dispatcher, no secrets). */
    private suspend fun rpc(url: String, method: String, params: org.json.JSONArray): org.json.JSONObject =
        withContext(kotlinx.coroutines.Dispatchers.IO) {
            val body = org.json.JSONObject()
                .put("jsonrpc", "2.0").put("id", 1).put("method", method).put("params", params)
            val connection = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 10_000
                setRequestProperty("content-type", "application/json")
                doOutput = true
            }
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            val text = connection.inputStream.bufferedReader().use { it.readText() }
            val json = org.json.JSONObject(text)
            if (json.has("error")) throw java.io.IOException("rpc error: ${json.getJSONObject("error")}")
            json.getJSONObject("result")
        }

    private suspend fun httpGetJson(url: String): org.json.JSONObject =
        withContext(kotlinx.coroutines.Dispatchers.IO) {
            val connection = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout = 10_000
            }
            org.json.JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        }

    /** Deauthorize and forget the session. Safe to call when not connected. */
    suspend fun disconnect(): WalletResult<Unit> = mutex.withLock {
        val activitySender = sender
        if (activitySender == null) {
            session.clear()
            pushEvent(NativeBridge.EVENT_DISCONNECTED, connected = false)
            return WalletResult.Success(Unit)
        }
        val result = runCatching { adapter.disconnect(activitySender).asWalletResult() }
            .getOrElse { WalletResult.Failure(it.toWalletError()) }
        session.clear()
        adapter.authToken = null
        pushEvent(NativeBridge.EVENT_DISCONNECTED, connected = false)
        return result.map { }
    }

    private fun adopt(auth: AuthorizationResult) {
        session.authToken = auth.authToken
        adapter.authToken = auth.authToken
    }

    /** Only sanitized fields cross into native code. */
    private fun pushEvent(
        type: Int,
        connected: Boolean,
        account: WalletAccount? = null,
        message: String? = null,
        transactionSignature: String? = null,
    ) {
        NativeBridge.pushWalletEvent(
            type,
            WalletEventJson.build(
                connected = connected,
                accountLabel = account?.label,
                publicKeyBase64 = account?.publicKeyBase64,
                errorMessage = message,
                transactionSignature = transactionSignature,
            ),
        )
    }

    private fun <T> TransactionResult<T>.asWalletResult(): WalletResult<T> = when (this) {
        is TransactionResult.Success -> WalletResult.Success(payload)
        else -> WalletResult.Failure(
            classify(this) ?: WalletError.OperationFailed("unknown wallet result")
        )
    }

    private fun Throwable.toWalletError(): WalletError = when (this) {
        is WalletError -> this
        is CancellationException -> WalletError.UserCancelled()
        else -> when (val msg = message ?: javaClass.simpleName) {
            "No wallet found" -> WalletError.NoWalletAvailable()
            else -> WalletError.OperationFailed(msg, this)
        }
    }

    internal fun classify(result: TransactionResult<*>): WalletError? = when (result) {
        is TransactionResult.Success -> null
        is TransactionResult.NoWalletFound -> WalletError.NoWalletAvailable()
        is TransactionResult.Failure -> WalletError.OperationFailed(result.message, result.e)
    }
}
