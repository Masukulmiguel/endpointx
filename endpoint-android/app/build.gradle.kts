import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Signing credentials live in keystore.properties (or env vars) and are never
// committed - see keystore.properties.example.
val releaseProps = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun prop(name: String, env: String): String =
    System.getenv(env) ?: releaseProps.getProperty(name, "")

val storeFilePath = prop("storeFile", "ENDPOINTX_KEYSTORE_FILE")

android {
    namespace = "pt.endpointx.agent"
    compileSdk = 36
    buildToolsVersion = "36.1.0"

    defaultConfig {
        applicationId = "pt.endpointx.agent"
        minSdk = 26
        targetSdk = 34
        versionCode = 3
        versionName = "1.2.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    signingConfigs {
        if (storeFilePath.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(storeFilePath)
                storePassword = prop("storePassword", "ENDPOINTX_KEYSTORE_PASSWORD")
                keyAlias = prop("keyAlias", "ENDPOINTX_KEY_ALIAS")
                keyPassword = prop("keyPassword", "ENDPOINTX_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (storeFilePath.isNotEmpty()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
