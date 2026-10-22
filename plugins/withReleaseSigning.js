// Signs release builds (APK + AAB) with the Play upload key when CI provides it through env vars.
// Without them the build falls back to the debug key (fine for sideloading, not for Play).
const { withAppBuildGradle } = require('expo/config-plugins');

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let g = cfg.modResults.contents;
    if (!g.includes('ICAM_UPLOAD_STORE_FILE')) {
      g = g.replace(
        /signingConfigs\s*\{/,
        `signingConfigs {
        release {
            if (System.getenv("ICAM_UPLOAD_STORE_FILE")) {
                storeFile file(System.getenv("ICAM_UPLOAD_STORE_FILE"))
                storePassword System.getenv("ICAM_UPLOAD_STORE_PASSWORD")
                keyAlias System.getenv("ICAM_UPLOAD_KEY_ALIAS")
                keyPassword System.getenv("ICAM_UPLOAD_KEY_PASSWORD")
            }
        }`,
      );
      // release buildType: use the upload key when present
      g = g.replace(
        /(release\s*\{[^{}]*?)signingConfig\s+signingConfigs\.debug/,
        '$1signingConfig System.getenv("ICAM_UPLOAD_STORE_FILE") ? signingConfigs.release : signingConfigs.debug',
      );
    }
    cfg.modResults.contents = g;
    return cfg;
  });
};
