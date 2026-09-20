/* JNI shim for the Neon Relay wallet layer.
 *
 * Two directions, one boundary:
 *   Kotlin → native : NativeBridge.pushWalletEvent → neonrelay_wallet_push_event
 *                     (only the sanitized JSON of src/neonrelay/wallet_bridge.h).
 *   native → Kotlin : neonrelay_wallet_platform_request / _economy /
 *                     _rewards_claim (in-game Wallet page) →
 *                     NativeBridge.requestWalletConnect /
 *                     requestWalletDisconnect / requestEconomy /
 *                     requestRewardsClaim, which drive the Mobile Wallet
 *                     Adapter flow.
 *
 * JNI_OnLoad ownership: the statically linked SDL2 (ddnet-libs, SDL_android.c)
 * already exports JNI_OnLoad for libneonrelay.so, so this shim must NOT define
 * one (duplicate symbol at link time). Instead NativeBridge.warmUp() is called
 * from ClientActivity.onCreate() right after SDLActivity has loaded the native
 * libraries; warmUp runs on a Java thread, which is also the only place where
 * FindClass resolves application classes (native-attached threads would see
 * only the system class loader). The JavaVM and a global ref to the
 * NativeBridge class are cached there and used for all later native→Kotlin
 * calls from game threads.
 *
 * This is the only path between Kotlin wallet code and native game code; no
 * private key material ever crosses it. Compiled into libneonrelay.so when
 * TARGET_OS is android (see CMakeLists.txt).
 */
#include <jni.h>

#include "wallet_bridge.h"

namespace {
JavaVM *s_pJavaVm = nullptr;
jclass s_pBridgeClass = nullptr; // global ref, set from a Java thread only

/* Idempotent; must be called from a Java thread (correct class loader). */
void CacheFromJavaThread(JNIEnv *pEnv)
{
	if(s_pJavaVm)
		return;
	pEnv->GetJavaVM(&s_pJavaVm);
	jclass local = pEnv->FindClass("com/leo88q/neonrelay/wallet/NativeBridge");
	if(local)
	{
		s_pBridgeClass = (jclass)pEnv->NewGlobalRef(local);
		pEnv->DeleteLocalRef(local);
	}
	if(pEnv->ExceptionCheck())
		pEnv->ExceptionClear();
}

/* JNIEnv for the current (game) thread, attaching it to the VM if needed.
 * Returns nullptr until warmUp() has run. Attached threads are intentionally
 * never detached: wallet requests come from long-lived game threads and
 * re-attaching per call costs more than keeping the attachment. */
JNIEnv *AttachWalletEnv()
{
	if(!s_pJavaVm)
		return nullptr;
	JNIEnv *pEnv = nullptr;
	if(s_pJavaVm->GetEnv(reinterpret_cast<void **>(&pEnv), JNI_VERSION_1_6) == JNI_OK)
		return pEnv;
	if(s_pJavaVm->AttachCurrentThread(&pEnv, nullptr) != JNI_OK)
		return nullptr;
	return pEnv;
}

jmethodID BridgeMethod(JNIEnv *pEnv, const char *pName, const char *pSig)
{
	if(!s_pBridgeClass)
		return nullptr;
	jmethodID method = pEnv->GetStaticMethodID(s_pBridgeClass, pName, pSig);
	if(pEnv->ExceptionCheck())
	{
		pEnv->ExceptionClear();
		return nullptr;
	}
	return method;
}

void CallNativeBridgeStaticVoid(const char *pMethod)
{
	JNIEnv *pEnv = AttachWalletEnv();
	if(!pEnv)
		return;
	jmethodID method = BridgeMethod(pEnv, pMethod, "()V");
	if(method)
		pEnv->CallStaticVoidMethod(s_pBridgeClass, method);
	if(pEnv->ExceptionCheck())
		pEnv->ExceptionClear();
}
} // namespace

extern "C" JNIEXPORT void JNICALL
Java_com_leo88q_neonrelay_wallet_NativeBridge_nativeWarmUp(JNIEnv *env, jclass)
{
	CacheFromJavaThread(env);
}

extern "C" JNIEXPORT void JNICALL
Java_com_leo88q_neonrelay_wallet_NativeBridge_nativePushWalletEvent(
	JNIEnv *env, jclass, jint event_type, jstring json)
{
	CacheFromJavaThread(env);
	const char *chars = nullptr;
	if(json)
		chars = env->GetStringUTFChars(json, nullptr);
	neonrelay_wallet_push_event(event_type, chars);
	if(chars)
		env->ReleaseStringUTFChars(json, chars);
}

/* Implemented in wallet_bridge.h's contract: forward the in-game Wallet page
 * economy request (pay_entry / claim) to the Kotlin layer. */
void neonrelay_wallet_platform_economy(const char *json)
{
	JNIEnv *pEnv = AttachWalletEnv();
	if(!pEnv)
		return;
	jmethodID method = BridgeMethod(pEnv, "requestEconomy", "(Ljava/lang/String;)V");
	if(!method)
		return;
	jstring payload = pEnv->NewStringUTF(json ? json : "{}");
	if(payload)
	{
		pEnv->CallStaticVoidMethod(s_pBridgeClass, method, payload);
		pEnv->DeleteLocalRef(payload);
	}
	if(pEnv->ExceptionCheck())
		pEnv->ExceptionClear();
}

/* Implemented in wallet_bridge.h's contract: forward the in-game Wallet page
 * rewards claim request (claim-intent fields as JSON, no session token) to
 * the Kotlin layer. */
void neonrelay_wallet_platform_rewards_claim(const char *json)
{
	JNIEnv *pEnv = AttachWalletEnv();
	if(!pEnv)
		return;
	jmethodID method = BridgeMethod(pEnv, "requestRewardsClaim", "(Ljava/lang/String;)V");
	if(!method)
		return;
	jstring payload = pEnv->NewStringUTF(json ? json : "{}");
	if(payload)
	{
		pEnv->CallStaticVoidMethod(s_pBridgeClass, method, payload);
		pEnv->DeleteLocalRef(payload);
	}
	if(pEnv->ExceptionCheck())
		pEnv->ExceptionClear();
}

void neonrelay_wallet_platform_request(int connect)
{
	CallNativeBridgeStaticVoid(connect ? "requestWalletConnect" : "requestWalletDisconnect");
}
