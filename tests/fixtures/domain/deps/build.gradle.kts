plugins {
    alias(libs.plugins.android.application)
    id("org.jetbrains.kotlin.android")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.room.runtime)
    ksp(libs.androidx.room.compiler)
    kapt("com.google.dagger:hilt-compiler:2.51")
    implementation(platform(libs.compose.bom))
    implementation(project(":data"))
    testImplementation(libs.junit)
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    implementation(libs.bundles.ktor)
}
