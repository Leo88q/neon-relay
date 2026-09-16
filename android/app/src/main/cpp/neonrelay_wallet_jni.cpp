/* JNI shim for the Neon Relay wallet layer.
 *
 * Two directions, one boundary:
 *   Kotlin → native : NativeBridge.pushWalletEvent → neonrelay_wallet_push_event
 *                     (only the sanitized JSON of src/neonrelay/wallet_bridge.h).
 *   native → Kotlin : neonrelay_wallet_platform_request (in-game Wallet page)
 *                     → NativeBridge.requestWalletConnect/requestWalletDisconnect,
 *                     which drive the Mobile Wallet Adapter flow.
 *
 * This is the only path between Kotlin wallet code and native game code; no
 * private key material ever crosses it. Compiled into libneonrelay.so when
 * TARGET_OS is android (see CMakeLists.txt).
 */
#include <jni.h>

#include "wallet_bridge.h"

namespace {
JavaVM *s_pJavaVm = nullptr;

void CallNativeBridgeStaticVoid(const char *pMethod)
{
	if(!s_pJavaVm)
		return;
	JNIEnv *pEnv = nullptr;
	bool attached = false;
	if(s_pJavaVm->GetEnv(reinterpret_cast<void **>(&pEnv), JNI_VERSION_1_6) != JNI_OK)
	{
		if(s_pJavaVm->AttachCurrentThread(&pEnv, nullptr) != JNI_OK)
			return;
		attached = true;
	}
	jclass bridge = pEnv->FindClass("com/leo88q/neonrelay/wallet/NativeBridge");
	if(bridge)
	{
		jmethodID method = pEnv->GetStaticMethodID(bridge, pMethod, "()V");
		if(method)
			pEnv->CallStaticVoidMethod(bridge, method);
		pEnv->DeleteLocalRef(bridge);
	}
	if(pEnv->ExceptionCheck())
		pEnv->ExceptionClear();
	if(attached)
		s_pJavaVm->DetachCurrentThread();
}
} // namespace

/* Cache the JavaVM so the game thread can call into Kotlin later. Only one
 * JNI_OnLoad may exist per shared library; nothing else in the Neon Relay
 * native tree defines one (verified 2026-09). */
extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *pVm, void *pReserved)
{
	(void)pReserved;
	s_pJavaVm = pVm;
	return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT void JNICALL JNI_OnUnload(JavaVM *pVm, void *pReserved)
{
	(void)pVm;
	(void)pReserved;
	s_pJavaVm = nullptr;
}

extern "C" JNIEXPORT void JNICALL
Java_com_leo88q_neonrelay_wallet_NativeBridge_nativePushWalletEvent(
	JNIEnv *env, jclass, jint event_type, jstring json)
{
	const char *chars = nullptr;
	if(json)
		chars = env->GetStringUTFChars(json, nullptr);
	neonrelay_wallet_push_event(event_type, chars);
	if(chars)
		env->ReleaseStringUTFChars(json, chars);
}

/* Implemented in wallet_bridge.h's contract: forward the in-game Wallet page
 * request to the Kotlin layer. */
void neonrelay_wallet_platform_request(int connect)
{
	CallNativeBridgeStaticVoid(connect ? "requestWalletConnect" : "requestWalletDisconnect");
}
