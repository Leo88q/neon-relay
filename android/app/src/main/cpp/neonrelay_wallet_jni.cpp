/* JNI shim for the Neon Relay wallet layer.
 *
 * This is the *only* path from Kotlin wallet code into native game code, and it
 * carries only the sanitized JSON described in src/neonrelay/wallet_bridge.h.
 * Compiled into libneonrelay.so when TARGET_OS is android (see CMakeLists.txt).
 */
#include <jni.h>

#include "wallet_bridge.h"

// Implemented in Kotlin (com.leo88q.neonrelay.wallet.NativeBridge).
extern "C" JNIEXPORT void JNICALL
Java_com_leo88q_neonrelay_wallet_NativeBridge_nativeRequestWalletConnect(JNIEnv *env, jclass);

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

extern "C" JNIEXPORT void JNICALL
Java_com_leo88q_neonrelay_wallet_NativeBridge_nativeRequestWalletConnect(JNIEnv *env, jclass)
{
	jclass bridge = env->FindClass("com/leo88q/neonrelay/wallet/NativeBridge");
	if(!bridge)
		return;
	jmethodID method = env->GetStaticMethodID(bridge, "requestWalletConnect", "()V");
	if(method)
		env->CallStaticVoidMethod(bridge, method);
}

extern "C" JNIEXPORT void JNICALL
Java_com_leo88q_neonrelay_wallet_NativeBridge_nativeRequestWalletDisconnect(JNIEnv *env, jclass)
{
	jclass bridge = env->FindClass("com/leo88q/neonrelay/wallet/NativeBridge");
	if(!bridge)
		return;
	jmethodID method = env->GetStaticMethodID(bridge, "requestWalletDisconnect", "()V");
	if(method)
		env->CallStaticVoidMethod(bridge, method);
}
