package com.leo88q.neonrelay.wallet

import android.net.Uri
import androidx.activity.ComponentActivity
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import com.solana.mobilewalletadapter.clientlib.Blockchain
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.Solana
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient.AuthorizationResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

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

    /** Rewards-backend auth, in memory only: never persisted, never crosses JNI. */
    private var backendSession: BackendSession? = null

    private data class BackendSession(
        val token: String,
        val expiresAtMs: Long,
        val backendUrl: String,
        val walletB64Url: String,
    )

    private data class ClaimIntent(
        val intentId: String,
        val epoch: Long,
        val amountMicro: Long,
        val leafIndex: Int,
        val proof: List<ByteArray>,
    )

    private data class ClaimOutcome(val signature: String, val finalStatus: String, val confirmed: Boolean)

    private class HttpError(val status: Int, val code: String?, message: String) : java.io.IOException(message)

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
     * Run a rewards claim (docs/DEVNET_RUNBOOK.md §7). The game passes only
     * operator configuration — no auth material crosses JNI:
     * {"programId","rpcUrl","backendUrl"}.
     *
     * Everything else happens here: a backend session (challenge → wallet
     * signs → verify, cached in memory with a 60s expiry skew),
     * sealed-epoch discovery over the public epochs list (recent first, at
     * most 8 intent attempts, skipping epochs with no rewards for this
     * wallet), rewards config + epoch reads over public RPC, a full
     * client-side replay of the on-chain preconditions
     * (RewardsTxBuilder.verifyClaim), a best-effort already-claimed check
     * (the program's `init` is the real no-double-claim guard), wallet sign
     * AND send via signAndSendTransactions, a ≤30s finality poll, and ONE
     * claim-confirmation reporting the observed outcome (confirmed/failed,
     * or submitted when finality times out). Returns the base58 transaction
     * signature.
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
        val backendUrl = request.optString("backendUrl", "")
        if (programId.isEmpty()) {
            return WalletResult.Failure(WalletError.OperationFailed("rewards program id is not configured"))
        }
        val programIdBytes = runCatching { EconomyTxBuilder.base58Decode(programId) }.getOrElse {
            return WalletResult.Failure(WalletError.OperationFailed("rewards program id is not valid base58"))
        }
        if (programIdBytes.size != 32) {
            return WalletResult.Failure(WalletError.OperationFailed("rewards program id must be 32 bytes"))
        }
        if (backendUrl.isEmpty()) {
            return WalletResult.Failure(WalletError.OperationFailed("backend url is not configured"))
        }
        val result = runCatching {
            adapter.transact(activitySender) { auth: AuthorizationResult ->
                adopt(auth)
                val player = auth.accounts[0].publicKey
                require(player.size == 32) { "wallet account is not a 32-byte public key" }
                val backend = ensureBackendSession(backendUrl, player, auth.accounts[0].accountLabel)
                val intent = findClaimableIntent(backendUrl, backend)
                val config = fetchRewardsConfig(rpcUrl, programId, programIdBytes)
                val epochState = fetchEpochState(rpcUrl, programId, programIdBytes, intent.epoch)
                val claimData = rpc(rpcUrl, "getAccountInfo", org.json.JSONArray().apply {
                    put(EconomyTxBuilder.base58Encode(RewardsTxBuilder.claimAddress(intent.epoch, player, programIdBytes)))
                    put(org.json.JSONObject().put("encoding", "base64"))
                })
                require(claimData.isNull("value")) { "epoch ${intent.epoch} is already claimed by this wallet" }
                // Full client-side replay of the on-chain preconditions; throws
                // before any blockhash is spent when the claim cannot succeed.
                RewardsTxBuilder.verifyClaim(player, config, epochState, intent.epoch, intent.amountMicro, intent.leafIndex, intent.proof)
                val blockhash = EconomyTxBuilder.base58Decode(
                    rpc(rpcUrl, "getLatestBlockhash", org.json.JSONArray())
                        .getJSONObject("value").getString("blockhash"),
                )
                val message = RewardsTxBuilder.buildClaimMessage(
                    player, config, epochState, programIdBytes, intent.epoch, intent.amountMicro, intent.leafIndex, intent.proof, blockhash,
                )
                val sent = signAndSendTransactions(arrayOf(EconomyTxBuilder.unsignedTransaction(message)))
                val walletSignature = sent.signatures.firstOrNull()
                    ?: throw IllegalStateException("wallet returned no transaction signature")
                val signature = EconomyTxBuilder.base58Encode(walletSignature)
                val finalStatus = awaitFinality(rpcUrl, signature)
                val confirmed = confirmClaim(backendUrl, backend, intent.intentId, signature, finalStatus)
                ClaimOutcome(signature, finalStatus, confirmed)
            }.asWalletResult()
        }.getOrElse { WalletResult.Failure(it.toWalletError()) }
        return when (result) {
            is WalletResult.Success -> {
                val outcome = result.value
                if (outcome.finalStatus == "failed") {
                    // The chain is authoritative: the backend already recorded
                    // the failure, the user gets an error with the signature.
                    val message = "claim transaction failed on-chain"
                    session.update(WalletSession.State.ERROR, message = message)
                    pushEvent(NativeBridge.EVENT_REWARDS_CLAIM, connected = false,
                        message = message, transactionSignature = outcome.signature)
                    WalletResult.Failure(WalletError.OperationFailed(message))
                } else {
                    val warning = if (!outcome.confirmed)
                        "claim sent, but the confirmation receipt failed; the transaction is on-chain"
                    else null
                    pushEvent(NativeBridge.EVENT_REWARDS_CLAIM, connected = true,
                        message = warning, transactionSignature = outcome.signature)
                    WalletResult.Success(outcome.signature)
                }
            }
            is WalletResult.Failure -> {
                session.update(WalletSession.State.ERROR, message = result.error.userMessage)
                pushEvent(NativeBridge.EVENT_REWARDS_CLAIM, connected = false, message = result.error.userMessage)
                result
            }
        }
    }

    /**
     * Backend session for the rewards API (docs/WALLET_AUTH.md). The wallet
     * signs the canonical challenge exactly like [signChallenge]; the token
     * stays in memory, is reused across claims for the same wallet + backend
     * while more than 60s from expiry, and never crosses JNI.
     */
    private suspend fun AdapterOperations.ensureBackendSession(
        backendUrl: String,
        player: ByteArray,
        label: String?,
    ): BackendSession {
        val b64url = android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING
        val walletB64 = android.util.Base64.encodeToString(player, b64url)
        val cached = backendSession
        if (cached != null && cached.backendUrl == backendUrl && cached.walletB64Url == walletB64 &&
            System.currentTimeMillis() < cached.expiresAtMs - 60_000
        ) return cached
        val challenge = httpPostJson("$backendUrl/v1/auth/challenge", org.json.JSONObject()).getString("challenge")
        val signed = signMessages(
            arrayOf(android.util.Base64.decode(challenge, android.util.Base64.URL_SAFE)),
            arrayOf(player),
        )
        val verifyBody = org.json.JSONObject()
            .put("challenge", challenge)
            .put("signature", android.util.Base64.encodeToString(signed.signedPayloads[0], b64url))
            .put("public_key", walletB64)
        if (label != null) verifyBody.put("account_label", label)
        val verified = httpPostJson("$backendUrl/v1/auth/verify-wallet", verifyBody)
        val fresh = BackendSession(
            token = verified.getString("session_token"),
            expiresAtMs = parseIso8601Ms(verified.getString("session_expires_at")),
            backendUrl = backendUrl,
            walletB64Url = walletB64,
        )
        backendSession = fresh
        return fresh
    }

    /** Parses backend `toISOString()` timestamps; unparseable means expired (fail closed). */
    private fun parseIso8601Ms(value: String): Long = runCatching {
        val format = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
        format.timeZone = java.util.TimeZone.getTimeZone("UTC")
        format.parse(value)?.time ?: 0L
    }.getOrElse { 0L }

    /**
     * Recent-first scan of the public sealed-epoch list (at most 8 intent
     * attempts) for an epoch with claimable rewards for this wallet.
     */
    private suspend fun findClaimableIntent(backendUrl: String, backend: BackendSession): ClaimIntent {
        val epochs = httpGetJsonArray("$backendUrl/v1/rewards/epochs")
        var tried = 0
        for (i in 0 until epochs.length()) {
            if (tried >= 8) break
            val row = epochs.optJSONObject(i) ?: continue
            if (row.optString("state", "") != "sealed") continue
            val id = row.optLong("id", -1L)
            if (id < 0) continue
            tried++
            try {
                val intent = httpPostJson(
                    "$backendUrl/v1/rewards/claim-intent",
                    org.json.JSONObject().put("epoch_id", id),
                    backend.token,
                )
                val proof = mutableListOf<ByteArray>()
                val proofJson = intent.getJSONArray("merkle_proof")
                for (j in 0 until proofJson.length()) proof.add(EconomyTxBuilder.hexToBytes(proofJson.getString(j)))
                return ClaimIntent(
                    intentId = intent.getString("intent_id"),
                    epoch = id,
                    amountMicro = intent.getLong("amount_micro"),
                    leafIndex = intent.getInt("leaf_index"),
                    proof = proof,
                )
            } catch (e: HttpError) {
                // No allocation for this wallet in this epoch (or a sealed
                // race) — keep scanning. Anything else aborts the claim.
                if (e.code == "no-rewards-in-epoch" || e.code == "epoch-not-found" || e.code == "epoch-not-sealed") continue
                if (e.status == 401) backendSession = null
                throw e
            }
        }
        error("no claimable rewards in recent sealed epochs")
    }

    private suspend fun fetchRewardsConfig(
        rpcUrl: String,
        programId: String,
        programIdBytes: ByteArray,
    ): RewardsTxBuilder.RewardsConfig {
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
        return config
    }

    private suspend fun fetchEpochState(
        rpcUrl: String,
        programId: String,
        programIdBytes: ByteArray,
        epoch: Long,
    ): RewardsTxBuilder.RewardsEpoch {
        val epochData = rpc(rpcUrl, "getAccountInfo", org.json.JSONArray().apply {
            put(EconomyTxBuilder.base58Encode(RewardsTxBuilder.epochAddress(epoch, programIdBytes)))
            put(org.json.JSONObject().put("encoding", "base64"))
        })
        require(!epochData.isNull("value")) { "epoch $epoch is not published on-chain" }
        val epochAccount = epochData.getJSONObject("value")
        require(epochAccount.getString("owner") == programId && !epochAccount.getBoolean("executable")) { "invalid epoch account owner" }
        return RewardsTxBuilder.parseEpochState(
            android.util.Base64.decode(epochAccount.getJSONArray("data").getString(0), android.util.Base64.DEFAULT),
            epoch,
        )
    }

    /**
     * Polls getSignatureStatuses for at most 30s. Returns "confirmed" /
     * "failed"; a timeout means the wallet sent it but finality is unknown,
     * reported as "submitted" so the backend watches it instead of the claim
     * being recorded failed.
     */
    private suspend fun awaitFinality(rpcUrl: String, signature: String): String =
        withTimeoutOrNull<String>(30_000) {
            while (true) {
                val statuses = rpc(
                    rpcUrl, "getSignatureStatuses",
                    org.json.JSONArray().put(org.json.JSONArray().put(signature)),
                ).optJSONArray("value")
                val first = if (statuses != null && statuses.length() > 0 && !statuses.isNull(0)) statuses.getJSONObject(0) else null
                if (first != null) {
                    if (!first.isNull("err")) return@withTimeoutOrNull "failed"
                    when (first.optString("confirmationStatus", "")) {
                        "confirmed", "finalized" -> return@withTimeoutOrNull "confirmed"
                    }
                }
                delay(2_000)
            }
        } ?: "submitted"

    /**
     * Reports the observed outcome exactly once per claim intent (the only
     * exception is a transport failure, retried twice — the route stays
     * idempotent until the intent is confirmed, so a duplicate is harmless).
     * Returns false only when the receipt could not be delivered at all; the
     * on-chain transaction is unaffected either way.
     */
    private suspend fun confirmClaim(
        backendUrl: String,
        backend: BackendSession,
        intentId: String,
        signature: String,
        status: String,
    ): Boolean {
        repeat(3) { attempt ->
            try {
                httpPostJson(
                    "$backendUrl/v1/rewards/claim-confirmation",
                    org.json.JSONObject()
                        .put("intent_id", intentId)
                        .put("transaction_id", signature)
                        .put("status", status),
                    backend.token,
                )
                return true
            } catch (e: CancellationException) {
                throw e
            } catch (e: HttpError) {
                // Already recorded (e.g. a retried request that did land).
                if (e.code == "intent-already-confirmed") return true
                if (attempt == 2) return false
            } catch (e: Exception) {
                if (attempt == 2) return false
            }
            delay(1_000)
        }
        return false
    }

    private suspend fun httpPostJson(url: String, body: org.json.JSONObject, bearer: String? = null): org.json.JSONObject =
        withContext(kotlinx.coroutines.Dispatchers.IO) {
            val connection = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 10_000
                setRequestProperty("content-type", "application/json")
                if (bearer != null) setRequestProperty("authorization", "Bearer $bearer")
                doOutput = true
            }
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = runCatching { org.json.JSONObject(text) }.getOrNull()
            if (status !in 200..299) {
                val code = json?.optJSONObject("error")?.optString("code", null)
                throw HttpError(status, code, "rewards backend error${code?.let { ": $it" } ?: ""} (http $status)")
            }
            json ?: throw java.io.IOException("rewards backend returned invalid JSON")
        }

    private suspend fun httpGetJsonArray(url: String): org.json.JSONArray =
        withContext(kotlinx.coroutines.Dispatchers.IO) {
            val connection = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout = 10_000
            }
            val status = connection.responseCode
            if (status !in 200..299) throw java.io.IOException("rewards backend error (http $status)")
            org.json.JSONArray(connection.inputStream.bufferedReader().use { it.readText() })
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
            backendSession = null
            pushEvent(NativeBridge.EVENT_DISCONNECTED, connected = false)
            return WalletResult.Success(Unit)
        }
        val result = runCatching { adapter.disconnect(activitySender).asWalletResult() }
            .getOrElse { WalletResult.Failure(it.toWalletError()) }
        session.clear()
        backendSession = null
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
