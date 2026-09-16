# Keep the JNI entry points of the wallet bridge.
-keepclasseswithmembernames class com.leo88q.neonrelay.wallet.NativeBridge {
    native <methods>;
}
# Mobile Wallet Adapter clientlib uses reflection over its protocol models.
-keep class com.solana.mobilewalletadapter.** { *; }
