import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Version coordinates come from the CMake-side version file when present so the
// APK and the native build always agree.
val versionProps = Properties().apply {
    val f = rootProject.file("version.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.leo88q.neonrelay"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.leo88q.neonrelay"
        minSdk = 24
        targetSdk = 36
        versionCode = (versionProps.getProperty("versionCode") ?: "1").toInt()
        versionName = versionProps.getProperty("versionName") ?: "0.1.0"

        ndk {
            abiFilters += listOf("arm64-v8a")
        }

        // Identity shown by wallets during authorization. `.example` is a
        // reserved TLD: replace with the production domain before release.
        buildConfigField("String", "WALLET_IDENTITY_URI", "\"https://neonrelay.leo88q.example/\"")
        // Reward ledger cluster. devnet by default; mainnet is only ever set by
        // an explicit release configuration, never in source.
        buildConfigField("String", "REWARD_CLUSTER", "\"devnet\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            isDebuggable = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    kotlinOptions {
        jvmTarget = "21"
    }

    packaging {
        jniLibs.useLegacyPackaging = true
        doNotStrip("**/*.so")
    }

    sourceSets {
        getByName("main") {
            // Native libraries are produced by scripts/android/cmake_android.sh
            // (libneonrelay.so, libneonrelay-server.so) and dropped in here.
            jniLibs.srcDirs("src/main/jniLibs")
            // the SDL game activity and the local server service (upstream
            // template, rebranded) plus the SDL Java bindings from ddnet-libs
            java.srcDir("../../scripts/android/files/java")
            java.srcDir("../../ddnet-libs/sdl/java")
            res.srcDir("../../scripts/android/files/res")
            // generated launcher icons (see copyLauncherIcons below)
            res.srcDir(layout.buildDirectory.dir("generated/res"))
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

// Launcher icons are generated from the brand artwork instead of being
// committed twice; see scripts/build_brand_assets.py.
val copyLauncherIcons by tasks.registering(Copy::class) {
    from("../../other/icons/NeonRelay_256x256x32.png")
    into(layout.buildDirectory.dir("generated/res/mipmap"))
    rename { "ic_launcher.png" }
}
val copyLauncherIconsRound by tasks.registering(Copy::class) {
    from("../../other/icons/NeonRelay_256x256x32.png")
    into(layout.buildDirectory.dir("generated/res/mipmap"))
    rename { "ic_launcher_round.png" }
}
tasks.named("preBuild") {
    dependsOn(copyLauncherIcons, copyLauncherIconsRound)
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation(libs.mobilewalletadapter.clientlib)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.security.crypto)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
