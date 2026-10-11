# AMAN Android app

This directory is the packaging bridge for the existing AMAN web/PWA application. The UI and Netlify backend remain the source of truth; Capacitor packages the same frontend into an Android application.

## Prerequisites

- Android Studio with Android SDK and SDK Platform installed
- Java 17 or newer supported by the installed Android Gradle Plugin
- A Google Play Console developer account for publishing

## Prepare and open Android Studio

From the repository root in PowerShell:

```powershell
$env:AMAN_API_ORIGIN = "https://YOUR-NETLIFY-SITE.netlify.app"
npm.cmd run mobile:prepare
npx cap add android
npm.cmd run mobile:sync
npm.cmd run mobile:open
```

If the `android` directory already exists, do not run `npx cap add android` again; use `npm.cmd run mobile:sync`.

## Build a Play Store bundle

```powershell
$env:AMAN_API_ORIGIN = "https://YOUR-NETLIFY-SITE.netlify.app"
npm.cmd run mobile:build
```

The release bundle will be produced under `android/app/build/outputs/bundle/release/` after a signing configuration is added in Android Studio/Gradle. Never commit the upload keystore or passwords.

## Play Store requirements outside this repository

- Google Play Console developer account
- Unique application ID and store listing
- Signed `.aab` upload key
- Privacy policy URL
- Data safety declaration
- App icon, screenshots, category, content rating, and support email
- A deployed Netlify API origin with `GEMINI_API_KEY` configured

The mobile app contains no provider secret. It calls the configured Netlify Functions origin over HTTPS.
