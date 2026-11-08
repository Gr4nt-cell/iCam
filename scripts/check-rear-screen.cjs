const fs=require('fs'),assert=require('assert/strict');
const plugin=require('../plugins/withRearScreen');
// Exercise the registered manifest mod against an Expo-shaped Android manifest.
const base={name:'iCam',slug:'icam',android:{package:'com.gr4nt.icam'}};
const config=plugin(base);
const main={$:{'android:name':'.MainActivity','android:configChanges':'keyboard|uiMode'}};
const modConfig={...config,modResults:{manifest:{application:[{activity:[main]}]}},modRequest:{}};
(async()=>{
 await config.mods.android.manifest(modConfig);
 assert.equal(main.$['android:launchMode'],'singleTask');
 assert.equal(main.$['android:resizeableActivity'],'true');
 for(const c of ['density','screenSize','smallestScreenSize','keyboard','uiMode'])assert(main.$['android:configChanges'].split('|').includes(c));
 const app=fs.readFileSync('App.tsx','utf8');
 assert(app.includes('recording || busy || processing || countdown > 0'));
 assert(app.includes('if (screens.switching) return;'));
 assert(app.includes('onScreens={() => screens.move(0, !!screens.status?.shizukuGranted)}'));
 const service=fs.readFileSync('modules/icamera/android/src/main/java/expo/modules/icamera/RearDisplayService.kt','utf8');
 assert(service.includes('Binder.getCallingUid()==uid'));
 assert(service.includes('RearDisplayPolicy.ownRootTask'));
 assert(!service.includes('force-stop')&&!service.includes('settings put'));
 const manifest=fs.readFileSync('modules/icamera/android/src/main/AndroidManifest.xml','utf8');
 assert(manifest.includes('android.permission.INTERACT_ACROSS_USERS_FULL'));
 assert(fs.readFileSync('modules/icamera/android/consumer-rules.pro','utf8').includes('RearDisplayService'));
 console.log('PASS: rear-screen manifest, capture guards, return button, private binder and scoped task movement.');
})().catch(e=>{console.error(e);process.exit(1)});
