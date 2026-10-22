// Lets Android offer iCam as the camera app: the "camera" launch actions plus the photo/video
// capture requests other apps send (ACTION_IMAGE_CAPTURE / ACTION_VIDEO_CAPTURE).
const { withAndroidManifest } = require('expo/config-plugins');

const ACTIONS = [
  'android.media.action.IMAGE_CAPTURE',
  'android.media.action.VIDEO_CAPTURE',
  'android.media.action.STILL_IMAGE_CAMERA',
  'android.media.action.VIDEO_CAMERA',
];

module.exports = function withDefaultCamera(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    const main = app?.activity?.find((a) => (a.$['android:name'] || '').endsWith('.MainActivity'));
    if (!main) return cfg;
    // A capture request started "for result" must open in the caller's task
    main.$['android:launchMode'] = 'singleTop';
    main['intent-filter'] = main['intent-filter'] || [];
    for (const action of ACTIONS) {
      const exists = main['intent-filter'].some((f) => (f.action || []).some((x) => x.$['android:name'] === action));
      if (!exists) {
        main['intent-filter'].push({
          action: [{ $: { 'android:name': action } }],
          category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
        });
      }
    }
    return cfg;
  });
};
