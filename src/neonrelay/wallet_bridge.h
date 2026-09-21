// Neon Relay wallet event bridge.
//
// The Android wallet layer (android/app/.../wallet/*.kt, Mobile Wallet Adapter)
// talks to wallets and to the reward backend. The C++ game code must never see
// wallet secrets, so only a small, sanitized summary crosses this boundary:
//
//   { "connected": 0|1, "account_label": "<display name>",
//     "public_key_base64": "<base64 of the account public key>",
//     "error_message": "<short, user-safe text>",
//     "transaction_signature": "<base58 tx signature, rewards claims only>" }
//
// Auth tokens, challenge payloads and message signatures are stripped on the
// Kotlin side before `neonrelay_wallet_push_event` is called (see
// android/app/src/main/cpp/neonrelay_wallet_jni.cpp and WalletManager.kt).
// The one exception is transaction_signature: a *transaction* signature is
// public chain data (readable by anyone on Solana), not a secret, and the
// game needs it to post claim confirmations
// (POST /v1/rewards/claim-confirmation). No private key material ever exists
// in this process.
//
#ifndef NEONRELAY_WALLET_BRIDGE_H
#define NEONRELAY_WALLET_BRIDGE_H

#ifdef __cplusplus
extern "C" {
#endif

enum
{
	NEONRELAY_WALLET_EVENT_DISCONNECTED = 0,
	NEONRELAY_WALLET_EVENT_CONNECTED = 1,
	NEONRELAY_WALLET_EVENT_ERROR = 2,
	NEONRELAY_WALLET_EVENT_ECONOMY = 3,
	NEONRELAY_WALLET_EVENT_REWARDS_CLAIM = 4,
};

typedef struct NeonRelayWalletInfo
{
	char account_label[64];
	char public_key_base64[64];
	char error_message[128];
	/* Base58 transaction signature (public chain data), set on
	 * NEONRELAY_WALLET_EVENT_REWARDS_CLAIM when a transaction reached the
	 * wallet: on success, or together with `error_message` when the
	 * transaction failed on-chain. Empty otherwise. */
	char transaction_signature[128];
	int connected;
	/* 1 while a connect/disconnect/rewards-claim request is waiting for the
	 * wallet layer to answer with an event; reset by every pushed event. */
	int requesting;
} NeonRelayWalletInfo;

typedef void (*NeonRelayWalletListener)(int event_type, const NeonRelayWalletInfo *info, void *user);

/* Register the game-side callback (called on the thread that pushes events). */
void neonrelay_wallet_set_listener(NeonRelayWalletListener listener, void *user);

/* Current sanitized wallet state; never NULL. */
const NeonRelayWalletInfo *neonrelay_wallet_info(void);

/* Platform entry point (Android JNI shim). `json` must contain only the four
 * sanitized fields documented above. */
void neonrelay_wallet_push_event(int event_type, const char *json);

/* Ask the platform wallet layer to connect/disconnect (in-game Wallet
 * settings page). Android: forwarded to NativeBridge.kt via JNI. Other
 * platforms: reports a user-safe "Android build only" error event. The result
 * always arrives later through neonrelay_wallet_push_event. */
void neonrelay_wallet_request_connect(void);
void neonrelay_wallet_request_disconnect(void);

/**
 * Ask the platform wallet layer to run an economy flow (pay_entry / claim)
 * described by a sanitized JSON payload: {"action": "pay_entry"|"claim",
 * "kind": 0|1, "epoch": N}. No key material crosses this boundary; the
 * Android layer builds and signs inside Mobile Wallet Adapter (BL-17).
 */
void neonrelay_wallet_request_economy(const char *json);

/**
 * Ask the platform wallet layer to run a rewards claim (DEVNET_RUNBOOK §7)
 * described by operator configuration only: {"programId": "<base58>",
 * "rpcUrl": "<https>", "backendUrl": "<https>"}. The Android layer owns the
 * whole flow — backend session (challenge → wallet signs → verify),
 * sealed-epoch discovery, intent fetch, transaction build + send, finality
 * poll, and the single claim-confirmation — so no session token or key
 * material crosses this boundary. The result arrives as
 * NEONRELAY_WALLET_EVENT_REWARDS_CLAIM with `transaction_signature` set on
 * success (also present when an on-chain failure carries an error message).
 */
void neonrelay_wallet_request_rewards_claim(const char *json);

/** Platform hook implemented per backend (JNI on Android, stub elsewhere). */
void neonrelay_wallet_platform_economy(const char *json);

/** Platform hook implemented per backend (JNI on Android, stub elsewhere). */
void neonrelay_wallet_platform_rewards_claim(const char *json);

/* Implemented per platform: Android in android/app/src/main/cpp/
 * neonrelay_wallet_jni.cpp, other platforms by a stub inside
 * wallet_bridge.cpp. connect: 1 = connect, 0 = disconnect. */
void neonrelay_wallet_platform_request(int connect);

#ifdef __cplusplus
}
#endif

#endif // NEONRELAY_WALLET_BRIDGE_H
