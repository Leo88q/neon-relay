/* Neon Relay wallet event bridge.
 *
 * The Android wallet layer (android/app/.../wallet/*.kt, Mobile Wallet Adapter)
 * talks to wallets and to the reward backend. The C++ game code must never see
 * wallet secrets, so only a small, sanitized summary crosses this boundary:
 *
 *   { "connected": 0|1, "account_label": "<display name>",
 *     "public_key_base64": "<base64 of the account public key>",
 *     "error_message": "<short, user-safe text>" }
 *
 * Auth tokens, signatures, challenge payloads and anything else the wallet
 * returns are stripped on the Kotlin side before `neonrelay_wallet_push_event`
 * is called (see android/app/src/main/cpp/neonrelay_wallet_jni.cpp and
 * WalletManager.kt). No private key material ever exists in this process.
 */
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
};

typedef struct NeonRelayWalletInfo
{
	char account_label[64];
	char public_key_base64[64];
	char error_message[128];
	int connected;
} NeonRelayWalletInfo;

typedef void (*NeonRelayWalletListener)(int event_type, const NeonRelayWalletInfo *info, void *user);

/* Register the game-side callback (called on the thread that pushes events). */
void neonrelay_wallet_set_listener(NeonRelayWalletListener listener, void *user);

/* Current sanitized wallet state; never NULL. */
const NeonRelayWalletInfo *neonrelay_wallet_info(void);

/* Platform entry point (Android JNI shim). `json` must contain only the four
 * sanitized fields documented above. */
void neonrelay_wallet_push_event(int event_type, const char *json);

#ifdef __cplusplus
}
#endif

#endif // NEONRELAY_WALLET_BRIDGE_H
