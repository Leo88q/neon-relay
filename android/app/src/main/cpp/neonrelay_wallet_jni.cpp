/* JNI shim for the Neon Relay wallet layer.
 *
 * JNI_OnLoad ownership: the statically linked SDL2 (ddnet-libs, SDL_android.c)
 * already exports JNI_OnLoad for libneonrelay.so, so this shim must NOT define
 * one. NativeBridge.warmUp() is called from ClientActivity.onCreate() right
 * after the native libraries are loaded; warmUp runs on a Java thread, which
 * is the only place where FindClass resolves application classes. The JavaVM
 * and a global ref to NativeBridge are cached there for all later
 * native-to-Kotlin calls from game threads.
 */
#include <jni.h>

#include "wallet_bridge.h"

namespace {
JavaVM *s_pJavaVm = nullptr;
jclass s_pBridgeClass = nullptr;

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

void neonrelay_wallet_platform_request(int connect)
{
	CallNativeBridgeStaticVoid(connect ? "requestWalletConnect" : "requestWalletDisconnect");
}
